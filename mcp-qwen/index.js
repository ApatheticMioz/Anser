#!/usr/bin/env node
/**
 * Unified Local Qwen3.8-27B MCP Server (August 2026 SOTA - v4.5.6)
 *
 * Architecture:
 * - Lead Architect (Meta-Supervisor): Claude 5 Sonnet in Claude Code / Gemini 3.7 Flash in Antigravity
 * - Autonomous Execution Coworker: Qwen3.8-27B via Goose Agent Harness ($0 text-only execution)
 * - Serving: Universal 245K context (vLLM + DFlash2 + KVarN @ localhost:18020)
 * - Zero-Turn Async Architecture: Blocking Long-Poll HTTP Wait Endpoint (localhost:18021)
 * - 3 Consolidated SOTA Tools: qwen_coworker, qwen_task, qwen_server
 * - Autonomous Self-Healing Engine Lifecycle, Decaying Checkpoint Telemetry & Granular Turn Cadence
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import fs, { existsSync, readFileSync } from "fs";
import os from "os";
import http from "http";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { AvoLineageEngine } from "./avo_engine.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isMain = Boolean(
  process.argv[1] &&
  (path.resolve(process.argv[1]).toLowerCase() === __filename.toLowerCase() ||
   process.argv[1].toLowerCase().endsWith("index.js"))
);

const execFileAsync = promisify(execFile);

const VLLM_PORT = 18020;
const STATUS_PORT = 18021;
const STREAM_PROXY_PORT = 18022;
const BASE_URL = `http://localhost:${VLLM_PORT}/v1`;
const MAX_LEN_HUGE = 245760;
const BOOT_TIMEOUT_MS = 180_000;
const BOOT_POLL_MS = 3000;

// Safe sync race threshold: 45s default for Claude Desktop/Code (~60s client timeout).
// Override per client via QWEN_RACE_MS (e.g. 150000 for Antigravity IDE's 180s timeout).
const DEFAULT_RACE_MS = 45_000;
const RACE_MS = process.env.QWEN_RACE_MS
  ? parseInt(process.env.QWEN_RACE_MS, 10)
  : DEFAULT_RACE_MS;
// Generous Default Time Budget (4 hours) for background execution; inactivity watchdog handles hangs
const DEFAULT_TIMEOUT_MS = 14_400_000;
// Budget floor: a 27B model on consumer silicon routinely needs tens of
// minutes; sub-floor budgets are raised to this value before dispatch.
// Env-overridable (parseInt guard, like RACE_MS above) for tests.
const DEFAULT_MIN_TIMEOUT_MS = 600_000;
const MIN_TIMEOUT_MS = (() => {
  const parsed = parseInt(process.env.QWEN_MIN_TIMEOUT_MS, 10);
  // Guard against NaN/negative/zero: a bad override must degrade to the
  // default, never poison the watchdog arithmetic (totalTimeoutMs = NaN).
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MIN_TIMEOUT_MS;
})();
// Inactivity Heartbeat: Kill only if process produces 0 stream chunks for 30 minutes (env-overridable)
const INACTIVITY_TIMEOUT_MS = (() => {
  const parsed = parseInt(process.env.QWEN_INACTIVITY_TIMEOUT_MS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1_800_000; // 30 min for 245K context
})();
// First-Token Timeout: fail fast when goose emits NO output at all shortly after spawn.
// A healthy engine streams the first chunk within seconds even under load; a wedged or
// fully saturated engine core delivers nothing (2026-08-28: requests sat 601s with zero
// chunks while the GPU spun at 100% on a hung engine core). Only runs after the goose
// child actually spawns - queued tasks have no watchdog at all.
const FIRST_TOKEN_TIMEOUT_MS = process.env.QWEN_FIRST_TOKEN_TIMEOUT_MS
  ? parseInt(process.env.QWEN_FIRST_TOKEN_TIMEOUT_MS, 10)
  : 240_000;
const EXTENSION_BONUS_TIMEOUT_MS = 600_000;
const TASK_RETENTION_MS = 10_800_000; // 3 hours

const IS_WINDOWS = process.platform === "win32";

/**
 * Checks if a target path resides inside the WSL filesystem.
 */
function isWslLocation(inputPath) {
  if (!inputPath) return false;
  const p = inputPath.trim();
  return (
    p.startsWith("/home/") ||
    p.startsWith("/root/") ||
    p.startsWith("/etc/") ||
    p.startsWith("/var/") ||
    p.startsWith("/usr/") ||
    p.startsWith("/tmp/") ||
    /^\\\\wsl(?:\.localhost|\$)\\/i.test(p)
  );
}

/**
 * Normalizes any path to a clean POSIX WSL path (e.g. /home/apath/Work).
 */
function toPosixWslPath(inputPath) {
  if (!inputPath) return "/home/apath";
  let p = inputPath.trim();
  const uncMatch = p.match(/^\\\\wsl(?:\.localhost|\$)\\[^\\]+\\(.*)/i);
  if (uncMatch) {
    return `/${uncMatch[1].replace(/\\/g, "/")}`;
  }
  const winMatch = p.match(/^([a-zA-Z]):[\\/](.*)/);
  if (winMatch) {
    const drive = winMatch[1].toLowerCase();
    const sub = winMatch[2].replace(/\\/g, "/");
    return `/mnt/${drive}/${sub}`;
  }
  return p.replace(/\\/g, "/");
}

/**
 * Normalizes any path to a valid Windows path (e.g. D:\LLM_Ecosystem or \\wsl.localhost\Ubuntu\home\...).
 */
function toWindowsPath(inputPath) {
  if (!inputPath) return process.cwd();
  let p = inputPath.trim();
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
}

/**
 * Normalizes workspace paths bidirectionally across Windows host and WSL POSIX.
 */
function normalizeWorkspacePath(inputPath) {
  if (!inputPath) return process.cwd();
  let p = inputPath.trim();
  if (isWslLocation(p)) {
    return IS_WINDOWS ? toWindowsPath(p) : toPosixWslPath(p);
  }
  return IS_WINDOWS ? toWindowsPath(p) : toPosixWslPath(p);
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

function killProcessTree(child, sessionId) {
  if (sessionId) {
    if (IS_WINDOWS) {
      execFile("wsl.exe", ["-d", "Ubuntu", "--", "pkill", "-9", "-f", `goose run --name ${sessionId}`], () => {});
    } else {
      execFile("pkill", ["-9", "-f", `goose run --name ${sessionId}`], () => {});
    }
  }
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

async function warmEngine() {
  try {
    const key = getApiKeySync();
    await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: "qwen3.8-27b",
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
        temperature: 0.0,
      }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch {}
}

async function ensureServerRunning() {
  const current = await currentMode();
  if (current) {
    return { switched: false, status: "already_running" };
  }
  await runWslCommand(
    `cd ~/qwen-serving && nohup bash launchers/start_huge.sh > /tmp/mcp_launch_huge.log 2>&1 < /dev/null & disown; sleep 1; true`
  );
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, BOOT_POLL_MS));
    const now = await currentMode();
    if (now) {
      await ensureStreamProxyRunning();
      await warmEngine();
      return { switched: true, status: "started" };
    }
  }
  throw new Error(`Timed out waiting for vLLM server to boot (${BOOT_TIMEOUT_MS}ms)`);
}

async function ensureStreamProxyRunning() {
  // 1. Fast check if already healthy
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`http://127.0.0.1:${STREAM_PROXY_PORT}/health`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return true;
    } catch {}
    if (attempt === 0) await new Promise((r) => setTimeout(r, 200));
  }

  // 2. Launch or restart proxy
  if (IS_WINDOWS) {
    try {
      await runWslCommand(`pkill -9 -f 'stream_proxy.js' 2>/dev/null || true`);
      await new Promise((r) => setTimeout(r, 300));
      await runWslCommand(`setsid node /mnt/d/LLM_Ecosystem/mcp-qwen/stream_proxy.js < /dev/null > /tmp/stream_proxy.log 2>&1 &`);
    } catch {}
  } else {
    try {
      const { spawn } = await import("child_process");
      const p = spawn("node", [path.join(__dirname, "stream_proxy.js")], {
        stdio: "ignore",
        detached: true,
      });
      p.unref();
    } catch {}
  }

  // 3. Reliable readiness probe with retries (up to 5 seconds)
  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      const res = await fetch(`http://127.0.0.1:${STREAM_PROXY_PORT}/health`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return true;
    } catch {}
  }
  throw new Error(`Stream proxy failed to become healthy on port ${STREAM_PROXY_PORT} after 5s`);
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

