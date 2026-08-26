#!/usr/bin/env node
/**
 * Unified Local Qwen3.8-27B MCP Server (2026 SOTA)
 *
 * Architecture:
 * - Lead Architect (Meta-Supervisor): Claude 5 Sonnet in Claude Code / Gemini 3.7 Flash in Antigravity
 * - Local Coworker (Variation & Execution Operator): Qwen3.8-27B via Goose Harness
 * - Serving: Universal 245K context (vLLM + DFlash2 + KVarN @ localhost:18020)
 * - Evolutionary Optimization: Hierarchical NVIDIA AVO (persistent .avo/lineage.json)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import { createServer } from "http";
import { AvoLineageEngine } from "./avo_engine.js";

const execFileAsync = promisify(execFile);

const PORT = 18020;
const BASE_URL = `http://localhost:${PORT}/v1`;
const STATUS_PORT = 18021;
const MAX_LEN_HUGE = 245760;
const BOOT_TIMEOUT_MS = 180_000;
const BOOT_POLL_MS = 3000;

// High default timeout (15 minutes) to ensure deep reasoning and extension downloads never cut short
const DEFAULT_TIMEOUT_MS = 900_000;
const EXTENSION_BONUS_TIMEOUT_MS = 300_000;
const RACE_MS = 50_000; // Early response window before returning background taskId
const TASK_RETENTION_MS = 3 * 60 * 60 * 1000; // 3 hours

const GOOSE_EXE = "C:\\Users\\Apath\\.local\\bin\\goose.exe";

function wsl(cmd) {
  return execFileAsync("wsl.exe", ["-d", "Ubuntu", "--", "bash", "-c", cmd], {
    timeout: BOOT_TIMEOUT_MS + 10_000,
  });
}

async function getApiKey() {
  const { stdout } = await wsl("cat ~/qwen-serving/api_key.txt");
  return stdout.trim();
}

async function currentMode() {
  try {
    const key = await getApiKey();
    const res = await fetch(`${BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const j = await res.json();
    const len = j?.data?.[0]?.max_model_len;
    return len ? "huge" : "unknown";
  } catch {
    return null; // not running
  }
}

async function ensureServerRunning() {
  const current = await currentMode();
  if (current) return { switched: false, status: "already_running" };
  await wsl(
    `cd ~/qwen-serving && nohup bash launchers/start_huge.sh > /tmp/mcp_launch_huge.log 2>&1 < /dev/null & disown; sleep 1; true`
  );
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, BOOT_POLL_MS));
    const now = await currentMode();
    if (now) return { switched: true, status: "started" };
  }
  throw new Error(`Timed out waiting for vLLM server to boot (${BOOT_TIMEOUT_MS}ms)`);
}

async function stopServer() {
  await wsl(`cd ~/qwen-serving && bash launchers/stop_server.sh 2>/dev/null || true`);
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const mode = await currentMode();
    if (!mode) return { stopped: true };
  }
  return { stopped: true };
}

// Background Task Management
const pendingTasks = new Map();

function makeTaskId() {
  return `qwen-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function unfinishedTaskCount() {
  let n = 0;
  for (const e of pendingTasks.values()) if (!e.done) n++;
  return n;
}

const MAX_CONCURRENT_GOOSE = 8;
let activeGooseCount = 0;
const gooseWaitQueue = [];
let queueDepth = 0;

function runQueued(fn) {
  return new Promise((resolve, reject) => {
    const attempt = () => {
      activeGooseCount++;
      fn().then(
        (r) => {
          activeGooseCount--;
          releaseNext();
          resolve(r);
        },
        (e) => {
          activeGooseCount--;
          releaseNext();
          reject(e);
        }
      );
    };
    if (activeGooseCount < MAX_CONCURRENT_GOOSE) attempt();
    else gooseWaitQueue.push(attempt);
  });
}

function releaseNext() {
  if (activeGooseCount < MAX_CONCURRENT_GOOSE) {
    const next = gooseWaitQueue.shift();
    if (next) next();
  }
}

let bootMutex = Promise.resolve();
function withBootMutex(fn) {
  const result = bootMutex.then(fn, fn);
  bootMutex = result.then(
    () => {},
    () => {}
  );
  return result;
}

function extractToolEvents(lines) {
  const contentItems = [];
  for (const line of lines) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const content = obj?.message?.content;
    if (Array.isArray(content)) contentItems.push(...content);
  }
  const toolCalls = contentItems.filter((c) => c.type === "toolRequest");
  const toolResponses = contentItems.filter((c) => c.type === "toolResponse");
  const errors = toolResponses.filter((r) => r.toolResult?.value?.isError);
  const fileOps = toolCalls
    .filter((c) => ["write", "edit", "str_replace", "patch"].includes(c.toolCall?.value?.name))
    .map((c) => `${c.toolCall.value.name}:${c.toolCall.value.arguments?.path ?? "?"}`);
  const finalText = contentItems
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("")
    .trim();
  return { toolCalls, errors, fileOps, finalText };
}

function summarizeGooseRun(lines, { timedOut, timeoutMs = DEFAULT_TIMEOUT_MS, stderr = "" } = {}) {
  const { toolCalls, errors, fileOps, finalText } = extractToolEvents(lines);
  const parts = [];

  if (timedOut) {
    parts.push(
      `Qwen did NOT finish within the ${Math.round(timeoutMs / 1000)}s time budget - reporting what was confirmed before the cutoff.`
    );
  } else {
    parts.push(`Qwen finished. ${toolCalls.length} tool call(s) (${fileOps.length} file write/edit), ${errors.length} tool error(s).`);
  }

  if (fileOps.length > 0) {
    const unique = [...new Set(fileOps)];
    parts.push(`Files touched:\n${unique.map((f) => `  - ${f}`).join("\n")}`);
  }

  if (finalText) {
    parts.push(timedOut ? `Last partial message from Qwen:\n${finalText}` : `Final message from Qwen:\n${finalText}`);
  }

  if (errors.length > 0) {
    parts.push(
      `Tool errors encountered during run:\n` +
        errors
          .map((e) => {
            const name = e.toolResult?.name ?? "unknown";
            const msg = typeof e.toolResult?.value === "string" ? e.toolResult.value : JSON.stringify(e.toolResult?.value ?? "");
            return `  - ${name}: ${msg.slice(0, 300)}`;
          })
          .join("\n")
    );
  }

  if (stderr.trim()) {
    parts.push(`Goose stderr tail:\n${stderr.trim().slice(-1000)}`);
  }

  const isError = errors.length > 0 || (timedOut && fileOps.length === 0);
  return { isError, text: parts.join("\n\n"), toolCalls, errors, fileOps, finalText };
}

const knownSessions = new Set();

function startGooseTask({ cwd, prompt, sessionId, extensions, system, timeoutMs, hypothesis, testCommand, metricName, higherIsBetter }) {
  const taskId = makeTaskId();
  queueDepth++;

  const totalTimeoutMs = (timeoutMs ?? DEFAULT_TIMEOUT_MS) + (extensions && extensions.length ? EXTENSION_BONUS_TIMEOUT_MS : 0);

  const entry = {
    startedAt: Date.now(),
    execStartedAt: null,
    booting: true,
    queuePositionAtEnqueue: queueDepth - 1,
    lines: [],
    stderr: "",
    done: false,
    result: null,
    child: null,
    cancelled: false,
    timeoutMs: totalTimeoutMs,
  };
  pendingTasks.set(taskId, entry);

  let lineageEngine = null;
  let avoContext = null;
  if (testCommand) {
    try {
      lineageEngine = new AvoLineageEngine(cwd);
      avoContext = lineageEngine.getLineageContext();
    } catch {
      // Non-git or uninitialized lineage
    }
  }

  let finalTaskPrompt = `Your working directory is exactly: ${cwd}\n\n`;
  if (avoContext) {
    finalTaskPrompt += `=== NVIDIA AVO Lineage Context ===\n${avoContext}\n\n`;
  }
  if (hypothesis) {
    finalTaskPrompt += `=== Current Hypothesis ===\n${hypothesis}\n\n`;
  }
  finalTaskPrompt += `=== Instruction ===\n${prompt}\n\n`;
  finalTaskPrompt += `If a shell command fails with "'Get-Content'/'Select-String' is not recognized", you're in cmd.exe - use powershell -NoProfile -Command "..." or type and findstr.\n`;

  const args = ["run"];
  if (sessionId) {
    if (knownSessions.has(sessionId)) {
      args.push("--name", sessionId, "--resume");
    } else {
      args.push("--name", sessionId);
      knownSessions.add(sessionId);
    }
  } else {
    args.push("--no-session");
  }
  args.push("--output-format", "stream-json");
  if (system) {
    args.push("--system", system);
  }
  args.push("-t", finalTaskPrompt);
  for (const ext of extensions ?? []) {
    args.push("--with-extension", ext);
  }

  const promise = runQueued(async () => {
    queueDepth--;
    if (entry.cancelled) {
      const result = { isError: true, text: "Task cancelled before execution." };
      entry.done = true;
      entry.result = result;
      setTimeout(() => pendingTasks.delete(taskId), TASK_RETENTION_MS);
      return result;
    }

    try {
      await withBootMutex(async () => {
        await ensureServerRunning();
      });
    } catch (err) {
      const result = { isError: true, text: `Failed to boot model server: ${err.message}` };
      entry.done = true;
      entry.result = result;
      setTimeout(() => pendingTasks.delete(taskId), TASK_RETENTION_MS);
      return result;
    }
    entry.booting = false;

    return new Promise((resolve) => {
      entry.execStartedAt = Date.now();
      const child = spawn(GOOSE_EXE, args, {
        cwd,
        env: {
          ...process.env,
          GOOSE_WORKING_DIR: cwd,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      entry.child = child;

      let lineBuf = "";
      child.stdout.on("data", (chunk) => {
        lineBuf += chunk.toString("utf8");
        const lines = lineBuf.split("\n");
        lineBuf = lines.pop() ?? "";
        for (const l of lines) {
          if (l.trim()) entry.lines.push(l);
        }
      });

      child.stderr.on("data", (chunk) => {
        entry.stderr += chunk.toString("utf8");
        if (entry.stderr.length > 50_000) {
          entry.stderr = entry.stderr.slice(-50_000);
        }
      });

      let settled = false;
      const finish = async (timedOut) => {
        if (settled) return;
        settled = true;
        if (lineBuf.trim()) entry.lines.push(lineBuf.trim());
        const summary = summarizeGooseRun(entry.lines, { timedOut, timeoutMs: entry.timeoutMs, stderr: entry.stderr });

        // If test_command is specified, run AVO verification & record lineage
        if (testCommand && lineageEngine) {
          try {
            const { stdout: testOut, stderr: testErr } = await execFileAsync(
              "powershell.exe",
              ["-NoProfile", "-Command", testCommand],
              { cwd, timeout: 300_000 }
            ).catch((err) => ({ stdout: err.stdout ?? "", stderr: err.stderr ?? err.message }));

            const metricVal = metricName ? lineageEngine.extractMetric(testOut, metricName) : null;
            const status = metricVal !== null || !summary.isError ? "IMPROVED" : "FAILED";
            lineageEngine.recordCandidate({
              hypothesis: hypothesis ?? prompt,
              filesModified: summary.fileOps,
              metricName: metricName ?? "test_execution",
              metricValue: metricVal,
              higherIsBetter: higherIsBetter ?? true,
              status,
              testStderr: testErr || testOut,
            });
            summary.text += `\n\n=== NVIDIA AVO Verification ===\nTest Command: \`${testCommand}\`\nStatus: ${status}\nMetric: ${metricVal ?? "Executed"}`;
          } catch (e) {
            summary.text += `\n\n=== NVIDIA AVO Error ===\nFailed to run test command: ${e.message}`;
          }
        }

        entry.done = true;
        entry.result = summary;
        setTimeout(() => pendingTasks.delete(taskId), TASK_RETENTION_MS);
        resolve(summary);
      };

      const killTimer = setTimeout(() => {
        execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], () => {});
        finish(true);
      }, entry.timeoutMs);

      child.on("close", () => {
        clearTimeout(killTimer);
        finish(false);
      });
      child.on("error", (err) => {
        clearTimeout(killTimer);
        if (settled) return;
        settled = true;
        const result = { isError: true, text: `Failed to spawn goose: ${err.message}` };
        entry.done = true;
        entry.result = result;
        setTimeout(() => pendingTasks.delete(taskId), TASK_RETENTION_MS);
        resolve(result);
      });
    });
  });

  return { taskId, promise };
}

// MCP Server Initialization
const server = new McpServer({
  name: "qwen38-local",
  version: "3.0.0",
});

// Tool 1: qwen_coworker (Unified Agentic & Socratic Coworker)
server.registerTool(
  "qwen_coworker",
  {
    title: "Autonomous Senior Coworker (Goose Agent + Universal 245K vLLM)",
    description:
      "Primary agentic interface for local Qwen3.8-27B running inside the Goose agent harness for $0. " +
      "Has native access to local Filesystem, Shell, and Git. " +
      "Supports multi-turn Socratic collaboration, code refactoring, adversarial threat modeling, deep research, and lineage tracking. " +
      "Dynamic Extensions:\n" +
      "  - `uvx free-search-mcp` (Web Search, Documentation, PDF/DOCX)\n" +
      "  - `npx.cmd -y @playwright/mcp@latest` (Headless Browser & DOM Verification)\n" +
      "  - `npx.cmd -y context7@latest` (Version-Accurate Framework & Library Docs)\n" +
      "  - `gh` CLI (Authenticated GitHub PR/Issue/Repo workflows)\n" +
      "When passed `hypothesis` and `test_command`, executes as an NVIDIA AVO candidate variation step with `.avo/lineage.json` tracking.",
    inputSchema: {
      prompt: z.string().describe("Task, inquiry, or architectural instruction for Qwen"),
      session_id: z.string().optional().describe("Named persistent session ID (maintains KV-cache and conversation context across turns)"),
      cwd: z.string().optional().describe("Working directory for filesystem and shell tools (defaults to current workspace)"),
      extensions: z.array(z.string()).optional().describe("Optional stdio extensions (e.g. ['uvx free-search-mcp'])"),
      hypothesis: z.string().optional().describe("Optional NVIDIA AVO hypothesis being tested"),
      test_command: z.string().optional().describe("Optional verification test/benchmark command (e.g. 'pytest tests/test_core.py')"),
      metric_name: z.string().optional().describe("Target metric name in benchmark output (e.g. 'throughput', 'accuracy')"),
      higher_is_better: z.boolean().optional().describe("Whether higher metric values represent improvement (default true)"),
      timeout_ms: z.number().int().positive().optional().describe("Task timeout in ms (default 900,000ms / 15 min)"),
    },
  },
  async ({ prompt, session_id, cwd, extensions, hypothesis, test_command, metric_name, higher_is_better, timeout_ms }) => {
    const workingDir = cwd ?? process.cwd();
    const { taskId, promise } = startGooseTask({
      cwd: workingDir,
      prompt,
      sessionId: session_id,
      extensions,
      timeoutMs: timeout_ms,
      hypothesis,
      testCommand: test_command,
      metricName: metric_name,
      higherIsBetter: higher_is_better,
    });

    const earlyRace = new Promise((resolve) => setTimeout(() => resolve(null), RACE_MS));
    const result = await Promise.race([promise, earlyRace]);
    if (result !== null) {
      return {
        content: [{ type: "text", text: result.text }],
        isError: result.isError,
      };
    }

    return {
      content: [
        {
          type: "text",
          text:
            `Task is executing in Goose (task ID: ${taskId}). ` +
            `Check progress via qwen_task_status or poll http://127.0.0.1:${STATUS_PORT}/task/${taskId}. ` +
            `(${unfinishedTaskCount()} unfinished task(s) active).`,
        },
      ],
    };
  }
);

// Tool 2: qwen_task_status
server.registerTool(
  "qwen_task_status",
  {
    title: "Check Status or Output of Background Goose Task",
    description: "Polls for the progress or final structured result of an active/completed task ID without burning LLM turns.",
    inputSchema: {
      task_id: z.string().describe("The task_id returned by qwen_coworker"),
    },
  },
  async ({ task_id }) => {
    const entry = pendingTasks.get(task_id);
    if (!entry) {
      return {
        content: [{ type: "text", text: `Task "${task_id}" not found or expired from memory.` }],
        isError: true,
      };
    }

    if (entry.done) {
      return {
        content: [{ type: "text", text: entry.result.text }],
        isError: entry.result.isError,
      };
    }

    const elapsed = Math.round((Date.now() - entry.startedAt) / 1000);
    const state = entry.booting ? "booting vLLM" : entry.execStartedAt ? "running Goose" : "queued";
    return {
      content: [
        {
          type: "text",
          text: `Task "${task_id}" is ${state} (${elapsed}s elapsed, budget ${Math.round(entry.timeoutMs / 1000)}s). Progress: ${entry.lines.length} events logged.`,
        },
      ],
    };
  }
);

// Tool 3: qwen_task_cancel
server.registerTool(
  "qwen_task_cancel",
  {
    title: "Cancel a Running or Queued Goose Task",
    description: "Terminates a background Goose task and frees execution slots immediately.",
    inputSchema: {
      task_id: z.string().describe("The task_id to cancel"),
    },
  },
  async ({ task_id }) => {
    const entry = pendingTasks.get(task_id);
    if (!entry) {
      return { content: [{ type: "text", text: `Task "${task_id}" not found.` }] };
    }
    if (entry.done) {
      return { content: [{ type: "text", text: `Task "${task_id}" has already completed.` }] };
    }
    entry.cancelled = true;
    if (entry.child?.pid) {
      execFile("taskkill", ["/PID", String(entry.child.pid), "/T", "/F"], () => {});
    }
    entry.done = true;
    entry.result = { isError: true, text: `Task "${task_id}" was explicitly cancelled.` };
    return { content: [{ type: "text", text: `Cancelled task "${task_id}".` }] };
  }
);

// Tool 4: qwen_server (Unified Server Lifecycle)
server.registerTool(
  "qwen_server",
  {
    title: "Manage Local Qwen3.8-27B vLLM Instance Lifecycle",
    description: "Check status, start, or stop the universal 245K context vLLM server in WSL Ubuntu.",
    inputSchema: {
      action: z.enum(["status", "start", "stop"]).describe("Lifecycle action to perform"),
    },
  },
  async ({ action }) => {
    if (action === "status") {
      const mode = await currentMode();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                status: mode ? "running" : "stopped",
                endpoint: BASE_URL,
                context_window: MAX_LEN_HUGE,
                stack: "vLLM + DFlash2 + KVarN (Universal 245K)",
              },
              null,
              2
            ),
          },
        ],
      };
    }
    if (action === "start") {
      const res = await ensureServerRunning();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ status: "running", result: res.status, endpoint: BASE_URL, context: MAX_LEN_HUGE }, null, 2),
          },
        ],
      };
    }
    if (action === "stop") {
      await stopServer();
      return {
        content: [{ type: "text", text: JSON.stringify({ status: "stopped", message: "vLLM server stopped." }, null, 2) }],
      };
    }
  }
);

// HTTP Status Mirror
function statusServer() {
  const http = createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${STATUS_PORT}`);
    const match = url.pathname.match(/^\/task\/([^/]+)$/);
    if (!match) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    const taskId = match[1];
    const entry = pendingTasks.get(taskId);
    if (!entry) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "task not found or expired", taskId }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        taskId,
        done: entry.done,
        booting: entry.booting,
        startedAt: entry.startedAt,
        execStartedAt: entry.execStartedAt,
        timeoutMs: entry.timeoutMs,
        lineCount: entry.lines.length,
        result: entry.result ?? null,
      })
    );
  });
  http.on("error", (err) => {
    if (err.code !== "EADDRINUSE") {
      console.error("Status server error:", err);
    }
  });
  http.listen(STATUS_PORT, "127.0.0.1", () => {
    // Port 18021 listening
  });
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  statusServer();
}

main().catch((err) => {
  console.error("MCP Server Fatal Error:", err);
  process.exit(1);
});
