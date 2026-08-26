#!/usr/bin/env node
/**
 * Unified Local Qwen3.8-27B MCP Server (2026 SOTA - v3.5.0)
 *
 * Architecture:
 * - Lead Architect (Meta-Supervisor): Claude 5 Sonnet in Claude Code / Gemini 3.7 Flash in Antigravity
 * - Local Coworker (Variation & Execution Operator): Qwen3.8-27B via Goose Harness
 * - Serving: Universal 245K context (vLLM + DFlash2 + KVarN @ localhost:18020)
 * - Evolutionary Optimization: Hierarchical NVIDIA AVO (persistent .avo/lineage.json)
 * - True Windows <-> WSL Agnosticism with Synchronous Execution and In-Memory Caching
 * - 1-Hour Default Time Budget with Stream Inactivity Heartbeat Watchdog
 * - Self-Healing Harness: Pre-Flight Health Probes, In-Flight Network Retry & Deterministic Session Continuity
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import { existsSync, readFileSync } from "fs";
import path from "path";
import crypto from "crypto";
import { AvoLineageEngine } from "./avo_engine.js";

const execFileAsync = promisify(execFile);

const PORT = 18020;
const BASE_URL = `http://localhost:${PORT}/v1`;
const MAX_LEN_HUGE = 245760;
const BOOT_TIMEOUT_MS = 180_000;
const BOOT_POLL_MS = 3000;

// 1-Hour Default Time Budget to support extensive benchmark matrices and deep refactorings
const DEFAULT_TIMEOUT_MS = 3_600_000;
// Inactivity Heartbeat: Kill only if process produces 0 stdout/stderr events for 10 minutes
const INACTIVITY_TIMEOUT_MS = 600_000;
const EXTENSION_BONUS_TIMEOUT_MS = 600_000;

const IS_WINDOWS = process.platform === "win32";

/**
 * Normalizes workspace paths bidirectionally across Windows host and WSL POSIX.
 */
function normalizeWorkspacePath(inputPath) {
  if (!inputPath) return process.cwd();
  let p = inputPath.trim();

  if (IS_WINDOWS) {
    // Translate WSL POSIX path (/home/apath/... -> \\wsl.localhost\Ubuntu\home\apath\...)
    if (p.startsWith("/home/")) {
      return `\\\\wsl.localhost\\Ubuntu${p.replace(/\//g, "\\")}`;
    }
    // Translate WSL mount path (/mnt/d/... -> D:\...)
    const mntMatch = p.match(/^\/mnt\/([a-zA-Z])\/(.*)/);
    if (mntMatch) {
      const drive = mntMatch[1].toUpperCase();
      const sub = mntMatch[2].replace(/\//g, "\\");
      return `${drive}:\\${sub}`;
    }
    return p;
  } else {
    // Inside Linux / WSL
    // Translate Windows drive path (D:\... -> /mnt/d/...)
    const winMatch = p.match(/^([a-zA-Z]):[\\/](.*)/);
    if (winMatch) {
      const drive = winMatch[1].toLowerCase();
      const sub = winMatch[2].replace(/\\/g, "/");
      return `/mnt/${drive}/${sub}`;
    }
    // Translate Windows UNC path (\\wsl.localhost\Ubuntu\home\... -> /home/...)
    const uncMatch = p.match(/^\\\\wsl(?:\.localhost|\$)\\[^\\]+\\(.*)/i);
    if (uncMatch) {
      return `/${uncMatch[1].replace(/\\/g, "/")}`;
    }
    return p;
  }
}

function getGooseExecutable() {
  if (IS_WINDOWS) {
    return "C:\\Users\\Apath\\.local\\bin\\goose.exe";
  }
  if (existsSync("/home/apath/.local/bin/goose")) {
    return "/home/apath/.local/bin/goose";
  }
  return "goose";
}

let cachedApiKey = null;

function getApiKeySync() {
  if (cachedApiKey) return cachedApiKey;
  const candidatePaths = IS_WINDOWS
    ? [
        "\\\\wsl.localhost\\Ubuntu\\home\\apath\\qwen-serving\\api_key.txt",
        "\\\\wsl$\\Ubuntu\\home\\apath\\qwen-serving\\api_key.txt",
        "C:\\Users\\Apath\\qwen-serving\\api_key.txt",
      ]
    : [
        "/home/apath/qwen-serving/api_key.txt",
        path.join(process.env.HOME || "/root", "qwen-serving/api_key.txt"),
      ];

  for (const cp of candidatePaths) {
    try {
      if (existsSync(cp)) {
        cachedApiKey = readFileSync(cp, "utf8").trim();
        return cachedApiKey;
      }
    } catch {}
  }
  return "EMPTY";
}

function killProcessTree(child) {
  if (!child?.pid) return;
  if (IS_WINDOWS) {
    execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], () => {});
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {}
    }
  }
}

