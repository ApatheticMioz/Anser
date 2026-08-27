#!/usr/bin/env node
/**
 * Unified Local Qwen3.8-27B MCP Server (August 2026 SOTA - v4.1.0)
 *
 * Architecture:
 * - Lead Architect (Meta-Supervisor): Claude 5 Sonnet in Claude Code / Gemini 3.7 Flash in Antigravity
 * - Local Coworker (Variation & Execution Operator): Qwen3.8-27B via Goose Harness
 * - Serving: Universal 245K context (vLLM + DFlash2 + KVarN @ localhost:18020)
 * - Zero-Turn Async Architecture: Blocking Long-Poll HTTP Wait Endpoint (localhost:18021)
 * - 3 Consolidated SOTA Tools: qwen_coworker, qwen_task, qwen_server
 * - True Windows <-> WSL Agnosticism with 45s Safe Synchronous Race & 1-Hour Background Budget
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import { existsSync, readFileSync } from "fs";
import http from "http";
import path from "path";
import crypto from "crypto";
import { AvoLineageEngine } from "./avo_engine.js";

const execFileAsync = promisify(execFile);

const VLLM_PORT = 18020;
const STATUS_PORT = 18021;
const BASE_URL = `http://localhost:${VLLM_PORT}/v1`;
const MAX_LEN_HUGE = 245760;
const BOOT_TIMEOUT_MS = 180_000;
const BOOT_POLL_MS = 3000;

// Safe sync race threshold: 45s (guaranteed safe across Claude Desktop 60s & Antigravity 180s)
const RACE_MS = 45_000;
// Full 1-Hour Default Time Budget for background execution
const DEFAULT_TIMEOUT_MS = 3_600_000;
// Inactivity Heartbeat: Kill only if process produces 0 stream chunks for 10 minutes
const INACTIVITY_TIMEOUT_MS = 600_000;
const EXTENSION_BONUS_TIMEOUT_MS = 600_000;
const TASK_RETENTION_MS = 10_800_000; // 3 hours

const IS_WINDOWS = process.platform === "win32";

/**
 * Normalizes workspace paths bidirectionally across Windows host and WSL POSIX.
 */
