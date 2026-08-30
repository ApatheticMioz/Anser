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

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

const execFileAsync = promisify(execFile);

const VLLM_PORT = 18020;
const STATUS_PORT = 18021;
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
// Inactivity Heartbeat: Kill only if process produces 0 stream chunks for 10 minutes
const INACTIVITY_TIMEOUT_MS = 600_000;
// First-Token Timeout: fail fast when goose emits NO output at all shortly after spawn.
// A healthy engine streams the first chunk within seconds even under load; a wedged or
// fully saturated engine core delivers nothing (2026-08-28: requests sat 601s with zero
// chunks while the GPU spun at 100% on a hung engine core). Only runs after the goose
// child actually spawns - queued tasks have no watchdog at all.
const FIRST_TOKEN_TIMEOUT_MS = process.env.QWEN_FIRST_TOKEN_TIMEOUT_MS
  ? parseInt(process.env.QWEN_FIRST_TOKEN_TIMEOUT_MS, 10)
  : 120_000;
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
  if (current) {
    // Port answering is NOT health: a wedged engine core keeps /v1/models at 200
    // while swallowing every completion (2026-08-28 incident). Gate on engine
    // stats freshness before declaring "running".
    const wedge = await engineWedgeState();
    if (wedge.wedged) {
      if (!AUTO_HEAL) {
        return {
          switched: false,
          status: `already_running_wedged (canary: ${wedge.canary.error}; auto-heal disabled via QWEN_AUTO_HEAL=0)`,
        };
      }
      const heal = await healWedgedEngine(wedge.stats?.ageSec ?? null);
      return { switched: true, status: `restarted_wedged_engine (canary: ${wedge.canary.error})`, heal };
    }
    return { switched: false, status: "already_running" };
  }
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

  const isError = degenerate || errors.length > 0 || (timedOut && fileOps.length === 0);
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
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
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