function runWslCommand(cmd) {
  if (IS_WINDOWS) {
    return execFileAsync("wsl.exe", ["-d", "Ubuntu", "--", "bash", "-c", cmd], {
      timeout: BOOT_TIMEOUT_MS + 10_000,
    });
  } else {
    return execFileAsync("bash", ["-c", cmd], {
      timeout: BOOT_TIMEOUT_MS + 10_000,
    });
  }
}

async function currentMode() {
  try {
    const key = getApiKeySync();
    const res = await fetch(`${BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(2000),
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
  await runWslCommand(
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
  await runWslCommand(`cd ~/qwen-serving && bash launchers/stop_server.sh 2>/dev/null || true`);
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const mode = await currentMode();
    if (!mode) return { stopped: true };
  }
  return { stopped: true };
}

const MAX_CONCURRENT_GOOSE = 8;
let activeGooseCount = 0;
const gooseWaitQueue = [];

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

function summarizeGooseRun(lines, { timedOut, timeoutReason = "", timeoutMs = DEFAULT_TIMEOUT_MS, stderr = "" } = {}) {
  const { toolCalls, errors, fileOps, finalText } = extractToolEvents(lines);
  const parts = [];

  if (timedOut) {
    parts.push(
      timeoutReason ||
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

async function sessionExistsOnDisk(sessionId) {
  if (!sessionId) return false;
  const gooseExe = getGooseExecutable();
  try {
    const { stdout } = await execFileAsync(gooseExe, ["session", "list"], { timeout: 5000 });
    const lines = stdout.split("\n");
    for (const line of lines) {
      const parts = line.split(" - ");
      if (parts.length >= 2) {
        const id = parts[0].trim();
        const name = parts[1].trim();
        if (id === sessionId || name === sessionId) {
          return true;
        }
      }
    }
    return false;
  } catch {
    return false;
  }
}

function resolveSessionId(cwd, requestedSessionId) {
  if (requestedSessionId && requestedSessionId.trim()) {
    return requestedSessionId.trim();
  }
  const hash = crypto.createHash("md5").update(cwd.toLowerCase()).digest("hex").slice(0, 8);
  return `workspace_${hash}`;
}

async function runGooseSubprocess({ cwd, prompt, sessionId, extensions, system, timeoutMs, hypothesis, testCommand, metricName, higherIsBetter }) {
  const totalTimeoutMs = (timeoutMs ?? DEFAULT_TIMEOUT_MS) + (extensions && extensions.length ? EXTENSION_BONUS_TIMEOUT_MS : 0);

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
  if (IS_WINDOWS) {
    finalTaskPrompt += `If a shell command fails with "'Get-Content'/'Select-String' is not recognized", you're in cmd.exe - use powershell -NoProfile -Command "..." or type and findstr.\n`;
  }

  return new Promise(async (resolve) => {
    const startedAt = Date.now();
    let lastActivityAt = Date.now();
    const lines = [];
    let stderr = "";

    const args = ["run"];
    if (sessionId) {
      const exists = await sessionExistsOnDisk(sessionId);
      if (exists) {
        args.push("--name", sessionId, "--resume");
      } else {
        args.push("--name", sessionId);
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

    const gooseExe = getGooseExecutable();
    const child = spawn(gooseExe, args, {
      cwd,
      env: {
        ...process.env,
        GOOSE_WORKING_DIR: cwd,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let lineBuf = "";
    child.stdout.on("data", (chunk) => {
      lastActivityAt = Date.now();
      lineBuf += chunk.toString("utf8");
      const chunkLines = lineBuf.split("\n");
      lineBuf = chunkLines.pop() ?? "";
      for (const l of chunkLines) {
        if (l.trim()) lines.push(l);
      }
    });

    child.stderr.on("data", (chunk) => {
      lastActivityAt = Date.now();
      stderr += chunk.toString("utf8");
      if (stderr.length > 50_000) {
        stderr = stderr.slice(-50_000);
      }
    });

    let settled = false;
    const finish = async (timedOut, timeoutReason = "") => {
      if (settled) return;
      settled = true;
      if (lineBuf.trim()) lines.push(lineBuf.trim());
      const summary = summarizeGooseRun(lines, {
        timedOut,
        timeoutReason,
        timeoutMs: totalTimeoutMs,
        stderr,
      });

      // If test_command is specified, run AVO verification & record lineage
      if (testCommand && lineageEngine) {
        try {
          const shellCmd = IS_WINDOWS
            ? { bin: "powershell.exe", args: ["-NoProfile", "-Command", testCommand] }
            : { bin: "bash", args: ["-c", testCommand] };

          const { stdout: testOut, stderr: testErr } = await execFileAsync(
            shellCmd.bin,
            shellCmd.args,
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

      resolve(summary);
    };

    // Heartbeat & Watchdog Monitor (Checks every 5s)
    const watchdog = setInterval(() => {
      if (settled) {
        clearInterval(watchdog);
        return;
      }
      const now = Date.now();
      const inactiveMs = now - lastActivityAt;
      const totalElapsedMs = now - startedAt;

      // 1. Inactivity Watchdog: Silence threshold reached with zero stream chunks
      if (inactiveMs >= INACTIVITY_TIMEOUT_MS) {
        clearInterval(watchdog);
        killProcessTree(child);
        finish(
          true,
          `Inactivity Timeout: Goose subprocess produced zero stream activity or output for ${Math.round(inactiveMs / 1000)}s.`
        );
      }
      // 2. Absolute Wall-Clock Cap: 1-hour total budget
      else if (totalElapsedMs >= totalTimeoutMs) {
        clearInterval(watchdog);
        killProcessTree(child);
        finish(
          true,
          `Total Budget Timeout: Reached maximum execution budget of ${Math.round(totalTimeoutMs / 1000)}s (1 hour).`
        );
      }
    }, 5000);

    child.on("close", () => {
      clearInterval(watchdog);
      finish(false);
    });
    child.on("error", (err) => {
      clearInterval(watchdog);
      if (settled) return;
      settled = true;
      const result = { isError: true, text: `Failed to spawn goose (${gooseExe}): ${err.message}` };
      resolve(result);
    });
  });
}

function executeGooseTaskWithAutoRetry({ cwd, prompt, sessionId, extensions, system, timeoutMs, hypothesis, testCommand, metricName, higherIsBetter }) {
  const resolvedSession = resolveSessionId(cwd, sessionId);

  return runQueued(async () => {
    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        await withBootMutex(async () => {
          await ensureServerRunning();
        });
      } catch (err) {
        if (attempt === MAX_ATTEMPTS) {
          return { isError: true, text: `Failed to boot model server: ${err.message}` };
        }
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }

      const result = await runGooseSubprocess({
        cwd,
        prompt,
        sessionId: resolvedSession,
        extensions,
        system,
        timeoutMs,
        hypothesis,
        testCommand,
        metricName,
        higherIsBetter,
      });

      const isNetworkError =
        result.isError &&
        /Network error|Could not connect to localhost:18020|ECONNREFUSED|socket hang up/i.test(result.text);

      if (isNetworkError && attempt < MAX_ATTEMPTS) {
        // Transparent self-healing: reboot vLLM and retry session seamlessly
        await withBootMutex(async () => {
          await stopServer();
          await ensureServerRunning();
        });
        continue;
      }

      return result;
    }
  });
}

// MCP Server Initialization
const server = new McpServer({
  name: "qwen38-local",
  version: "3.5.0",
});

// Tool 1: qwen_coworker (Unified Autonomous Senior Coworker - Strictly Synchronous with Self-Healing)
server.registerTool(
  "qwen_coworker",
  {
    title: "Autonomous Senior Coworker (Goose Agent + Universal 245K vLLM)",
    description:
      "Primary agentic interface for local Qwen3.8-27B running inside the Goose agent harness for $0. " +
      "Has native access to Filesystem, Shell, and Git across Windows and WSL environments. Pure text-only model with Universal 245K context (VRAM dedicated to text/KV-cache; visual QA belongs to Lead Architect). " +
      "Executes multi-turn Socratic collaboration, codebase exploration, threat modeling, deep research, code refactoring, and AVO lineage tracking. " +
      "Runs synchronously and blocks until completion (with 1-hour budget, 10-minute stream inactivity watchdog, pre-flight health probe, and transparent network auto-retry with session resume). " +
      "Supported SOTA Text Extensions:\n" +
      "  - `uvx free-search-mcp` (Web Search, Live Documentation, PDF/DOCX Ingestion)\n" +
      "  - `npx.cmd -y context7@latest` / `npx -y context7@latest` (Version-Accurate Framework & Library Docs)\n" +
      "  - `gh` CLI / `git` (Authenticated GitHub operations and atomic git branch/commit workflows)\n" +
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
      timeout_ms: z.number().int().positive().optional().describe("Task timeout in ms (default 3,600,000ms / 1 hour with stream heartbeat)"),
    },
  },
  async ({ prompt, session_id, cwd, extensions, hypothesis, test_command, metric_name, higher_is_better, timeout_ms }) => {
    const workingDir = normalizeWorkspacePath(cwd ?? process.cwd());
    const result = await executeGooseTaskWithAutoRetry({
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

    return {
      content: [{ type: "text", text: result.text }],
      isError: result.isError,
    };
  }
);

// Tool 2: qwen_server (Unified Server Lifecycle)
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

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("MCP Server Fatal Error:", err);
  process.exit(1);
});