// Goose concurrency is a GLOBAL cross-process semaphore implemented below (lease
// files under ~/.qwen/goose_slots/) - it must live near TASK_DIR, which it uses.
// An in-process limit was useless across sessions: every Claude surface spawns its
// own copy of this server, so N sessions = N processes = N concurrent gooses
// against one GPU regardless of the limit. runQueued acquires a global slot before
// execution; task entries stay "queued" and watchdog-exempt until they hold one.

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

// Garbled-output watchdog (NOTES.md "Serving-stack corruption incident"): the
// one-off "!"-burst class. Lost in the v4.x tool consolidation, re-added
// 2026-08-29 as a result flag only - qwen_coworker cannot safely auto-retry
// (goose may have already written files), so corrupt output surfaces loudly
// instead. Benign markdown rulers (---, ```, ___, ~~~) are excluded from the
// burst check; the block check ignores whitespace-only repeats.
const CORRUPTION_BENIGN_CHARS = new Set([" ", "\n", "\t", "\r", "-", "=", "`", "~", "_", "#"]);
function detectCorruption(text) {
  if (!text || text.length < 32) return null;
  const findings = [];
  // (a) Burst: 5+ consecutive repeats of one non-benign character.
  let run = 1;
  for (let i = 1; i < text.length; i++) {
    if (text[i] === text[i - 1]) {
      run++;
      if (run >= 5 && !CORRUPTION_BENIGN_CHARS.has(text[i])) {
        findings.push(`character burst: ${JSON.stringify(text[i].repeat(5))}`);
        break;
      }
    } else {
      run = 1;
    }
  }
  // (b) Repeat: a 40-char block appearing 3+ times (sampled windows, bounded).
  const sample = text.slice(0, 20_000);
  for (let i = 0; i + 40 <= sample.length; i += 20) {
    const block = sample.slice(i, i + 40);
    if (sample.split(block).length - 1 >= 3) {
      findings.push(`40-char block repeated 3+ times: ${JSON.stringify(block.slice(0, 30))}...`);
      break;
    }
  }
  return findings.length ? findings.join("; ") : null;
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

  const corruption = detectCorruption(finalText);
  if (corruption) {
    parts.push(
      `> [!WARNING]\n` +
        `> Output corruption watchdog triggered: ${corruption}. This matches the known garbled-output\n` +
        `> signature (see NOTES.md "Serving-stack corruption incident") - treat the text above with suspicion\n` +
        `> and re-dispatch if it reads as garbage. File operations may still be valid.`
    );
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

  // Degenerate run: goose exited normally but produced NO tool calls and NO
  // final text. Observed 2026-08-29: the model composed a malformed shell
  // command, gave up silently, goose exited 0 - and the old summary reported
  // "Qwen finished. 0 tool call(s)" with nothing attached, which reads as
  // success to the supervisor. It is a failure.
  const degenerate = !timedOut && toolCalls.length === 0 && !finalText;
  if (degenerate) {
    parts.push(
      `Degenerate run: goose exited without producing any tool calls or output text. ` +
        `The model likely failed on a malformed command (check the stderr tail below) or the engine returned nothing. Re-dispatch recommended.`
    );
  }

  const streamErrorPattern = /Stream decode error|error decoding response body|Network error:\s*Stream decode error/i;
  const isStreamError = (finalText && streamErrorPattern.test(finalText)) || (stderr && streamErrorPattern.test(stderr));
  if (isStreamError) {
    parts.push(
      `> [!CAUTION]\n` +
      `> **Stream decode / transport error encountered** during Goose execution.\n` +
      `> The local universal streaming proxy will handle future token streams, but this session context should be rolled to a fresh session_id (e.g. \`<session>_stage2\`) if retrying.`
    );
  }

  const isError = isStreamError || degenerate || errors.length > 0 || (timedOut && fileOps.length === 0);
  return { isError, text: parts.join("\n\n"), toolCalls, errors, fileOps, finalText };
}

async function sessionExistsOnDisk(sessionId, targetInWsl = false) {
  if (!sessionId) return false;
  try {
    let stdout = "";
    if (targetInWsl && IS_WINDOWS) {
      const res = await execFileAsync("wsl.exe", ["-d", "Ubuntu", "--exec", "/home/apath/.local/bin/goose", "session", "list"], { timeout: 10000 });
      stdout = res.stdout;
    } else {
      const gooseExe = getGooseExecutable();
      const res = await execFileAsync(gooseExe, ["session", "list"], { timeout: 10000 });
      stdout = res.stdout;
    }
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
// Durable Disk-Backed Task Registry & Universal Zero-Turn HTTP Server
// -----------------------------------------------------------------------------

const TASK_DIR = path.join(os.homedir(), ".qwen", "tasks");
try {
  fs.mkdirSync(TASK_DIR, { recursive: true });
} catch {}

const tasks = new Map();

function pidAlive(pid) {
  if (!pid) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0); // signal 0 = liveness probe, no signal sent
    return true;
  } catch (err) {
    return err.code === "EPERM"; // EPERM = exists, just not ours
  }
}

function saveTaskToDisk(task) {
  if (!task || !task.id) return;
  try {
    const filePath = path.join(TASK_DIR, `${task.id}.json`);
    const tmpPath = `${filePath}.tmp_${process.pid}_${Date.now()}`;
    const payload = {
      id: task.id,
      sessionId: task.sessionId,
      cwd: task.cwd,
      prompt: task.prompt,
      ownerPid: task.ownerPid || process.pid,
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
      lastHeartbeatAt: task.lastHeartbeatAt || Date.now(),
      status: task.status,
      done: task.done,
      isError: task.isError,
      fileOps: task.fileOps || [],
      toolCallsCount: task.toolCallsCount || 0,
      result: task.result || null,
      stderr: task.stderr ? task.stderr.slice(-2000) : "",
    };
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), "utf8");
    fs.renameSync(tmpPath, filePath);
  } catch {}
}

function isTaskOrphaned(diskTask) {
  if (!diskTask || diskTask.done) return false;
  // If owning process PID is recorded and no longer alive, it's definitely dead
  if (diskTask.ownerPid && !pidAlive(diskTask.ownerPid)) return true;
  // If heartbeat/activity is silent for > 5 min without owning process confirmed
  const lastActive = diskTask.lastHeartbeatAt || diskTask.startedAt || diskTask.createdAt;
  if (lastActive && Date.now() - lastActive > 300_000) {
    if (!diskTask.ownerPid || !pidAlive(diskTask.ownerPid)) return true;
  }
  return false;
}

function markTaskOrphanedOnDisk(diskTask) {
  if (!diskTask || diskTask.done) return diskTask;
  diskTask.done = true;
  diskTask.status = "failed";
  diskTask.isError = true;
  diskTask.finishedAt = Date.now();
  diskTask.result = {
    isError: true,
    text: `Task orphaned: worker process (PID ${diskTask.ownerPid || "unknown"}) exited unexpectedly before completion.`,
    toolCalls: diskTask.toolCallsCount || 0,
    errors: ["WORKER_PROCESS_TERMINATED"],
    fileOps: diskTask.fileOps || [],
  };
  saveTaskToDisk(diskTask);
  return diskTask;
}

function readTaskFromDisk(taskId) {
  try {
    const filePath = path.join(TASK_DIR, `${taskId}.json`);
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (parsed && !parsed.done && isTaskOrphaned(parsed)) {
        return markTaskOrphanedOnDisk(parsed);
      }
      return parsed;
    }
  } catch {}
  return null;
}