function normalizeWorkspacePath(inputPath) {
  if (!inputPath) return process.cwd();
  let p = inputPath.trim();

  if (IS_WINDOWS) {
    if (p.startsWith("/home/")) {
      return `\\\\wsl.localhost\\Ubuntu${p.replace(/\//g, "\\")}`;
    }
    const mntMatch = p.match(/^\/mnt\/([a-zA-Z])\/(.*)/);
    if (mntMatch) {
      const drive = mntMatch[1].toUpperCase();
      const sub = mntMatch[2].replace(/\//g, "\\");
      return `${drive}:\\${sub}`;
    }
    return p;
  } else {
    const winMatch = p.match(/^([a-zA-Z]):[\\/](.*)/);
    if (winMatch) {
      const drive = winMatch[1].toLowerCase();
      const sub = winMatch[2].replace(/\\/g, "/");
      return `/mnt/${drive}/${sub}`;
    }
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

async function serverInfo() {
  try {
    const key = getApiKeySync();
    const res = await fetch(`${BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const j = await res.json();
    const len = j?.data?.[0]?.max_model_len;
    return { maxModelLen: len ?? 0 };
  } catch {
    return null;
  }
}

// Truthy = server is up. "huge" only when the advertised max_model_len is
// actually in the 245K class (catches a manually-started fast/57K server
// instead of misreporting it as the universal config).
async function currentMode() {
  const info = await serverInfo();
  if (!info) return null;
  if (info.maxModelLen >= 200_000) return "huge";
  if (info.maxModelLen > 0) return "fast";
  return "unknown";
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

// -----------------------------------------------------------------------------
// Durable Task Registry & Zero-Turn HTTP Server
// -----------------------------------------------------------------------------

const tasks = new Map();

function cleanOldTasks() {
  const now = Date.now();
  for (const [id, task] of tasks.entries()) {
    if (task.done && now - task.createdAt > TASK_RETENTION_MS) {
      tasks.delete(id);
    }
  }
}

setInterval(cleanOldTasks, 300_000);

function notifyWaiters(task) {
  if (!task.waiters || task.waiters.length === 0) return;
  const payload = task.result?.text || (task.isError ? "Task failed." : "Task completed with no output.");
  for (const res of task.waiters) {
    try {
      res.writeHead(task.isError ? 500 : 200, {
        "Content-Type": "text/markdown; charset=utf-8",
        "X-Task-ID": task.id,
        "X-Task-Status": task.status,
      });
      res.end(payload);
    } catch {}
  }
  task.waiters = [];
}

const statusHttpServer = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://localhost:${STATUS_PORT}`);
  const pathname = parsedUrl.pathname;

  // GET /tasks
  if (req.method === "GET" && pathname === "/tasks") {
    const list = Array.from(tasks.values()).map((t) => ({
      id: t.id,
      sessionId: t.sessionId,
      cwd: t.cwd,
      status: t.status,
      createdAt: t.createdAt,
      elapsed_s: Math.round((Date.now() - t.createdAt) / 1000),
      done: t.done,
      isError: t.isError,
    }));
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ active_tasks: list }, null, 2));
  }

  // GET /task/:id/wait (Blocking long-poll)
  const waitMatch = pathname.match(/^\/task\/([^/]+)\/wait$/);
  if (req.method === "GET" && waitMatch) {
    const taskId = waitMatch[1];
    const task = tasks.get(taskId);
    if (!task) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end(`Task not found: ${taskId}`);
    }

    if (task.done) {
      const payload = task.result?.text || (task.isError ? "Task failed." : "Task completed.");
      res.writeHead(task.isError ? 500 : 200, { "Content-Type": "text/markdown; charset=utf-8" });
      return res.end(payload);
    }

    // Register long-poll waiter
    task.waiters = task.waiters || [];
    task.waiters.push(res);
    req.on("close", () => {
      task.waiters = task.waiters.filter((w) => w !== res);
    });
    return;
  }

  // GET /task/:id (Immediate JSON status check)
  const getMatch = pathname.match(/^\/task\/([^/]+)$/);
  if (req.method === "GET" && getMatch) {
    const taskId = getMatch[1];
    const task = tasks.get(taskId);
    if (!task) {
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ found: false, id: taskId }));
    }
    const elapsed_s = Math.round(((task.finishedAt || Date.now()) - task.createdAt) / 1000);
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(
      JSON.stringify(
        {
          found: true,
          id: task.id,
          sessionId: task.sessionId,
          cwd: task.cwd,
          status: task.status,
          done: task.done,
          isError: task.isError,
          elapsed_s,
          fileOps: task.fileOps || [],
          toolCallsCount: task.toolCallsCount || 0,
        },
        null,
        2
      )
    );
  }

  // POST /task/:id/cancel
  const cancelMatch = pathname.match(/^\/task\/([^/]+)\/cancel$/);
  if ((req.method === "POST" || req.method === "DELETE") && cancelMatch) {
    const taskId = cancelMatch[1];
    const task = tasks.get(taskId);
    if (!task) {
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ cancelled: false, error: "Not found" }));
    }
    if (!task.done && task.child) {
      killProcessTree(task.child);
      task.status = "cancelled";
      task.done = true;
      task.isError = true;
      task.result = { isError: true, text: `Task ${taskId} cancelled by request.` };
      notifyWaiters(task);
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ cancelled: true, id: taskId }));
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

// True only for the first index.js process to bind STATUS_PORT. Each Claude
// surface (Desktop/Code/Antigravity) spawns its own OS process running this
// same server, so later instances run with their own in-memory task registry
// but a status port they do not own (see NOTES.md, 2026-08-23).
let statusServerOwned = true;
statusHttpServer.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    // Another instance already binds status port; continue safely, but make
    // sure wait_commands we hand out don't point at the other instance.
    statusServerOwned = false;
  } else {
    console.error("Status HTTP Server Error:", err);
  }
});

statusHttpServer.listen(STATUS_PORT, "127.0.0.1", () => {});

// -----------------------------------------------------------------------------
// Core Task Execution
// -----------------------------------------------------------------------------