function readTaskFromDisk(taskId) {
  try {
    const filePath = path.join(TASK_DIR, `${taskId}.json`);
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
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

function readLease(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function leaseReclaimable(lease) {
  if (!lease) return true; // unreadable = crashed mid-write
  const age = Date.now() - (lease.hb ?? lease.at ?? 0);
  if (!pidAlive(lease.pid)) return age > SLOT_STALE_MS;
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
    if (!cur || cur.pid === process.pid) fs.rmSync(slot.file, { force: true });
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
// complete onward. When the engine CORE hangs (observed once: 4.5h, during a
// ~100k-token-context DFlash2 decode that stalled 13 -> 0 tok/s), the API process
// stays up: the port answers, /v1/models returns 200, but stats go silent and every
// chat completion is accepted-then-never-scheduled. Goose then produces zero stream
// chunks until the watchdog kills it, while the GPU sits at 100% doing nothing.
// That class correlates with stats silence. But a second class (2026-08-29)
// sits between the API server and the engine core: queues stay EMPTY and
// stats keep flowing while every completion hangs - invisible to any stats
// check. Hence the canary probe below is the authoritative wedge signal;
// stats silence is a secondary correlator only.
// -----------------------------------------------------------------------------
const ENGINE_LOG_PATH = "/tmp/mcp_launch_huge.log";
const WEDGE_STATS_SILENCE_S = process.env.QWEN_WEDGE_SILENCE_S
  ? parseInt(process.env.QWEN_WEDGE_SILENCE_S, 10)
  : 120;
const AUTO_HEAL = process.env.QWEN_AUTO_HEAL !== "0";
const HEAL_LOCK_FILE = path.join(TASK_DIR, ".engine_heal.lock");
const HEAL_LOCK_TTL_MS = 5 * 60_000; // one full boot budget

async function readLastEngineStatsLine() {
  try {
    const { stdout } = await runWslCommand(
      `grep -a 'Engine 000:.*Running:' ${ENGINE_LOG_PATH} 2>/dev/null | tail -1`
    );
    const line = stdout.trim();
    return line || null;
  } catch {
    return null;
  }
}

// Log timestamps ("INFO 08-28 19:21:46") are WSL-local; the WSL clock matches the
// Windows clock on this box (verified against the 2026-08-28 incident timeline).
function parseEngineStats(line) {
  const ts = line.match(/(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
  if (!ts) return null;
  const now = new Date();
  const stamp = new Date(
    now.getFullYear(),
    Number(ts[1]) - 1,
    Number(ts[2]),
    Number(ts[3]),
    Number(ts[4]),
    Number(ts[5])
  );
  return {
    ageSec: Math.max(0, Math.round((now.getTime() - stamp.getTime()) / 1000)),
    runningReqs: Number(line.match(/Running: (\d+) reqs/)?.[1] ?? -1),
    waitingReqs: Number(line.match(/Waiting: (\d+) reqs/)?.[1] ?? -1),
    kvCachePct: Number(line.match(/GPU KV cache usage: ([\d.]+)%/)?.[1] ?? -1),
  };
}

// ---- Engine gauges via Prometheus /metrics ----
// The engine serves its own metrics over HTTP, independent of who launched it
// or where stdout goes. The old log-scrape was a fragile convention: a manual
// or out-of-band relaunch leaves /tmp/mcp_launch_huge.log empty and detection
// goes blind (2026-08-29 incident). /metrics is the primary source now; the
// log scrape is demoted to a best-effort supplement.
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
      // Multi-label families (per-engine, per-position) collapse to max - fine
      // for the gauges we surface (running/waiting/kv/spec-acceptance).
      map[name] = Math.max(map[name] ?? -Infinity, val);
    }
    metricsCache = { at: Date.now(), data: map };
    return map;
  } catch {
    metricsCache = { at: Date.now(), data: null };
    return null;
  }
}

// ---- Canary health probe (authoritative) ----
// Stats-silence detection cannot see every wedge class. Observed 2026-08-29:
// the port answered, /v1/models and /metrics returned 200, engine queues were
// EMPTY (running=0, waiting=0) - the wedge sat between the API server and the
// engine core, so requests were accepted and never scheduled and stats never
// went stale. The only honest health check is a real completion: 8 tokens,
// ~1s when healthy, cached for 60s so the pre-dispatch gate stays cheap.
let canaryCache = { at: 0, result: null };
async function canaryProbe(force = false) {
  if (!force && canaryCache.result && Date.now() - canaryCache.at < 60_000) {
    return canaryCache.result;
  }
  const t0 = Date.now();
  let result;
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${getApiKeySync()}` },
      body: JSON.stringify({
        model: "qwen3.8-27b",
        max_tokens: 8,
        messages: [{ role: "user", content: "Reply with: ok" }],
      }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    // Success = the full API->core->scheduler->decode->response path produced
    // tokens. Content may legitimately be empty: with reasoning_effort=medium
    // the token budget can be consumed entirely inside <think> (measured on a
    // fresh boot: 8/8 tokens to reasoning, empty content, 354ms - healthy).
    if ((j?.usage?.completion_tokens ?? 0) < 1) {
      throw new Error("completion returned no tokens");
    }
    result = { ok: true, latencyMs: Date.now() - t0 };
  } catch (err) {
    result = { ok: false, latencyMs: Date.now() - t0, error: String(err?.message ?? err) };
  }
  canaryCache = { at: Date.now(), result };
  return result;
}

// ---- Boot warmup ----
// The first large chunked-prefill after an engine boot stalls the GPU stream
// once (benchmarks/wedge-repro/RESULTS.md: reproduced identically on FULL,
// PIECEWISE, and fused-routed configs; always right after the first-execution
// JIT pair; usually self-recovers, but the 2026-08-28 production incident
// stayed wedged 4.5h). Riding that stall out at boot - with a bounded
// reboot-retry - converts the production failure mode (auto-heal reboot ->
// next big dispatch wedges -> task killed) into a bounded boot delay.
// Skippable via QWEN_BOOT_WARMUP=0; size via QWEN_WARMUP_TOKENS (default
// 8,192 tokens - enough to chunk across 2048-token batches and trigger the
// JIT pair without risking excessive GPU stall time).
// "Warmed" is tracked via the cumulative prefix-cache-queries counter: it
// resets to 0 on every engine restart, so marker >= current proves the
// marker came from this same engine incarnation.
const WARMUP_MARKER_FILE = path.join(TASK_DIR, ".warmup_marker.json");
const WARMUP_TOKENS = (() => {
  const n = parseInt(process.env.QWEN_WARMUP_TOKENS, 10);
  return Number.isFinite(n) && n > 1000 ? n : 8_192;
})();
const WARMUP_TIMEOUT_MS = (() => {
  const n = parseInt(process.env.QWEN_WARMUP_TIMEOUT_MS, 10);
  return Number.isFinite(n) && n > 30_000 ? n : 600_000;
})();

function readWarmupMarker() {
  try {
    return JSON.parse(fs.readFileSync(WARMUP_MARKER_FILE, "utf8"));
  } catch {
    return null;
  }
}

async function isEngineWarmed() {
  if (process.env.QWEN_BOOT_WARMUP === "0") {
    return { warmed: true, disabled: true };
  }
  // Fresh fetch (no 5s cache): a <5s-old sample from a just-replaced engine
  // could otherwise satisfy the marker check and skip a needed warmup.
  const m = await readEngineMetrics(0);
  const q = m?.["vllm:prefix_cache_queries_total"];
  if (q == null) return { warmed: false, reason: "metrics-unavailable" };
  const marker = readWarmupMarker();
  if (marker && typeof marker.prefix_queries_total === "number" && q >= marker.prefix_queries_total) {
    return { warmed: true };
  }
  return { warmed: false, reason: marker ? "engine-restarted-since-warmup" : "never-warmed" };
}

function makeWarmupCorpus(tokens) {
  const words = [
    "alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel",
    "india", "juliet", "kilo", "lima", "mike", "november", "oscar", "papa",
    "quebec", "romeo", "sierra", "tango", "uniform", "victor", "whiskey",
    "xray", "yankee", "zulu",
  ];
  const n = Math.floor(tokens * 1.35);
  const parts = [];
  for (let i = 0; i < n; i++) {
    const h = (Math.imul(i, 2654435761) + 1013904223) >>> 0;
    parts.push(words[h % words.length]);
    if (i % 12 === 11) parts.push(".");
  }
  return parts.join(" ");
}

function warmupEngineAttempt() {
  return new Promise((resolve) => {
    const corpus = makeWarmupCorpus(WARMUP_TOKENS);
    const t0 = Date.now();
    const payload = JSON.stringify({
      model: "qwen3.8-27b",
      max_tokens: 16,
      messages: [{
        role: "user",
        content: `Document:\n${corpus}\n\nReply with a one-sentence summary.`,
      }],
    });

    const targetUrl = new URL(`${BASE_URL}/chat/completions`);
    const req = http.request(
      {
        hostname: targetUrl.hostname,
        port: targetUrl.port,
        path: targetUrl.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          Authorization: `Bearer ${getApiKeySync()}`,
        },
        timeout: WARMUP_TIMEOUT_MS,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return resolve({
              ok: false,
              error: `HTTP ${res.statusCode}: ${body.slice(0, 150)}`,
              seconds: Math.round((Date.now() - t0) / 1000),
            });
          }
          try {
            const j = JSON.parse(body);
            if ((j?.usage?.completion_tokens ?? 0) < 1) {
              return resolve({
                ok: false,
                error: "completion returned no tokens",
                seconds: Math.round((Date.now() - t0) / 1000),
              });
            }
            resolve({ ok: true, seconds: Math.round((Date.now() - t0) / 1000) });
          } catch (e) {
            resolve({
              ok: false,
              error: `invalid json: ${e.message}`,
              seconds: Math.round((Date.now() - t0) / 1000),
            });
          }
        });
      }
    );

    req.on("timeout", () => {
      req.destroy(new Error(`socket timed out after ${Math.round(WARMUP_TIMEOUT_MS / 1000)}s`));
    });

    req.on("error", (err) => {
      const errDetail = err?.cause?.message || err?.cause?.code || err?.code || err?.message || String(err);
      resolve({
        ok: false,
        error: String(errDetail),
        seconds: Math.round((Date.now() - t0) / 1000),
      });
    });

    req.write(payload);
    req.end();
  });
}

async function ensureEngineWarmed() {
  const state = await isEngineWarmed();
  if (state.warmed) return state;
  let lastError = state.reason ?? "unknown";
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = await warmupEngineAttempt();
    if (r.ok) {
      const m = await readEngineMetrics(0);
      const q = m?.["vllm:prefix_cache_queries_total"];
      // Never persist a zero/null marker: a later incarnation also reporting 0
      // would satisfy `current >= marker` and skip its own needed warmup.
      if (typeof q === "number" && q > 0) {
        try {
          fs.writeFileSync(WARMUP_MARKER_FILE, JSON.stringify({
            at: Date.now(),
            prefix_queries_total: q,
            tokens: WARMUP_TOKENS,
          }));
        } catch {}
      }
      return { warmed: true, attempts: attempt, warmSeconds: r.seconds };
    }
    lastError = r.error ?? "warmup-failed";

    // If client timed out or connection dropped, the engine may still be
    // finishing the prefill/JIT. Drain/wait up to 60s for running requests to drop.
    let drained = false;
    for (let d = 0; d < 12; d++) {
      const m = await readEngineMetrics(0);
      if ((m?.["vllm:num_requests_running"] ?? 0) === 0) {
        drained = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    // If drained cleanly and prefix queries grew, verify health via canary
    if (drained) {
      const mAfter = await readEngineMetrics(0);
      const qAfter = mAfter?.["vllm:prefix_cache_queries_total"];
      if (typeof qAfter === "number" && qAfter > 0) {
        const postCanary = await canaryProbe(true);
        if (postCanary.ok) {
          try {
            fs.writeFileSync(WARMUP_MARKER_FILE, JSON.stringify({
              at: Date.now(),
              prefix_queries_total: qAfter,
              tokens: WARMUP_TOKENS,
            }));
          } catch {}
          return { warmed: true, attempts: attempt, warmSeconds: r.seconds, recoveredFromDrain: true };
        }
      }
    }

    // A stalled warmup indicates the engine's prefill/JIT pipeline is degraded.
    // If auto-heal is enabled, reboot the engine unconditionally so the next attempt
    // starts on a pristine instance (even if a 1-token canary passes).
    const c = await canaryProbe(true);
    if (!c.ok || (AUTO_HEAL && attempt < 3)) {
      if (!AUTO_HEAL && !c.ok) return { warmed: false, error: `${lastError}; canary: ${c.error}` };
      if (AUTO_HEAL) {
        await healWedgedEngine(null);
        resetEngineHealthCache();
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
  }
  return { warmed: false, error: `${lastError} (3 attempts)` };
}

async function engineWedgeState() {
  const metrics = await readEngineMetrics();
  const canary = await canaryProbe();

  // Stats silence is retained as a secondary signal only (a busy-but-healthy
  // engine prints stats; a hung core goes quiet). The canary decides wedged.
  const line = await readLastEngineStatsLine();
  const stats = line ? parseEngineStats(line) : null;

  const gauges = metrics
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
    : null;

  return {
    wedged: !canary.ok,
    canary,
    gauges,
    stats: stats ?? null,
  };
}

// Wedge counter: persisted machine-wide (every surface spawns its own server
// process), surfaced via qwen_server status so A/B runs and production both
// produce comparable wedge-rate telemetry.
const WEDGE_COUNTER_FILE = path.join(TASK_DIR, ".wedge_counter.json");
function readWedgeCounter() {
  try {
    return JSON.parse(fs.readFileSync(WEDGE_COUNTER_FILE, "utf8"));
  } catch {
    return { count: 0, lastAt: null, lastReason: null };
  }
}
function bumpWedgeCounter(reason) {
  try {
    const cur = readWedgeCounter();
    cur.count = (cur.count ?? 0) + 1;
    cur.lastAt = Date.now();
    cur.lastReason = String(reason ?? "").slice(0, 200);
    fs.writeFileSync(WEDGE_COUNTER_FILE, JSON.stringify(cur));
  } catch {}
}

// Kill + reboot a wedged engine. Every Claude surface runs its own copy of this
// server process, so a stamp file (not an in-process lock) prevents two instances
// from double-rebooting vLLM within one boot budget.
async function healWedgedEngine(statsAgeSec) {
  let lock = null;
  try {
    lock = JSON.parse(fs.readFileSync(HEAL_LOCK_FILE, "utf8"));
  } catch {}
  if (lock && Date.now() - lock.at < HEAL_LOCK_TTL_MS) {
    return {
      healed: false,
      note: `heal already started ${Math.round((Date.now() - lock.at) / 1000)}s ago by pid ${lock.pid}; boot in progress`,
    };
  }
  try {
    fs.mkdirSync(TASK_DIR, { recursive: true });
    fs.writeFileSync(HEAL_LOCK_FILE, JSON.stringify({ at: Date.now(), pid: process.pid, statsAgeSec }));
    bumpWedgeCounter(`stats_age=${statsAgeSec}s`);
  } catch {}
  await stopServer();
  const res = await ensureServerRunning();
  // Gauges/canary may still be cached from the pre-restart engine - drop them.
  resetEngineHealthCache();
  return { healed: true, boot: res.status };
}

// Stale health data from a dead engine is worse than none (a cached "ok"
// canary would mask a fresh wedge for up to 60s). Called after stop/heal.
function resetEngineHealthCache() {
  canaryCache = { at: 0, result: null };
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
    const diskTask = readTaskFromDisk(taskId);
    if (diskTask) {
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

if (isMain) {
  statusHttpServer.listen(STATUS_PORT, "127.0.0.1", () => {});
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
    try {
      await withBootMutex(async () => {
        await ensureServerRunning();
      });
      // Ride out the first-large-prefill boot stall BEFORE the task runs -
      // otherwise the task itself becomes the stall victim (watchdog kill).
      const warm = await ensureEngineWarmed();
      if (!warm.warmed) {
        taskEntry.result = {
          isError: true,
          text: `Boot warmup failed after engine (re)start (${warm.error ?? warm.reason}) - engine may be unhealthy. Not dispatching into it.`,
        };
        taskEntry.done = true;
        taskEntry.isError = true;
        taskEntry.status = "failed";
        notifyWaiters(taskEntry);
        return taskEntry.result;
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
    finalTaskPrompt += `- Prefer native Goose tools (\`read\`, \`edit\`, \`write\`, \`patch\`, \`tree\`) over shell subprocesses for inspecting and modifying files for maximum efficiency.\n`;
    finalTaskPrompt += `- Target Scope: Focus directly on project workspace source files. Do NOT explore or read third-party dependency directories (e.g. \`node_modules\`, \`.venv\`, \`vendor\`, \`target\`) unless an explicit compilation or runtime error specifically requires inspecting a type declaration.\n`;
    finalTaskPrompt += `- Granular Turn Scope: Focus strictly on the 3-4 target files specified for this turn. Do not perform extraneous edits outside the requested scope.\n`;
    if (IS_WINDOWS && !cwdInWsl) {
      finalTaskPrompt += `- Windows Line Endings: Workspace files may use CRLF (\\r\\n). If \`edit\` or string replacement encounters matching issues, inspect exact line endings with \`read\` or write the normalized file.\n`;
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
      args.push("--output-format", "stream-json");
      if (system) {
        args.push("--system", system);
      }
      args.push("-t", finalTaskPrompt);
      for (const ext of extensions ?? []) {
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
            OPENAI_BASE_URL: "http://localhost:18020/v1",
            OPENAI_API_KEY: "dummy",
            WSLENV: "GOOSE_PROVIDER/u:GOOSE_MODEL/u:OPENAI_BASE_URL/u:OPENAI_API_KEY/u",
          };
          // --exec, NOT `--`: `wsl.exe -- <cmd>` runs the command line THROUGH
          // the default shell, so any backticks in the task prompt underwent
          // bash command substitution (the backtick-quoted goose tool names in
          // our directives were executed and replaced with empty strings - the
          // model never saw them, and its stderr was polluted with
          // "edit: command not found" from the spawn shell, not from the model).
          // --exec passes argv directly to the binary.
          child = spawn("wsl.exe", ["-d", "Ubuntu", "--cd", targetCwd, "--exec", "/home/apath/.local/bin/goose", ...args], {
            env: wslEnv,
            stdio: ["ignore", "pipe", "pipe"],
            detached: false,
          });
        } else {
          const gooseExe = getGooseExecutable();
          child = spawn(gooseExe, args, {
            cwd: targetCwd,
            env: {
              ...process.env,
              GOOSE_PROVIDER: "openai",
              GOOSE_MODEL: "qwen3.8-27b",
              OPENAI_BASE_URL: "http://localhost:18020/v1",
              OPENAI_API_KEY: "dummy",
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
            OPENAI_BASE_URL: "http://localhost:18020/v1",
            OPENAI_API_KEY: "dummy",
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
        taskEntry.streamBytes = (taskEntry.streamBytes || 0) + chunk.length;
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

        if (!receivedAnyOutput && inactiveMs >= FIRST_TOKEN_TIMEOUT_MS) {
          clearInterval(watchdog);
          killProcessTree(child);
          finish(
            true,
            `First-Token Timeout: Goose produced zero stream output for ${Math.round(inactiveMs / 1000)}s after spawn - the vLLM engine core is wedged or fully saturated. No work was performed. Check qwen_server status (engine stats silence >${WEDGE_STATS_SILENCE_S}s = wedged; auto-heal reboots it); safe to re-dispatch once healthy.`
          );
        } else if (inactiveMs >= INACTIVITY_TIMEOUT_MS) {
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
            `Total Budget Timeout: Reached maximum execution budget of ${Math.round(totalTimeoutMs / 1000)}s (${Math.round(totalTimeoutMs / 60000)} min).`
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
      "Primary agentic interface for local Qwen3.8-27B running inside the Goose agent harness for $0. " +
      "Has native access to Filesystem, Shell, and Git across Windows and WSL. Pure text-only model with Universal 245K context. " +
      "Executes multi-turn Socratic collaboration, codebase exploration, threat modeling, deep research, and AVO candidate mutations. " +
      "USAGE - conversational pair-programming is the primary mode:\n" +
      "  - Single Logical Concern per Turn: Scope mutation dispatches to ONE cohesive subsystem, layer, or component\n" +
      "    (e.g. 'Turn 2a: wrap server actions and Mastra tools') to maintain rapid 3-5 minute turn velocity (<= 6-8 tool calls).\n" +
      "  - Slicing Large Files (>300 LOC): Target specific function/AST slices rather than dumping entire files.\n" +
      "  - Session Lifecycle & Speculative Decoding (~20-25 tool call limit): Keep a `session_id` active for 2-3 focused turns,\n" +
      "    then roll to a fresh session_id (e.g. '<milestone>_stage2') to reset context, restore ~85% draft acceptance, and maintain ~75-85 tok/s decode velocity.\n" +
      "  - Budgets are generous by design (default 1h, 10-min floor; pass more for research+write+post).\n" +
      "    Split multi-stage jobs so a timeout can never land on the irreversible step (post/commit/deploy):\n" +
      "    persist artifacts to disk first, then a short follow-up dispatch executes the critical action.\n" +
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
      action: z.enum(["status", "cancel", "list"]).describe("Action to perform on background tasks"),
      task_id: z.string().optional().describe("Task ID (required for 'status' and 'cancel')"),
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
      if (memTask && !memTask.done && memTask.child) {
        killProcessTree(memTask.child);
        memTask.status = "cancelled";
        memTask.done = true;
        memTask.isError = true;
        memTask.result = { isError: true, text: `Task ${task_id} was cancelled by caller.` };
        notifyWaiters(memTask);
        return {
          content: [{ type: "text", text: `Task \`${task_id}\` cancelled and process tree killed.` }],
        };
      }
      const diskTask = readTaskFromDisk(task_id);
      if (diskTask && !diskTask.done) {
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
      "Check status, start, or stop the universal 245K context vLLM server in WSL Ubuntu. Status includes live engine gauges from /metrics (running/waiting requests, KV cache %, prefix-cache hit ratio, spec-decode acceptance) and an end-to-end canary completion - the port answering is NOT proof of health, and stats silence cannot see every wedge class (2026-08-29: API-to-core stall with empty queues and 200 answers). A failed canary means wedged; auto-reboots unless QWEN_AUTO_HEAL=0. qwen_coworker dispatches run the same gate before every task.",
    inputSchema: {
      action: z.enum(["status", "start", "stop"]).describe("Lifecycle action to perform"),
    },
  },
  async ({ action }) => {
    if (action === "status") {
      const info = await serverInfo();
      const running = !!info;
      const wedge = running ? await engineWedgeState() : { wedged: false, stats: null };
      let autoHeal = null;
      if (running && wedge.wedged && AUTO_HEAL) {
        try {
          autoHeal = await healWedgedEngine(wedge.stats.ageSec);
        } catch (err) {
          autoHeal = { healed: false, error: err.message };
        }
      }
      const statusLabel = !running
        ? "stopped"
        : wedge.wedged
          ? autoHeal?.healed
            ? "wedged_restarted"
            : "wedged"
          : "running";
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                status: statusLabel,
                endpoint: BASE_URL,
                max_model_len: running ? info.maxModelLen : null,
                context_window_nominal: MAX_LEN_HUGE,
                stack: "vLLM + DFlash2 + KVarN (Universal 245K)",
                engine: running
                  ? {
                      running_requests: wedge.gauges?.running_requests ?? null,
                      waiting_requests: wedge.gauges?.waiting_requests ?? null,
                      kv_cache_pct: wedge.gauges?.kv_cache_pct ?? null,
                      prefix_cache_hit_ratio: wedge.gauges?.prefix_cache_hit_ratio ?? null,
                      spec_decode_acceptance: wedge.gauges?.spec_decode_acceptance ?? null,
                      canary: wedge.canary,
                      engine_stats_age_seconds: wedge.stats?.ageSec ?? null,
                      wedge_detected: wedge.wedged,
                      wedge_threshold_seconds: WEDGE_STATS_SILENCE_S,
                      auto_heal: autoHeal,
                    }
                  : null,
                status_endpoint: `http://127.0.0.1:${STATUS_PORT}`,
                status_endpoint_owned_by_this_instance: statusServerOwned,
                wedge_counter: readWedgeCounter(),
                boot_warmup: readWarmupMarker() ?? { warmed: false },
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
            text: JSON.stringify({ status: "running", result: res.status, heal: res.heal ?? null, endpoint: BASE_URL, context: MAX_LEN_HUGE }, null, 2),
          },
        ],
      };
    }
    if (action === "stop") {
      await stopServer();
      resetEngineHealthCache();
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

// Exported for test_global_semaphore.js - importing this module runs the MCP
// server on stdio, which the test processes simply leave idle.
export { acquireGooseSlot, releaseGooseSlot, listGooseSlots, TASK_DIR };

if (isMain) {
  main().catch((err) => {
    console.error("MCP Server Fatal Error:", err);
    process.exit(1);
  });
}