function listTasksFromDisk() {
  const result = [];
  try {
    const files = fs.readdirSync(TASK_DIR);
    const now = Date.now();
    for (const f of files) {
      if (f.endsWith(".json")) {
        try {
          const filePath = path.join(TASK_DIR, f);
          const stat = fs.statSync(filePath);
          if (now - stat.mtimeMs > TASK_RETENTION_MS) {
            try { fs.unlinkSync(filePath); } catch {}
            continue;
          }
          const task = JSON.parse(fs.readFileSync(filePath, "utf8"));
          result.push(task);
        } catch {}
      }
    }
  } catch {}
  return result;
}

function cleanOldTasks() {
  const now = Date.now();
  for (const [id, task] of tasks.entries()) {
    if (task.done && now - task.createdAt > TASK_RETENTION_MS) {
      tasks.delete(id);
    }
  }
  listTasksFromDisk(); // Triggers disk retention cleanup
}

if (isMain) {
  setInterval(cleanOldTasks, 300_000).unref();
}

// -----------------------------------------------------------------------------
// Global Goose Concurrency (cross-process, v4.3.0)
//
// Disk-lease semaphore shared by every instance of this server on the machine
// (Claude Code sessions, Desktop, Antigravity - each spawns its own process).
// Slot i = ~/.qwen/goose_slots/slot_<i>.json, claimed atomically via O_EXCL
// ("wx") open. Holders refresh an `hb` heartbeat every 15s. A lease is
// reclaimable when its pid is dead (after 90s staleness) or its hb is >5min
// stale with a live pid (a wedged holder - its own task watchdog will have
// fired long before that). Default 1 = strict one-goose-at-a-time globally,
// the intent of the old in-process FIFO, now actually enforced machine-wide.
// QWEN_MAX_CONCURRENT raises the global cap; keep it <= engine MAX_SEQS (8)
// or dispatches queue invisibly inside vLLM instead of here.
// -----------------------------------------------------------------------------
const MAX_CONCURRENT_GOOSE = process.env.QWEN_MAX_CONCURRENT
  ? Math.max(1, parseInt(process.env.QWEN_MAX_CONCURRENT, 10))
  : 1;
const SLOT_HEARTBEAT_MS = 15_000;
const SLOT_STALE_MS = 90_000; // pid dead -> lease reclaimable after this
const SLOT_WEDGED_MS = 5 * 60_000; // pid alive but silent -> assume abandoned
const SLOT_POLL_MS = 1_000;

function slotFilePath(i) {
  return path.join(TASK_DIR, "goose_slots", `slot_${i}.json`);
}

// pidAlive is declared earlier above saveTaskToDisk

function readLease(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function leaseReclaimable(lease) {
  if (!lease) return true; // unreadable = crashed mid-write
  // If the claiming process is dead, reclaim the slot immediately (no artificial 90s delay)
  if (!pidAlive(lease.pid)) return true;
  const age = Date.now() - (lease.hb ?? lease.at ?? 0);
  return age > SLOT_WEDGED_MS;
}

// Resolves with {file, refresh} once a slot is held, or null if the task was
// cancelled while waiting (taskEntry.done) - callers must not run fn then.
async function acquireGooseSlot(taskEntry) {
  fs.mkdirSync(path.join(TASK_DIR, "goose_slots"), { recursive: true });
  for (;;) {
    if (taskEntry?.done) return null;
    for (let i = 0; i < MAX_CONCURRENT_GOOSE; i++) {
      const file = slotFilePath(i);
      const claim = { pid: process.pid, taskId: taskEntry?.id ?? null, at: Date.now(), hb: Date.now() };
      try {
        const fd = fs.openSync(file, "wx"); // atomic claim - only one process wins
        fs.writeSync(fd, JSON.stringify(claim));
        fs.closeSync(fd);
        const refresh = setInterval(() => {
          try {
            const cur = readLease(file);
            // If someone stole our lease (>5min stall), stop refreshing; release
            // will refuse to unlink a lease we no longer own.
            if (cur && cur.pid !== process.pid) {
              clearInterval(refresh);
              return;
            }
            fs.writeFileSync(file, JSON.stringify({ ...(cur ?? claim), pid: process.pid, hb: Date.now() }));
          } catch {}
        }, SLOT_HEARTBEAT_MS);
        refresh.unref();
        return { file, refresh };
      } catch (err) {
        if (err.code !== "EEXIST") continue; // transient fs error: try next slot
        const lease = readLease(file);
        if (!leaseReclaimable(lease)) continue;
        // Reclaim: rename is atomic, so only one racing process wins; losers see
        // ENOENT and simply retry on the next poll cycle.
        const dead = `${file}.dead_${Date.now()}_${process.pid}`;
        try {
          fs.renameSync(file, dead);
          fs.rmSync(dead, { force: true });
        } catch {}
      }
    }
    await new Promise((r) => setTimeout(r, SLOT_POLL_MS));
  }
}

function releaseGooseSlot(slot) {
  if (!slot) return;
  clearInterval(slot.refresh);
  try {
    const cur = readLease(slot.file);
    if (!cur || cur.pid === process.pid || !pidAlive(cur.pid)) fs.rmSync(slot.file, { force: true });
  } catch {}
}

// Active (non-reclaimable) leases across all instances - for status reporting.
function listGooseSlots() {
  const out = [];
  for (let i = 0; i < MAX_CONCURRENT_GOOSE; i++) {
    const file = slotFilePath(i);
    const lease = readLease(file);
    if (lease && !leaseReclaimable(lease)) out.push(lease);
  }
  return out;
}

async function runQueued(fn, taskEntry) {
  const slot = await acquireGooseSlot(taskEntry);
  if (!slot) {
    // Cancelled while waiting for a slot - never executed, nothing to clean up.
    return taskEntry?.result ?? { isError: true, text: "Task cancelled before acquiring a goose slot." };
  }
  if (taskEntry?.done || taskEntry?.status === "cancelled") {
    releaseGooseSlot(slot);
    return taskEntry?.result ?? { isError: true, text: "Task cancelled before execution." };
  }
  if (taskEntry && !taskEntry.done) {
    taskEntry.status = "executing";
    taskEntry.startedAt = Date.now();
    saveTaskToDisk(taskEntry);
  }
  try {
    return await fn();
  } finally {
    releaseGooseSlot(slot);
  }
}

// -----------------------------------------------------------------------------
// Engine Health: wedge detection (2026-08-28 incident follow-up)
//
// vLLM prints an "Engine 000: ... Running: N reqs, Waiting: M reqs, GPU KV cache
// usage: X%" stats line every 10 seconds unconditionally - idle or busy, boot
// -----------------------------------------------------------------------------
// Engine Gauges via Prometheus /metrics
// -----------------------------------------------------------------------------
let metricsCache = { at: 0, data: null };
async function readEngineMetrics(maxAgeMs = 5000) {
  if (metricsCache.data && Date.now() - metricsCache.at < maxAgeMs) return metricsCache.data;
  try {
    const res = await fetch(`${BASE_URL.replace(/\/v1$/, "")}/metrics`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const map = {};
    for (const line of (await res.text()).split("\n")) {
      if (!line.startsWith("vllm:")) continue;
      const name = line.match(/^(vllm:[^{ ]+)/)?.[1];
      const val = Number(line.slice(line.lastIndexOf(" ") + 1));
      if (!name || !Number.isFinite(val)) continue;
      map[name] = Math.max(map[name] ?? -Infinity, val);
    }
    metricsCache = { at: Date.now(), data: map };
    return map;
  } catch {
    metricsCache = { at: Date.now(), data: null };
    return null;
  }
}

function resetEngineHealthCache() {
  metricsCache = { at: 0, data: null };
}

function notifyWaiters(task) {
  saveTaskToDisk(task);
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

  // GET /health
  if (req.method === "GET" && pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", service: "mcp-qwen-status", port: STATUS_PORT }));
    return;
  }

  // GET /tasks
  if (req.method === "GET" && pathname === "/tasks") {
    const merged = new Map();
    for (const dt of listTasksFromDisk()) {
      merged.set(dt.id, {
        id: dt.id,
        sessionId: dt.sessionId,
        cwd: dt.cwd,
        status: dt.status,
        createdAt: dt.createdAt,
        elapsed_s: Math.round(((dt.finishedAt || Date.now()) - dt.createdAt) / 1000),
        done: dt.done,
        isError: dt.isError,
      });
    }
    for (const t of tasks.values()) {
      merged.set(t.id, {
        id: t.id,
        sessionId: t.sessionId,
        cwd: t.cwd,
        status: t.status,
        createdAt: t.createdAt,
        elapsed_s: Math.round(((t.finishedAt || Date.now()) - t.createdAt) / 1000),
        done: t.done,
        isError: t.isError,
        streamBytes: t.streamBytes || 0,
        streamTail: (t.streamTail || "").replace(/["\\{}\[\]]|type|message|content|delta|thinking|text/g, " ").replace(/\s+/g, " ").slice(-150),
      });
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ active_tasks: Array.from(merged.values()) }, null, 2));
  }

  // GET /task/:id/wait (Universal blocking long-poll across memory + disk)
  const waitMatch = pathname.match(/^\/task\/([^/]+)\/wait$/);
  if (req.method === "GET" && waitMatch) {
    const taskId = waitMatch[1];
    let task = tasks.get(taskId);
    let diskTask = null;
    if (!task) {
      diskTask = readTaskFromDisk(taskId);
      if (!diskTask) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        return res.end(`Task not found: ${taskId}`);
      }
    }

    const isDone = task ? task.done : diskTask.done;
    const isError = task ? task.isError : diskTask.isError;
    const resText = (task ? task.result?.text : diskTask.result?.text) || (isError ? "Task failed." : "Task completed.");

    if (isDone) {
      res.writeHead(isError ? 500 : 200, { "Content-Type": "text/markdown; charset=utf-8" });
      return res.end(resText);
    }

    if (task) {
      task.waiters = task.waiters || [];
      task.waiters.push(res);
      req.on("close", () => {
        task.waiters = task.waiters.filter((w) => w !== res);
      });
      return;
    }

    // Disk-based task from another instance: poll disk until done
    const waitStartTime = Date.now();
    const diskPoll = setInterval(() => {
      const current = readTaskFromDisk(taskId);
      if (!current || current.done) {
        clearInterval(diskPoll);
        const err = current ? current.isError : true;
        const out = current?.result?.text || (err ? "Task failed." : "Task completed.");
        try {
          res.writeHead(err ? 500 : 200, { "Content-Type": "text/markdown; charset=utf-8" });
          res.end(out);
        } catch {}
        return;
      }
      if (Date.now() - waitStartTime > DEFAULT_TIMEOUT_MS) {
        clearInterval(diskPoll);
        try {
          res.writeHead(504, { "Content-Type": "text/markdown; charset=utf-8" });
          res.end("Task wait timed out after maximum duration budget.");
        } catch {}
      }
    }, 2000);

    req.on("close", () => {
      clearInterval(diskPoll);
    });
    return;
  }

  // GET /task/:id (Immediate JSON status check & telemetry)
  const getMatch = pathname.match(/^\/task\/([^/]+)$/);
  if (req.method === "GET" && getMatch) {
    const taskId = getMatch[1];
    let task = tasks.get(taskId) || readTaskFromDisk(taskId);
    if (!task) {
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ found: false, id: taskId }));
    }
    const now = Date.now();
    const elapsed_s = Math.round(((task.finishedAt || now) - task.createdAt) / 1000);
    const lastActivitySecAgo = task.lastActivityAt ? Math.max(0, Math.round((now - task.lastActivityAt) / 1000)) : null;
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
          startedAt: task.startedAt,
          lastActivitySecAgo,
          streamBytes: task.streamBytes || 0,
          streamTail: (task.streamTail || "").replace(/["\\{}\[\]]|type|message|content|delta|thinking|text/g, " ").replace(/\s+/g, " ").slice(-250),
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
    if (task) {
      if (!task.done) {
        killProcessTree(task.child, task.sessionId);
        task.status = "cancelled";
        task.done = true;
        task.isError = true;
        task.result = { isError: true, text: `Task ${taskId} cancelled by request.` };
        saveTaskToDisk(task);
        notifyWaiters(task);
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ cancelled: true, id: taskId }));
    }
    const diskTask = readTaskFromDisk(taskId);
    if (diskTask) {
      if (diskTask.sessionId) {
        if (IS_WINDOWS) {
          execFile("wsl.exe", ["-d", "Ubuntu", "--", "pkill", "-9", "-f", `goose run --name ${diskTask.sessionId}`], () => {});
        } else {
          execFile("pkill", ["-9", "-f", `goose run --name ${diskTask.sessionId}`], () => {});
        }
      }
      diskTask.status = "cancelled";
      diskTask.done = true;
      diskTask.isError = true;
      diskTask.result = { isError: true, text: `Task ${taskId} cancelled.` };
      saveTaskToDisk(diskTask);
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ cancelled: true, id: taskId }));
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ cancelled: false, error: "Not found" }));
  }

  // POST /tasks/cancel or /tasks/cancel_all (Universal mass cancellation)
  if ((req.method === "POST" || req.method === "DELETE") && (pathname === "/tasks/cancel" || pathname === "/tasks/cancel_all")) {
    cancelAllTasks("cancelled via HTTP coordinator").then((count) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ cancelled: true, count }));
    }).catch((err) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ cancelled: false, error: err.message }));
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