function startGooseTask({ cwd, prompt, sessionId, extensions, system, timeoutMs, hypothesis, testCommand, metricName, higherIsBetter }) {
  const taskId = `task_${sessionId}_${Date.now()}`;
  const totalTimeoutMs = (timeoutMs ?? DEFAULT_TIMEOUT_MS) + (extensions && extensions.length ? EXTENSION_BONUS_TIMEOUT_MS : 0);

  const taskEntry = {
    id: taskId,
    sessionId,
    cwd,
    prompt,
    createdAt: Date.now(),
    startedAt: Date.now(),
    finishedAt: null,
    status: "executing",
    done: false,
    isError: false,
    child: null,
    lines: [],
    fileOps: [],
    toolCallsCount: 0,
    result: null,
    waiters: [],
  };

  tasks.set(taskId, taskEntry);

  const executionPromise = runQueued(async () => {
    try {
      await withBootMutex(async () => {
        await ensureServerRunning();
      });
    } catch (err) {
      taskEntry.done = true;
      taskEntry.isError = true;
      taskEntry.status = "failed";
      taskEntry.result = { isError: true, text: `Failed to boot model server: ${err.message}` };
      notifyWaiters(taskEntry);
      return taskEntry.result;
    }

    let lineageEngine = null;
    let avoContext = null;
    if (testCommand) {
      try {
        lineageEngine = new AvoLineageEngine(cwd);
        // Async (reads/creates .avo/lineage.json) - must be awaited before
        // the value is interpolated into the prompt.
        avoContext = await lineageEngine.getLineageContext();
      } catch {}
    }

    let finalTaskPrompt = `Your working directory is exactly: ${cwd}\n\n`;
    if (avoContext) {
      finalTaskPrompt += `=== NVIDIA AVO Lineage Context ===\n${avoContext}\n\n`;
    }
    if (hypothesis) {
      finalTaskPrompt += `=== Current Hypothesis ===\n${hypothesis}\n\n`;
    }
    finalTaskPrompt += `=== Instruction ===\n${prompt}\n\n`;
    finalTaskPrompt += `=== Operational & Tooling Directives ===\n`;
    finalTaskPrompt += `- Prefer native Goose tools (\`read\`, \`edit\`, \`write\`, \`patch\`, \`tree\`) over shell subprocesses for inspecting and modifying files for maximum efficiency.\n`;
    if (IS_WINDOWS) {
      finalTaskPrompt += `- Windows Line Endings: Workspace files may use CRLF (\\r\\n). If \`edit\` or string replacement encounters matching issues, inspect exact line endings with \`read\` or write the normalized file.\n`;
      finalTaskPrompt += `- Shell execution: If executing PowerShell commands via shell, use \`powershell -NoProfile -Command "..."\` or native utilities directly.\n`;
    }


    return new Promise(async (resolve) => {
      let lastActivityAt = Date.now();
      const lines = taskEntry.lines;
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
        // POSIX: give the child its own process group so killProcessTree can
        // signal the whole tree via -pid. (Windows uses taskkill /T /F
        // instead, so detached is left off there to keep console behavior.)
        detached: !IS_WINDOWS,
      });

      taskEntry.child = child;

      let lineBuf = "";
      child.stdout.on("data", (chunk) => {
        lastActivityAt = Date.now();
        lineBuf += chunk.toString("utf8");
        const chunkLines = lineBuf.split("\n");
        lineBuf = chunkLines.pop() ?? "";
        for (const l of chunkLines) {
          if (l.trim()) {
            lines.push(l);
            try {
              const obj = JSON.parse(l);
              const content = obj?.message?.content;
              if (Array.isArray(content)) {
                for (const c of content) {
                  if (c.type === "toolRequest") {
                    taskEntry.toolCallsCount++;
                    const name = c.toolCall?.value?.name;
                    if (["write", "edit", "str_replace", "patch"].includes(name)) {
                      taskEntry.fileOps.push(`${name}:${c.toolCall.value.arguments?.path ?? "?"}`);
                    }
                  }
                }
              }
            } catch {}
          }
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

        if (testCommand && lineageEngine) {
          try {
            const shellCmd = IS_WINDOWS
              ? { bin: "powershell.exe", args: ["-NoProfile", "-Command", testCommand] }
              : { bin: "bash", args: ["-c", testCommand] };

            let testOut = "";
            let testErr = "";
            let testExitCode = 0;
            try {
              const r = await execFileAsync(shellCmd.bin, shellCmd.args, {
                cwd,
                timeout: 300_000,
              });
              testOut = r.stdout ?? "";
              testErr = r.stderr ?? "";
            } catch (err) {
              // execFile sets .code to the numeric exit code on non-zero
              // exits (or "ETIMEDOUT" for a killed timeout).
              testExitCode = typeof err.code === "number" ? err.code : 1;
              testOut = err.stdout ?? "";
              testErr = err.stderr ?? err.message;
            }

            const metricVal = metricName ? lineageEngine.extractMetric(testOut, metricName) : null;
            const rec = await lineageEngine.recordCandidate({
              hypothesis: hypothesis ?? prompt,
              testCommand,
              filesModified: summary.fileOps,
              metricScore: metricVal,
              targetMetricName: metricName ?? "test_execution",
              higherIsBetter: higherIsBetter ?? true,
              stdout: testOut,
              stderr: testErr,
              exitCode: testExitCode,
            });
            summary.text += `\n\n=== NVIDIA AVO Verification ===\nTest Command: \`${testCommand}\`\nCandidate: ${rec.candidateId}\nStatus: ${rec.status}\nMetric: ${metricVal ?? "Executed"}\n${rec.message}`;
          } catch (e) {
            summary.text += `\n\n=== NVIDIA AVO Error ===\nFailed to run test command: ${e.message}`;
          }
        }

        taskEntry.done = true;
        taskEntry.finishedAt = Date.now();
        taskEntry.isError = summary.isError;
        taskEntry.status = summary.isError ? "failed" : "completed";
        taskEntry.result = summary;

        notifyWaiters(taskEntry);
        resolve(summary);
      };

      const watchdog = setInterval(() => {
        if (settled) {
          clearInterval(watchdog);
          return;
        }
        const now = Date.now();
        const inactiveMs = now - lastActivityAt;
        const totalElapsedMs = now - taskEntry.startedAt;

        if (inactiveMs >= INACTIVITY_TIMEOUT_MS) {
          clearInterval(watchdog);
          killProcessTree(child);
          finish(
            true,
            `Inactivity Timeout: Goose subprocess produced zero stream activity for ${Math.round(inactiveMs / 1000)}s.`
          );
        } else if (totalElapsedMs >= totalTimeoutMs) {
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
        taskEntry.done = true;
        taskEntry.isError = true;
        taskEntry.status = "failed";
        taskEntry.result = result;
        notifyWaiters(taskEntry);
        resolve(result);
      });
    });
  });

  return { taskId, taskEntry, executionPromise };
}

// -----------------------------------------------------------------------------
// MCP Server Initialization (3 Consolidated SOTA Tools)
// -----------------------------------------------------------------------------

const server = new McpServer({
  name: "qwen38-local",
  version: "4.1.0",
});

// Tool 1: qwen_coworker (Primary Hybrid Agent Interface)
server.registerTool(
  "qwen_coworker",
  {
    title: "Autonomous Senior Coworker (Goose Agent + Universal 245K vLLM)",
    description:
      "Primary agentic interface for local Qwen3.8-27B running inside the Goose agent harness for $0. " +
      "Has native access to Filesystem, Shell, and Git across Windows and WSL. Pure text-only model with Universal 245K context. " +
      "Executes multi-turn Socratic collaboration, codebase exploration, threat modeling, deep research, and AVO candidate mutations. " +
      "Execution Contract:\n" +
      "  - Fast tasks (< 45s): Returns full deliverable directly in Turn 1.\n" +
      "  - Long tasks (>= 45s): Safely yields `taskId` and a `wait_command` before client deadlines.\n" +
      "    Run `wait_command` via native shell to block and wake up automatically with the result at $0 token cost.\n" +
      "Supported Extensions:\n" +
      "  - `uvx free-search-mcp` (Deep Web Search, Live Docs, PDF/DOCX Ingestion)\n" +
      "  - `npx.cmd -y context7@latest` / `npx -y context7@latest` (Version-Accurate Framework & Library Docs)\n" +
      "  - `gh` CLI / `git` (Authenticated GitHub operations and atomic git branch/commit workflows)",
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
    const resolvedSession = resolveSessionId(workingDir, session_id);

    const { taskId, taskEntry, executionPromise } = startGooseTask({
      cwd: workingDir,
      prompt,
      sessionId: resolvedSession,
      extensions,
      timeoutMs: timeout_ms,
      hypothesis,
      testCommand: test_command,
      metricName: metric_name,
      higherIsBetter: higher_is_better,
    });

    const raceTimer = new Promise((resolve) => setTimeout(() => resolve({ timedOutOnClientRace: true }), RACE_MS));
    const winner = await Promise.race([executionPromise, raceTimer]);

    if (!winner.timedOutOnClientRace) {
      return {
        content: [{ type: "text", text: winner.text }],
        isError: winner.isError,
      };
    }

    const waitCmd = `curl -s http://127.0.0.1:${STATUS_PORT}/task/${taskId}/wait`;
    const responseText = [
      `### Qwen Task Dispatched (Background Execution)`,
      `- **Task ID**: \`${taskId}\``,
      `- **Session**: \`${resolvedSession}\``,
      `- **Working Directory**: \`${workingDir}\``,
      `- **Time Elapsed**: 45s (Task continuing in background with 1-hour budget)`,
      ``,
    ];
    if (statusServerOwned) {
      responseText.push(
        `> [!TIP]`,
        `> **Zero-Turn Reactive Wait**: Execute the following command via \`run_command\` (or background shell). It will sleep at $0 token cost and automatically wake you when Qwen completes:`,
        `\`\`\`bash`,
        `${waitCmd}`,
        `\`\`\``,
        ``,
        `Or manage via tool: \`qwen_task(action: "status", task_id: "${taskId}")\`.`
      );
    } else {
      responseText.push(
        `> [!CAUTION]`,
        `> The long-poll wait endpoint (127.0.0.1:${STATUS_PORT}) is currently owned by another MCP server instance, so a \`curl\` for this task ID would 404 there.`,
        `> Instead, poll \`qwen_task(action: "status", task_id: "${taskId}")\` at intervals of **180+ seconds** (never tighter) until it reports done.`,
        ``
      );
    }

    return {
      content: [{ type: "text", text: responseText.join("\n") }],
      isError: false,
    };
  }
);

// Tool 2: qwen_task (Unified Background Task Management)
server.registerTool(
  "qwen_task",
  {
    title: "Manage Background Qwen Tasks",
    description: "Check status, retrieve output, cancel, or list background Qwen coworker tasks.",
    inputSchema: {
      action: z.enum(["status", "cancel", "list"]).describe("Action to perform on background tasks"),
      task_id: z.string().optional().describe("Task ID (required for 'status' and 'cancel')"),
    },
  },
  async ({ action, task_id }) => {
    if (action === "list") {
      const list = Array.from(tasks.values()).map((t) => ({
        id: t.id,
        sessionId: t.sessionId,
        status: t.status,
        elapsed_s: Math.round(((t.finishedAt || Date.now()) - t.createdAt) / 1000),
        done: t.done,
        isError: t.isError,
      }));
      return {
        content: [{ type: "text", text: JSON.stringify({ tasks: list }, null, 2) }],
      };
    }

    if (!task_id) {
      return {
        content: [{ type: "text", text: "Error: `task_id` parameter is required for action: '" + action + "'." }],
        isError: true,
      };
    }

    const task = tasks.get(task_id);
    if (!task) {
      return {
        content: [{ type: "text", text: `Task \`${task_id}\` not found in memory (retention is 3 hours).` }],
        isError: true,
      };
    }

    if (action === "status") {
      if (task.done) {
        return {
          content: [{ type: "text", text: task.result?.text || "Task completed." }],
          isError: task.isError,
        };
      }
      const elapsed_s = Math.round((Date.now() - task.createdAt) / 1000);
      const hint = statusServerOwned
        ? `\n\nWait command (blocks at $0 until done):\n\`curl -s http://127.0.0.1:${STATUS_PORT}/task/${task_id}/wait\``
        : `\n\n(Zero-turn wait endpoint is owned by another MCP instance - re-poll this tool in 180+ seconds.)`;
      return {
        content: [
          {
            type: "text",
            text: `Task \`${task_id}\` is actively EXECUTING (${elapsed_s}s elapsed, ${task.toolCallsCount} tool calls made).${hint}`,
          },
        ],
        isError: false,
      };
    }

    if (action === "cancel") {
      if (!task.done && task.child) {
        killProcessTree(task.child);
        task.status = "cancelled";
        task.done = true;
        task.isError = true;
        task.result = { isError: true, text: `Task ${task_id} was cancelled by caller.` };
        notifyWaiters(task);
        return {
          content: [{ type: "text", text: `Task \`${task_id}\` cancelled and process tree killed.` }],
        };
      }
      return {
        content: [{ type: "text", text: `Task \`${task_id}\` was already finished.` }],
      };
    }
  }
);

// Tool 3: qwen_server (Unified Server Lifecycle)
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
      const info = await serverInfo();
      const running = !!info;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                status: running ? "running" : "stopped",
                endpoint: BASE_URL,
                max_model_len: running ? info.maxModelLen : null,
                context_window_nominal: MAX_LEN_HUGE,
                stack: "vLLM + DFlash2 + KVarN (Universal 245K)",
                status_endpoint: `http://127.0.0.1:${STATUS_PORT}`,
                status_endpoint_owned_by_this_instance: statusServerOwned,
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