let statusServerOwned = true;
statusHttpServer.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    statusServerOwned = false;
  } else {
    console.error("Status HTTP Server Error:", err);
  }
});

try {
  statusHttpServer.listen(STATUS_PORT, "127.0.0.1", () => {});
} catch (err) {
  if (err.code === "EADDRINUSE") {
    statusServerOwned = false;
  }
}

// -----------------------------------------------------------------------------
// Universal Task Cancellation & Process Tree Cleanup
// -----------------------------------------------------------------------------

async function cancelAllTasks(reason = "cancelled by caller") {
  let count = 0;
  // 1. Cancel in-memory tasks and notify waiters
  for (const task of tasks.values()) {
    if (!task.done) {
      if (task.child) {
        killProcessTree(task.child, task.sessionId);
        task.child = null;
      }
      task.status = "cancelled";
      task.done = true;
      task.isError = true;
      task.finishedAt = Date.now();
      task.result = { isError: true, text: `Task ${task.id} was ${reason}.` };
      saveTaskToDisk(task);
      notifyWaiters(task);
      count++;
    }
  }

  // 2. Cancel disk tasks
  for (const diskTask of listTasksFromDisk()) {
    if (!diskTask.done) {
      diskTask.status = "cancelled";
      diskTask.done = true;
      diskTask.isError = true;
      diskTask.finishedAt = Date.now();
      diskTask.result = { isError: true, text: `Task ${diskTask.id} was ${reason}.` };
      saveTaskToDisk(diskTask);
      count++;
    }
  }

  // 3. Kill all running goose processes machine-wide across Windows and WSL
  if (IS_WINDOWS) {
    try {
      execFile("wsl.exe", ["-d", "Ubuntu", "--", "pkill", "-9", "-f", "goose run"], () => {});
      execFile("taskkill", ["/F", "/IM", "goose.exe"], () => {});
    } catch {}
  } else {
    try {
      execFile("pkill", ["-9", "-f", "goose run"], () => {});
    } catch {}
  }

  // 4. Clean up any lingering slot lease locks so queue doesn't stay wedged
  try {
    const slotsDir = path.join(TASK_DIR, "goose_slots");
    if (fs.existsSync(slotsDir)) {
      for (const f of fs.readdirSync(slotsDir)) {
        if (f.startsWith("slot_") && f.endsWith(".json")) {
          fs.rmSync(path.join(slotsDir, f), { force: true });
        }
      }
    }
  } catch {}

  return count;
}

// -----------------------------------------------------------------------------
// Core Task Execution
// -----------------------------------------------------------------------------

function startGooseTask({ cwd, prompt, sessionId, extensions, system, timeoutMs, hypothesis, testCommand, metricName, higherIsBetter }) {
  const taskId = `task_${sessionId}_${Date.now()}`;
  // Floor the caller value / default to MIN_TIMEOUT_MS BEFORE the extension
  // bonus, so a mis-sized small budget can't kill a run the 27B model needs.
  const baseTimeoutMs = Math.max(timeoutMs ?? DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS);
  const totalTimeoutMs = baseTimeoutMs + (extensions && extensions.length ? EXTENSION_BONUS_TIMEOUT_MS : 0);

  // Slot acquisition is cross-process and async: every task starts "queued"
  // (watchdog-exempt, no budget ticking) and flips to "executing" only when it
  // holds a global goose slot.
  const taskEntry = {
    id: taskId,
    sessionId,
    cwd,
    prompt,
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    lastActivityAt: null,
    streamBytes: 0,
    streamTail: "",
    status: "queued",
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
  saveTaskToDisk(taskEntry);

  const executionPromise = runQueued(async () => {
    if (taskEntry.done || taskEntry.status === "cancelled") {
      return taskEntry.result ?? { isError: true, text: "Task was cancelled before execution." };
    }
    try {
      await withBootMutex(async () => {
        if (taskEntry.done || taskEntry.status === "cancelled") return;
        await ensureServerRunning();
        await ensureStreamProxyRunning();
      });
      if (taskEntry.done || taskEntry.status === "cancelled") {
        return taskEntry.result ?? { isError: true, text: "Task was cancelled before dispatch." };
      }
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

    // Route Windows cwds through WSL Ubuntu goose (bash) by default. Native
    // goose.exe runs the model's shell commands under cmd.exe, whose quoting
    // and line-continuation mangling repeatedly broke tasks (v4.1.0 UNC bug,
    // "'version:' is not recognized" fragments). wsl.exe --cd accepts the
    // POSIX path directly, and the model then runs standard bash. Escape
    // hatch: QWEN_FORCE_WSL=0 restores native routing.
    const cwdInWsl = isWslLocation(cwd);
    const targetInWsl =
      cwdInWsl || (IS_WINDOWS && process.env.QWEN_FORCE_WSL !== "0");
    const targetCwd = targetInWsl ? toPosixWslPath(cwd) : toWindowsPath(cwd);

    let finalTaskPrompt = `Your working directory is exactly: ${targetCwd}\n\n`;
    if (avoContext) {
      finalTaskPrompt += `=== NVIDIA AVO Lineage Context ===\n${avoContext}\n\n`;
    }
    if (hypothesis) {
      finalTaskPrompt += `=== Current Hypothesis ===\n${hypothesis}\n\n`;
    }
    finalTaskPrompt += `=== Instruction ===\n${prompt}\n\n`;
    finalTaskPrompt += `=== Operational & Tooling Directives ===\n`;
    finalTaskPrompt += `- Available File Tools: Use \`write\` to create or overwrite files, \`edit\` to perform targeted text search-and-replace, \`tree\` to view directories, and \`shell\` (bash) to inspect files using \`cat\`, \`head\`, \`grep\`, or other POSIX utilities.\n`;
    finalTaskPrompt += `- Text-Only Engine: You are a pure text model with Universal 245K context. Do NOT call \`read_image\` on binary images (.png, .jpg). Multimodal image inspection is handled exclusively by the Lead Architect.\n`;
    finalTaskPrompt += `- CRITICAL: Do NOT call \`extensionmanager__read_resource\` or \`read_resource\` to read files. It is strictly an internal MCP resource provider and will fail on filesystem paths.\n`;
    finalTaskPrompt += `- Direct Execution: Never merely announce in conversational text that you will write or edit files in a future step. You must directly invoke the file modification tools (\`write\` or \`edit\`) in this turn to write the deliverable to disk.\n`;
    finalTaskPrompt += `- Full Objective Fulfillment: Take as many tool actions and iterations as needed to thoroughly accomplish the task without prematurely truncating your output.\n`;
    if (IS_WINDOWS && !cwdInWsl) {
      finalTaskPrompt += `- Windows Line Endings: Workspace files may use CRLF (\\r\\n). If \`edit\` encounters matching issues, inspect exact line endings with \`head\` or write the normalized file.\n`;
    }
    if (targetInWsl) {
      finalTaskPrompt += `- Linux Environment: Executing in Linux/WSL (bash). Use standard Linux commands and POSIX paths. Windows-drive workspaces live under /mnt/<drive>/.\n`;
    } else {
      finalTaskPrompt += `- Shell execution: If executing PowerShell commands via shell, use \`powershell -NoProfile -Command "..."\` or native utilities directly.\n`;
    }

    return new Promise(async (resolve) => {
      let lastActivityAt = Date.now();
      const lines = taskEntry.lines;
      let stderr = "";

      const args = ["run"];
      if (sessionId) {
        const exists = await sessionExistsOnDisk(sessionId, targetInWsl);
        if (exists) {
          args.push("--name", sessionId, "--resume");
        } else {
          args.push("--name", sessionId);
        }
      } else {
        args.push("--no-session");
      }
      args.push("--max-turns", "50");
      args.push("--output-format", "stream-json");
      if (system) {
        args.push("--system", system);
      }
      args.push("-t", finalTaskPrompt);
      for (const rawExt of extensions ?? []) {
        let ext = rawExt;
        if (targetInWsl) {
          // Normalize Windows-style command wrappers if target runs under WSL
          ext = ext.replace(/^npx\.cmd\b/, "npx").replace(/^uvx\.exe\b/, "uvx");
          // Normalize context7 CLI package to official context7 MCP server
          if (ext.includes("context7@latest") && !ext.includes("@upstash/context7-mcp")) {
            ext = ext.replace("context7@latest", "@upstash/context7-mcp");
          }
        }
        args.push("--with-extension", ext);
      }

      let child;
      if (targetInWsl) {
        if (IS_WINDOWS) {
          // Windows env vars do NOT cross the wsl.exe boundary by default (WSLENV
          // empty on this machine): the GOOSE_* vars below were silently dropped,
          // leaving goose to whatever ~/.config/goose/config.yaml says. Listing
          // them in WSLENV with the /u flag (Windows->WSL only) forwards them.
          const wslEnv = {
            ...process.env,
            GOOSE_PROVIDER: "openai",
            GOOSE_MODEL: "qwen3.8-27b",
            OPENAI_BASE_URL: `http://localhost:${STREAM_PROXY_PORT}/v1`,
            OPENAI_API_KEY: "dummy",
            OPENAI_TIMEOUT: "3600",
            GOOSE_STREAM_TIMEOUT: "3600",
            PYTHONIOENCODING: "utf-8",
            PYTHONUTF8: "1",
            LANG: "C.UTF-8",
            LC_ALL: "C.UTF-8",
            WSLENV: "GOOSE_PROVIDER/u:GOOSE_MODEL/u:OPENAI_BASE_URL/u:OPENAI_API_KEY/u:OPENAI_TIMEOUT/u:GOOSE_STREAM_TIMEOUT/u:PYTHONIOENCODING/u:PYTHONUTF8/u:LANG/u:LC_ALL/u",
          };
          // --exec, NOT `--`: `wsl.exe -- <cmd>` runs the command line THROUGH
          // the default shell, so any backticks in the task prompt underwent
          // bash command substitution (the backtick-quoted goose tool names in
          // our directives were executed and replaced with empty strings - the
          // model never saw them, and its stderr was polluted with
          // "edit: command not found" from the spawn shell, not from the model).
          // --exec passes argv directly to the binary.
          // Prepend /usr/bin/env PATH=... to guarantee Linux node/npm/npx/uv/uvx binaries
          // are resolved before any Windows PATH interop directories.
          const wslArgs = [
            "-d",
            "Ubuntu",
            "--cd",
            targetCwd,
            "--exec",
            "/usr/bin/env",
            "PATH=/home/apath/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            "/home/apath/.local/bin/goose",
            ...args,
          ];
          child = spawn("wsl.exe", wslArgs, {
            env: wslEnv,
            stdio: ["ignore", "pipe", "pipe"],
            detached: !IS_WINDOWS,
          });
        } else {
          const gooseExe = getGooseExecutable();
          child = spawn(gooseExe, args, {
            cwd: targetCwd,
            env: {
              ...process.env,
              GOOSE_PROVIDER: "openai",
              GOOSE_MODEL: "qwen3.8-27b",
              OPENAI_BASE_URL: `http://localhost:${STREAM_PROXY_PORT}/v1`,
              OPENAI_API_KEY: "dummy",
              OPENAI_TIMEOUT: "3600",
              GOOSE_STREAM_TIMEOUT: "3600",
              PYTHONIOENCODING: "utf-8",
              PYTHONUTF8: "1",
              LANG: "C.UTF-8",
              LC_ALL: "C.UTF-8",
              GOOSE_WORKING_DIR: targetCwd,
            },
            stdio: ["ignore", "pipe", "pipe"],
            detached: true,
          });
        }
      } else {
        const gooseExe = getGooseExecutable();
        child = spawn(gooseExe, args, {
          cwd: targetCwd,
          env: {
            ...process.env,
            GOOSE_WORKING_DIR: targetCwd,
            // Same env contract as the WSL branch - goose.exe runs config-less
            // (no C:\Users\...\.config\goose\config.yaml on this machine).
            GOOSE_PROVIDER: "openai",
            GOOSE_MODEL: "qwen3.8-27b",
            OPENAI_BASE_URL: `http://localhost:${STREAM_PROXY_PORT}/v1`,
            OPENAI_API_KEY: "dummy",
            PYTHONIOENCODING: "utf-8",
            PYTHONUTF8: "1",
            LANG: "C.UTF-8",
            LC_ALL: "C.UTF-8",
          },
          stdio: ["ignore", "pipe", "pipe"],
          detached: !IS_WINDOWS,
        });
      }

      taskEntry.child = child;

      let receivedAnyOutput = false;
      let lineBuf = "";
      let lastSaveAt = Date.now();
      child.stdout.on("data", (chunk) => {
        lastActivityAt = Date.now();
        taskEntry.lastActivityAt = lastActivityAt;
        taskEntry.lastHeartbeatAt = lastActivityAt;
        taskEntry.streamBytes = (taskEntry.streamBytes || 0) + chunk.length;
        const chunkStr = chunk.toString("utf8");
        taskEntry.streamTail = ((taskEntry.streamTail || "") + chunkStr).slice(-2000);
        receivedAnyOutput = true;
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
        if (Date.now() - lastSaveAt > 2000) {
          lastSaveAt = Date.now();
          saveTaskToDisk(taskEntry);
        }
      });

      child.stderr.on("data", (chunk) => {
        lastActivityAt = Date.now();
        taskEntry.lastActivityAt = lastActivityAt;
        receivedAnyOutput = true;
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
            let shellCmd;
            let execOptions = { timeout: 300_000 };
            if (targetInWsl) {
              if (IS_WINDOWS) {
                shellCmd = {
                  bin: "wsl.exe",
                  args: [
                    "-d",
                    "Ubuntu",
                    "--cd",
                    targetCwd,
                    "--exec",
                    "/usr/bin/env",
                    "PATH=/home/apath/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
                    "/bin/bash",
                    "-c",
                    testCommand,
                  ],
                };
              } else {
                shellCmd = { bin: "bash", args: ["-c", testCommand] };
                execOptions.cwd = targetCwd;
              }
            } else {
              shellCmd = IS_WINDOWS
                ? { bin: "powershell.exe", args: ["-NoProfile", "-Command", testCommand] }
                : { bin: "bash", args: ["-c", testCommand] };
              execOptions.cwd = toWindowsPath(cwd);
            }

            let testOut = "";
            let testErr = "";
            let testExitCode = 0;
            try {
              const r = await execFileAsync(shellCmd.bin, shellCmd.args, execOptions);
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
        summary.partialOutput = stdout;
        taskEntry.result = summary;

        // Emergency Output Preservation: Never lose partial work on timeout or failure
        if (summary.isError && stdout && stdout.trim()) {
          try {
            const dumpPath = path.join(TASK_DIR, `${taskId}.dump.md`);
            fs.writeFileSync(
              dumpPath,
              `# Emergency Task Dump: ${taskId}\n\n` +
              `- **Session**: \`${sessionId}\`\n` +
              `- **Elapsed**: ${Math.round((Date.now() - taskEntry.startedAt) / 1000)}s\n` +
              `- **Status**: ${taskEntry.status}\n` +
              `- **Reason**: ${timeoutReason || (summary.isError ? summary.text : "Unknown error")}\n\n` +
              `## Partial Stdout Output\n\n\`\`\`\n${stdout}\n\`\`\`\n\n` +
              `## Stderr\n\n\`\`\`\n${stderr}\n\`\`\`\n`,
              "utf8"
            );
          } catch {}
        }

        saveTaskToDisk(taskEntry);
        notifyWaiters(taskEntry);
        resolve(summary);
      };

      let lastKnownPromptTokens = -1;
      let lastKnownGenTokens = -1;
      let tokensLastAdvancedAt = Date.now();

      const watchdog = setInterval(async () => {
        if (settled) {
          clearInterval(watchdog);
          return;
        }

        if (taskEntry.done) {
          clearInterval(watchdog);
          killProcessTree(child, sessionId);
          finish(true, `Task cancelled.`);
          return;
        }

        try {
          const onDisk = readTaskFromDisk(taskEntry.id);
          if (onDisk && (onDisk.status === "cancelled" || onDisk.done)) {
            clearInterval(watchdog);
            killProcessTree(child, sessionId);
            taskEntry.done = true;
            taskEntry.status = "cancelled";
            finish(true, `Task cancelled externally.`);
            return;
          }
        } catch {}

        const now = Date.now();
        const inactiveMs = now - lastActivityAt;
        const totalElapsedMs = now - taskEntry.startedAt;

        // 1. Hard Wall-Clock Budget Ceiling (Protects against indefinitely orphaned tasks)
        if (totalElapsedMs >= totalTimeoutMs) {
          clearInterval(watchdog);
          killProcessTree(child, sessionId);
          finish(
            true,
            `Task Wall-Clock Budget Exceeded: Total elapsed time ${Math.round(totalElapsedMs / 1000)}s reached the budget ceiling of ${Math.round(totalTimeoutMs / 1000)}s. Partial output has been saved to disk.`
          );
          return;
        }

        // 2. Degenerate Repetition Loop Circuit Breaker in Stream Output
        if (taskEntry.streamTail) {
          const repeatMatch = taskEntry.streamTail.match(/([^ \t\n\r\-_=*#])\1{34,}/);
          if (repeatMatch) {
            clearInterval(watchdog);
            killProcessTree(child, sessionId);
            finish(
              true,
              `Degenerate Loop Circuit Breaker: Model entered an unrecoverable repetition loop on character "${repeatMatch[1]}" in stream output. Subprocess safely aborted.`
            );
            return;
          }
        }

        // 3. Token-Velocity Aware Inactivity Watchdog
        // Distinguishes active prefill/generation from true driver deadlocks / stalls
        const timeoutThreshold = !receivedAnyOutput ? FIRST_TOKEN_TIMEOUT_MS : INACTIVITY_TIMEOUT_MS;
        if (inactiveMs >= timeoutThreshold) {
          let tokenProgress = false;
          try {
            const metrics = await readEngineMetrics(2000);
            if (metrics) {
              const pTokens = metrics["vllm:prompt_tokens_total"] ?? 0;
              const gTokens = metrics["vllm:generation_tokens_total"] ?? 0;
              if (lastKnownPromptTokens < 0) {
                lastKnownPromptTokens = pTokens;
                lastKnownGenTokens = gTokens;
                tokensLastAdvancedAt = now;
              } else if (pTokens > lastKnownPromptTokens || gTokens > lastKnownGenTokens) {
                // Tokens are actively advancing on the GPU! The engine is healthy and computing.
                tokenProgress = true;
                lastKnownPromptTokens = pTokens;
                lastKnownGenTokens = gTokens;
                tokensLastAdvancedAt = now;
              } else if ((metrics["vllm:num_requests_running"] ?? 0) > 0 || (metrics["vllm:num_requests_waiting"] ?? 0) > 0) {
                // Engine has requests queued/running, but token counters are static.
                // Allow a generous 120s grace window for long kernel launches or chunked prefill setup.
                if (now - tokensLastAdvancedAt < 120_000) {
                  tokenProgress = true;
                }
              }
            }
          } catch {}

          if (tokenProgress) {
            // Engine is actively advancing tokens; grant another activity window.
            lastActivityAt = now;
            return;
          }

          // No stdout from Goose AND token velocity is completely stalled -> True wedge/deadlock.
          clearInterval(watchdog);
          killProcessTree(child, sessionId);
          const timeoutReason = !receivedAnyOutput
            ? `First-Token Timeout: Goose produced zero stream output and vLLM token counters remained static for ${Math.round(inactiveMs / 1000)}s after spawn. The engine may be deadlocked or out of memory. Safe to re-dispatch.`
            : `Inactivity Timeout: Goose subprocess and vLLM token velocity were completely stalled for ${Math.round(inactiveMs / 1000)}s. Subprocess safely aborted to preserve GPU resources.`;
          finish(true, timeoutReason);
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
  }, taskEntry);

  return { taskId, taskEntry, executionPromise, totalTimeoutMs };
}

// -----------------------------------------------------------------------------
// MCP Server Initialization (3 Consolidated SOTA Tools)
// -----------------------------------------------------------------------------

const server = new McpServer({
  name: "qwen38-local",
  version: "4.5.6",
});

// Tool 1: qwen_coworker (Primary Hybrid Agent Interface)
server.registerTool(
  "qwen_coworker",
  {
    title: "Autonomous Senior Coworker (Goose Agent + Universal 245K vLLM)",
    description:
      "Primary autonomous execution coworker for local Qwen3.8-27B via Goose agent harness ($0 local text execution). " +
      "Has full native access to Filesystem, Shell, and Git across Windows and WSL. Pure text-only model with Universal 245K context. " +
      "Executes codebase exploration, refactoring, implementation, diagnostics, live web/docs research, and git operations.\n\n" +
      "ORCHESTRATION RULES:\n" +
      "  - Single Logical Concern: Scope each prompt to ONE cohesive subsystem, architectural layer, or target AST slice. Do not bundle disparate subsystems or cross-cutting concerns into a single dispatch.\n" +
      "  - Full Objective Fulfillment: Do not instruct Qwen to limit its tool calls or artificially restrict its execution. Qwen operates autonomously with full tool depth once dispatched with a focused objective.\n" +
      "  - Session Lifecycle: Use persistent `session_id` across 2-3 focused turns, then roll to a fresh session_id (e.g. '<milestone>_stage2') when context accumulates.\n" +
      "  - Zero-Turn Execution Contract: Tasks completing within ~45s return results synchronously. Long-running tasks yield a `taskId` and a `wait_command`. Execute the `wait_command` immediately in your shell to block at $0 cost and wake on completion. Do not poll manually or execute parallel exploratory tools while waiting.\n\n" +
      "SUPPORTED EXTENSIONS:\n" +
      "  - `uvx free-search-mcp` (Web search, documentation lookup, PDF/DOCX ingestion)\n" +
      "  - `npx -y @upstash/context7-mcp` (Live framework/library documentation)\n" +
      "  - `gh` CLI / `git` (Authenticated GitHub operations and atomic commits)",
    inputSchema: {
      prompt: z.string().describe("Task, inquiry, or architectural instruction for Qwen (pure text-only; images must be inspected natively by Lead Architect and summarized into text)"),
      session_id: z.string().optional().describe("Named persistent session ID (maintains KV-cache and conversation context across turns)"),
      cwd: z.string().optional().describe("Working directory for filesystem and shell tools (defaults to current workspace)"),
      extensions: z.array(z.string()).optional().describe("Optional stdio extensions (e.g. ['uvx free-search-mcp'], ['npx -y @upstash/context7-mcp'])"),
      hypothesis: z.string().optional().describe("Optional NVIDIA AVO hypothesis being tested"),
      test_command: z.string().optional().describe("Optional verification test/benchmark command (e.g. 'pytest tests/test_core.py')"),
      metric_name: z.string().optional().describe("Target metric name in benchmark output (e.g. 'throughput', 'accuracy')"),
      higher_is_better: z.boolean().optional().describe("Whether higher metric values represent improvement (default true)"),
      timeout_ms: z.number().int().positive().optional().describe("Task timeout in ms (default 3,600,000ms (1 hour), minimum 600,000ms (10 min) - budgets are floored because a 27B model on consumer silicon routinely needs tens of minutes)"),
    },
  },
  async ({ prompt, session_id, cwd, extensions, hypothesis, test_command, metric_name, higher_is_better, timeout_ms }) => {
    const workingDir = normalizeWorkspacePath(cwd ?? process.cwd());
    const resolvedSession = resolveSessionId(workingDir, session_id);

    const { taskId, taskEntry, executionPromise, totalTimeoutMs } = startGooseTask({
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

    let raceHandle;
    const raceTimer = new Promise((resolve) => {
      raceHandle = setTimeout(() => resolve({ timedOutOnClientRace: true }), RACE_MS);
    });
    const winner = await Promise.race([executionPromise, raceTimer]);
    clearTimeout(raceHandle); // no-op if the race timer already fired

    if (!winner.timedOutOnClientRace) {
      return {
        content: [{ type: "text", text: winner.text }],
        isError: winner.isError,
      };
    }

    const curlBin = IS_WINDOWS ? "curl.exe" : "curl";
    const waitCmd = `${curlBin} -s http://127.0.0.1:${STATUS_PORT}/task/${taskId}/wait`;
    const elapsedSec = Math.round(RACE_MS / 1000);
    const responseText = [
      `### Qwen Task Dispatched (Background Execution)`,
      `- **Task ID**: \`${taskId}\``,
      `- **Session**: \`${resolvedSession}\``,
      `- **Working Directory**: \`${workingDir}\``,
      `- **Time Elapsed**: ${elapsedSec}s (Task continuing in background with ${Math.round(totalTimeoutMs / 60000)} min budget)`,
      ``,
      `> [!TIP]`,
      `> **Zero-Turn Reactive Wait**: Execute the following command via \`run_command\` (or background shell). It will sleep at $0 token cost and automatically wake you when Qwen completes:`,
      `\`\`\`bash`,
      `${waitCmd}`,
      `\`\`\``,
      ``,
      `Or inspect status via tool: \`qwen_task(action: "status", task_id: "${taskId}")\`.`,
    ];

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
      action: z.enum(["status", "cancel", "cancel_all", "list"]).describe("Action to perform on background tasks"),
      task_id: z.string().optional().describe("Task ID (required for 'status', optional for 'cancel'/'cancel_all' to cancel all tasks)"),
    },
  },
  async ({ action, task_id }) => {
    if (action === "list") {
      const merged = new Map();
      for (const dt of listTasksFromDisk()) {
        merged.set(dt.id, {
          id: dt.id,
          sessionId: dt.sessionId,
          status: dt.status,
          elapsed_s: Math.round(((dt.finishedAt || Date.now()) - dt.createdAt) / 1000),
          done: dt.done,
          isError: dt.isError,
        });
      }
      for (const t of tasks.values()) {
        merged.set(t.id, {
          id: t.id,
          sessionId: t.sessionId,
          status: t.status,
          elapsed_s: Math.round(((t.finishedAt || Date.now()) - t.createdAt) / 1000),
          done: t.done,
          isError: t.isError,
        });
      }
      return {
        content: [{ type: "text", text: JSON.stringify({ tasks: Array.from(merged.values()) }, null, 2) }],
      };
    }

    if (action === "cancel_all" || (action === "cancel" && (!task_id || task_id.toLowerCase() === "all"))) {
      const count = await cancelAllTasks("cancelled by caller");
      return {
        content: [{ type: "text", text: `Cancelled ${count} active/queued task(s), killed all Goose processes, and cleared slot leases.` }],
      };
    }

    if (!task_id) {
      return {
        content: [{ type: "text", text: "Error: `task_id` parameter is required for action: '" + action + "'." }],
        isError: true,
      };
    }

    let task = tasks.get(task_id) || readTaskFromDisk(task_id);
    if (!task) {
      return {
        content: [{ type: "text", text: `Task \`${task_id}\` not found in memory or disk (retention is 3 hours).` }],
        isError: true,
      };
    }

    if (action === "status") {
      if (task.done) {
        // Structured one-line header first so status inquiries always surface
        // task state even when the stored result text starts with an error
        // message (e.g. "Total Budget Timeout: ...").
        const elapsedS = Math.round(((task.finishedAt || Date.now()) - (task.startedAt || task.createdAt)) / 1000);
        const header = `[qwen task] id=${task.id} status=${task.status} elapsed_s=${elapsedS} isError=${task.isError}`;
        return {
          content: [{ type: "text", text: `${header}\n${task.result?.text || "Task completed."}` }],
          isError: task.isError,
        };
      }
      const elapsed_s = Math.round((Date.now() - task.createdAt) / 1000);
      const hint = `\n\nWait command (blocks at $0 until done):\n\`curl -s http://127.0.0.1:${STATUS_PORT}/task/${task_id}/wait\``;
      if (task.status === "queued") {
        const holders = listGooseSlots().map((l) => l.taskId ?? `pid ${l.pid}`);
        const heldBy = holders.length ? ` Currently held by: ${holders.join(", ")}.` : "";
        return {
          content: [
            {
              type: "text",
              text: `Task \`${task_id}\` is QUEUED for a global goose slot (${elapsed_s}s waiting; MAX_CONCURRENT_GOOSE=${MAX_CONCURRENT_GOOSE} machine-wide).${heldBy}${hint}`,
            },
          ],
          isError: false,
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `Task \`${task_id}\` is actively EXECUTING (${elapsed_s}s elapsed, ${task.toolCallsCount || 0} tool calls made).${hint}`,
          },
        ],
        isError: false,
      };
    }

    if (action === "cancel") {
      const memTask = tasks.get(task_id);
      if (memTask && !memTask.done) {
        killProcessTree(memTask.child, memTask.sessionId);
        memTask.status = "cancelled";
        memTask.done = true;
        memTask.isError = true;
        memTask.result = { isError: true, text: `Task ${task_id} was cancelled by caller.` };
        saveTaskToDisk(memTask);
        notifyWaiters(memTask);
        return {
          content: [{ type: "text", text: `Task \`${task_id}\` cancelled and process tree killed.` }],
        };
      }

      // Delegate cancellation to the status coordinator process if not owned locally
      try {
        const httpCancel = await new Promise((resolve) => {
          const postReq = http.request(
            {
              hostname: "127.0.0.1",
              port: STATUS_PORT,
              path: `/task/${encodeURIComponent(task_id)}/cancel`,
              method: "POST",
              timeout: 4000,
            },
            (res) => {
              let data = "";
              res.on("data", (chunk) => (data += chunk));
              res.on("end", () => {
                try {
                  resolve(JSON.parse(data));
                } catch {
                  resolve(null);
                }
              });
            }
          );
          postReq.on("error", () => resolve(null));
          postReq.on("timeout", () => {
            postReq.destroy();
            resolve(null);
          });
          postReq.end();
        });
        if (httpCancel?.cancelled) {
          return {
            content: [{ type: "text", text: `Task \`${task_id}\` cancelled via status coordinator.` }],
          };
        }
      } catch {}

      const diskTask = readTaskFromDisk(task_id);
      if (diskTask && !diskTask.done) {
        if (diskTask.sessionId) {
          if (IS_WINDOWS) {
            execFile("wsl.exe", ["-d", "Ubuntu", "--", "pkill", "-9", "-f", `goose run --name ${diskTask.sessionId}`], () => {});
          } else {
            execFile("pkill", ["-9", "-f", `goose run --name ${diskTask.sessionId}`], () => {});
          }
        }
        diskTask.status = "cancelled";
        diskTask.done = true;
        diskTask.isError = true;
        diskTask.result = { isError: true, text: `Task ${task_id} was cancelled by caller.` };
        saveTaskToDisk(diskTask);
        return {
          content: [{ type: "text", text: `Task \`${task_id}\` marked as cancelled.` }],
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
    description:
      "Check status, start, or stop the universal 245K context vLLM server in WSL Ubuntu. Status includes live engine gauges from /metrics (running/waiting requests, KV cache %, prefix-cache hit ratio, spec-decode acceptance) and an end-to-end canary completion - the port answering is NOT proof of health. Note: during active task execution, canary latency will be higher due to GPU batch contention; this is normal under load and is NOT a wedge. Only stop the server if the engine is idle or if the human user explicitly commands it.",
    inputSchema: {
      action: z.enum(["status", "start", "stop"]).describe("Lifecycle action to perform"),
      force: z
        .boolean()
        .optional()
        .describe(
          "Force stop even if a task is actively executing. ONLY permitted if the human USER explicitly requested stopping/rebooting the server or cancelling all tasks. Prohibited for autonomous agent decisions."
        ),
    },
  },
  async ({ action, force }) => {
    if (action === "status") {
      const info = await serverInfo();
      const running = !!info;
      const metrics = running ? await readEngineMetrics() : null;
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
                engine: running && metrics
                  ? {
                      running_requests: metrics["vllm:num_requests_running"] ?? null,
                      waiting_requests: metrics["vllm:num_requests_waiting"] ?? null,
                      kv_cache_pct: metrics["vllm:kv_cache_usage_perc"] ?? null,
                      prefix_cache_hit_ratio:
                        (metrics["vllm:prefix_cache_queries_total"] ?? 0) > 0
                          ? (metrics["vllm:prefix_cache_hits_total"] ?? 0) / metrics["vllm:prefix_cache_queries_total"]
                          : null,
                      spec_decode_acceptance:
                        (metrics["vllm:spec_decode_num_draft_tokens_total"] ?? 0) > 0
                          ? (metrics["vllm:spec_decode_num_accepted_tokens_total"] ?? 0) /
                            metrics["vllm:spec_decode_num_draft_tokens_total"]
                          : null,
                    }
                  : null,
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
      const activeTasks = listTasksFromDisk().filter((t) => !t.done && t.status === "executing");
      if (activeTasks.length > 0 && !force) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: "rejected",
                  error: `Refusing to stop vLLM server: task '${activeTasks[0].id}' is actively executing.`,
                  guidance:
                    "To cancel the active task without rebooting vLLM, call qwen_task(action: 'cancel', task_id: '" +
                    activeTasks[0].id +
                    "'). Only pass force: true to stop the server if the human USER explicitly commanded stopping the server or cancelling all tasks.",
                },
                null,
                2
              ),
            },
          ],
        };
      }
      await cancelAllTasks("server stopped by user");
      await stopServer();
      resetEngineHealthCache();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                status: "stopped",
                message: "vLLM server stopped and all active/queued tasks cancelled.",
                forced: !!force,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  }
);

function setupProcessLifecycleHandlers() {
  const cleanup = (signal) => {
    try {
      for (const [id, task] of tasks.entries()) {
        if (!task.done) {
          task.done = true;
          task.status = "cancelled";
          task.isError = true;
          task.finishedAt = Date.now();
          task.result = {
            isError: true,
            text: `Task cancelled: MCP server process terminating (${signal || "shutdown"}).`,
            toolCalls: task.toolCallsCount || 0,
            errors: ["SERVER_PROCESS_TERMINATED"],
            fileOps: task.fileOps || [],
          };
          saveTaskToDisk(task);
          notifyWaiters(task);
          if (task.child) {
            killProcessTree(task.child, task.sessionId);
          }
        }
      }
      for (let i = 0; i < MAX_CONCURRENT_GOOSE; i++) {
        const file = slotFilePath(i);
        const lease = readLease(file);
        if (lease && lease.pid === process.pid) {
          try { fs.rmSync(file, { force: true }); } catch {}
        }
      }
    } catch {}
  };

  process.once("SIGINT", () => { cleanup("SIGINT"); process.exit(0); });
  process.once("SIGTERM", () => { cleanup("SIGTERM"); process.exit(0); });
  process.stdin.on("close", () => { cleanup("stdin_closed"); process.exit(0); });
  process.stdin.on("end", () => { cleanup("stdin_end"); process.exit(0); });
  process.on("beforeExit", () => { cleanup("beforeExit"); });
}

async function main() {
  setupProcessLifecycleHandlers();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Exported for test_global_semaphore.js - importing this module runs the MCP
// server on stdio, which the test processes simply leave idle.
export { acquireGooseSlot, releaseGooseSlot, listGooseSlots, TASK_DIR, isTaskOrphaned, markTaskOrphanedOnDisk };

if (isMain) {
  main().catch((err) => {
    console.error("MCP Server Fatal Error:", err);
    process.exit(1);
  });
}
