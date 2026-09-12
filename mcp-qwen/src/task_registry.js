import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import {
  TASK_DIR,
  STATUS_PORT,
  TASK_RETENTION_MS,
  DEFAULT_TIMEOUT_MS,
  INACTIVITY_TIMEOUT_MS,
} from "./config.js";
import {
  pidAlive,
  listGooseSlots,
  clearReclaimableGooseSlots,
  releaseGooseSlot,
} from "./semaphore.js";
import { killProcessTree, killGooseSessionSync } from "./wsl_bridge.js";
import { EventLoggerService } from "./harness/services/event_logger.js";

try {
  fs.mkdirSync(TASK_DIR, { recursive: true });
} catch {}

export const tasks = new Map();

export function saveTaskToDisk(task) {
  if (!task || !task.id) return;
  const filePath = path.join(TASK_DIR, `${task.id}.json`);
  try {
    const tmpPath = `${filePath}.tmp_${process.pid}_${Date.now()}`;
    const payload = {
      id: task.id,
      sessionId: task.sessionId,
      cwd: task.cwd,
      prompt: task.prompt,
      // Effective reasoning-effort tier for this task (per-dispatch param when
      // provided, else the QWEN_REASONING_EFFORT env default). Persisted for
      // telemetry; undefined when the task predates the field.
      reasoningEffort: task.reasoningEffort ?? null,
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
  } catch (err) {
    // Telemetry persistence must never throw into the runner, but it must not
    // be invisible either: a failed save (disk full, EBUSY, permission) is a
    // real signal — log the path and the error to stderr and continue.
    const msg = err && err.message ? err.message : String(err);
    console.error(`[task_registry] Failed to save task ${task.id} to ${filePath}: ${msg}`);
  }
}

export function isTaskOrphaned(diskTask) {
  if (!diskTask || diskTask.done) return false;
  if (diskTask.ownerPid && !pidAlive(diskTask.ownerPid)) return true;
  const lastActive = diskTask.lastHeartbeatAt || diskTask.startedAt || diskTask.createdAt;
  if (lastActive && Date.now() - lastActive > 300_000) {
    if (!diskTask.ownerPid || !pidAlive(diskTask.ownerPid)) return true;
  }
  return false;
}

export function markTaskOrphanedOnDisk(diskTask) {
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
  // Orphaned tasks must leave a terminal trace in the session event log.
  // Without this, a session killed by an external process-tree death (the MCP
  // server instance dying and taking its child runner with it) ends with NO
  // session_end/session_error — undetectable after the fact except by absence
  // (verified in production: session pattern_test_s1, 2026-09-11 10:12:47Z).
  // Append a single-line terminal event so the silent infra death is detectable.
  appendOrphanTerminalEvent(diskTask);
  return diskTask;
}

/**
 * Appends a single-line terminal `session_error` event to the orphaned task's
 * session events.jsonl so a silent infra death (external process-tree kill)
 * leaves a detectable trace.
 *
 * Cross-instance safe: the detecting instance may differ from the owning
 * instance (shared state dir). We only ever APPEND one line (appendFileSync)
 * and never rewrite existing content. The double-terminal guard
 * (hasTerminalEvent) ensures a session that already ended (session_end or
 * session_error) is not given a second terminal event.
 *
 * Never throws: a failure to append the trace must not break the (already
 * working) orphan-marking of the task file.
 */
function appendOrphanTerminalEvent(diskTask) {
  if (!diskTask || !diskTask.sessionId) return;
  try {
    const logger = new EventLoggerService({ sessionId: diskTask.sessionId });
    // Double-terminal guard: if the session already has a terminal event, do
    // not append a second one.
    if (logger.hasTerminalEvent()) return;
    logger.append({
      type: "session_error",
      reason: "orphaned",
      detail: describeOrphanCause(diskTask),
      taskId: diskTask.id,
      ownerPid: diskTask.ownerPid || null,
    });
  } catch (err) {
    // Honest, non-fatal: the trace is best-effort. The task file is already
    // marked orphaned (the primary signal). Log and continue.
    const msg = err && err.message ? err.message : String(err);
    console.error(
      `[task_registry] Failed to append orphan terminal event for session ${diskTask.sessionId}: ${msg}`
    );
  }
}

/**
 * Honest, human-readable description of WHY the task was orphaned (the owner
 * pid state), for the terminal event's `detail` field.
 */
function describeOrphanCause(diskTask) {
  const pid = diskTask.ownerPid;
  if (pid) {
    if (!pidAlive(pid)) {
      return `owner pid ${pid} is dead (process exited or was killed)`;
    }
    return `owner pid ${pid} is alive but heartbeat is stale`;
  }
  return `no owner pid recorded; heartbeat is stale`;
}

/**
 * Quarantines a corrupt/unreadable task file by renaming it to
 * `<name>.corrupt-<epochms>` (the LineageDag quarantine pattern) and logs
 * loudly to stderr. Returns the underlying error message. Shared by
 * readTaskFromDisk (single read) and listTasksFromDisk (bulk read) so BOTH
 * surface corruption identically instead of silently swallowing it.
 *
 * D11 (FX6): a corrupt file is a real signal, never conflated with a clean
 * not-found. It is preserved (renamed, not deleted) so it can be inspected,
 * and the corruption is announced on stderr.
 */
function quarantineCorruptTaskFile(filePath, err) {
  const msg = err && err.message ? err.message : String(err);
  const corruptBackup = `${filePath}.corrupt-${Date.now()}`;
  console.error(
    `[task_registry] Corrupt task file ${filePath}: ${msg}. Quarantining to ${corruptBackup}.`
  );
  try {
    fs.renameSync(filePath, corruptBackup);
  } catch (qerr) {
    // The rename itself failed (e.g. the file vanished between the read and
    // the rename, or a transient lock). The corruption is still surfaced via
    // the stderr log and the returned message; we do not fabricate a success.
    console.error(
      `[task_registry] Failed to quarantine ${filePath}: ${
        qerr && qerr.message ? qerr.message : String(qerr)
      }`
    );
  }
  return msg;
}

/**
 * Reads a single task from disk, distinguishing the signals honestly:
 *   - file ABSENT             -> null (clean not-found)
 *   - transient file lock     -> { transientLock: true, id } (EBUSY/EPERM;
 *                                 the worker is mid-write; retry next tick)
 *   - file CORRUPT/unreadable -> { corrupted: true, id, file, error }
 *                                 (the file is QUARANTINEd and a loud
 *                                 stderr log is emitted)
 *   - healthy file            -> the parsed task object
 *
 * D11 (FX6): the old code returned null for BOTH "absent" and "corrupt", so
 * a corrupt task file was reported as "task not found" (and, in the wait
 * path, as "failed") — dishonest. Now a corrupt file is an explicit
 * corruption signal: quarantined, logged loudly, and surfaced to the caller
 * as a distinguishable result, never conflated with a clean not-found.
 */
export function readTaskFromDisk(taskId) {
  const filePath = path.join(TASK_DIR, `${taskId}.json`);
  if (!fs.existsSync(filePath)) {
    return null; // clean not-found
  }
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if (err && (err.code === "EBUSY" || err.code === "EPERM")) {
      // Transient Windows file lock while the worker is mid-write: a real
      // signal, not corruption. The caller retries on the next tick.
      return { transientLock: true, id: taskId };
    }
    // Unreadable for a non-transient reason: corruption.
    const msg = quarantineCorruptTaskFile(filePath, err);
    return { corrupted: true, id: taskId, file: filePath, error: msg };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // Unparseable: corruption.
    const msg = quarantineCorruptTaskFile(filePath, err);
    return { corrupted: true, id: taskId, file: filePath, error: msg };
  }
  if (parsed && !parsed.done && isTaskOrphaned(parsed)) {
    return markTaskOrphanedOnDisk(parsed);
  }
  return parsed;
}

/**
 * Lists all on-disk tasks, applying retention cleanup.
 *
 * D11 (FX6): a corrupt/unreadable file is no longer silently skipped (the old
 * `catch {}` swallowed it, so a corrupt task vanished from the list with no
 * signal). Now each corrupt file is QUARANTINEd and logged loudly to stderr
 * (same helper as readTaskFromDisk); a transient lock (EBUSY/EPERM) is still
 * skipped for this tick (the worker is mid-write) but is a distinct, honest
 * case. The returned list contains only healthy, parseable tasks.
 *
 * Retention cleanup also reaps orphaned `task_*.json.tmp_<pid>_<ts>` files
 * (a saveTaskToDisk whose writeFileSync succeeded but whose renameSync never
 * ran). Those orphans never match the `.json` filter, so without this they
 * accumulate forever; the same mtime age gate reaps them (their lifetime is
 * sub-second, so the gate is sufficient).
 */
export function listTasksFromDisk() {
  const result = [];
  let files;
  try {
    files = fs.readdirSync(TASK_DIR);
  } catch {
    return result; // TASK_DIR unreadable this tick: return what we have.
  }
  const now = Date.now();
  for (const f of files) {
    // Match healthy task JSON files AND orphaned tmp files. A tmp file is
    // `<task>.json.tmp_<pid>_<ts>` — the leftover of a saveTaskToDisk whose
    // writeFileSync succeeded but whose renameSync never ran (the old catch{}
    // swallowed that failure, so these orphans accumulated forever). The tmp
    // lifetime is sub-second, so the same mtime age gate reaps them.
    const isTmpOrphan = /^task_.*\.json\.tmp_\d+_\d+$/.test(f);
    if (!f.endsWith(".json") && !isTmpOrphan) continue;
    const filePath = path.join(TASK_DIR, f);
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue; // vanished between readdir and stat
    }
    if (now - stat.mtimeMs > TASK_RETENTION_MS) {
      try {
        fs.unlinkSync(filePath);
      } catch {}
      continue;
    }
    if (isTmpOrphan) continue; // within retention: leave it (sub-second, ages out)
    let raw;
    try {
      raw = fs.readFileSync(filePath, "utf8");
    } catch (err) {
      if (err && (err.code === "EBUSY" || err.code === "EPERM")) continue; // transient lock
      quarantineCorruptTaskFile(filePath, err);
      continue;
    }
    let task;
    try {
      task = JSON.parse(raw);
    } catch (err) {
      quarantineCorruptTaskFile(filePath, err);
      continue;
    }
    result.push(task);
  }
  return result;
}

/**
 * Returns true when live work is in flight and the engine must NOT be
 * stopped/rebooted. Used as the heal gatekeeper:
 *  - any in-memory task with status "running"/"queued" (not done), OR
 *  - any disk task that is not done, whose owner pid is alive, and whose
 *    last heartbeat is within INACTIVITY_TIMEOUT_MS.
 */
export function hasLiveWork() {
  for (const t of tasks.values()) {
    if (!t.done && (t.status === "running" || t.status === "queued")) return true;
  }
  const now = Date.now();
  for (const dt of listTasksFromDisk()) {
    if (dt.done) continue;
    if (!dt.ownerPid || !pidAlive(dt.ownerPid)) continue;
    const lastActive = dt.lastHeartbeatAt || dt.startedAt || dt.createdAt;
    if (lastActive && now - lastActive <= INACTIVITY_TIMEOUT_MS) return true;
  }
  return false;
}

export function cleanOldTasks() {
  const now = Date.now();
  for (const [id, task] of tasks.entries()) {
    if (task.done && now - task.createdAt > TASK_RETENTION_MS) {
      tasks.delete(id);
    }
  }
  listTasksFromDisk(); // Triggers disk retention cleanup
}

export function notifyWaiters(task) {
  saveTaskToDisk(task);
  if (!task.waiters || task.waiters.length === 0) return;
  const payload =
    task.result?.text ||
    (task.isError ? "Task failed." : "Task completed with no output.");
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

export async function cancelAllTasks(reason = "cancelled by caller") {
  let count = 0;
  // 1. Cancel in-memory tasks and notify waiters
  // P15: collect the session ids of the in-memory tasks we cancel here so the
  // anchored sweep below reaches their goose children too.
  const memSessionIds = new Set();
  for (const task of tasks.values()) {
    if (!task.done) {
      if (task.child) {
        killProcessTree(task.child, task.sessionId);
        task.child = null;
      }
      if (task.abortController) {
        try {
          task.abortController.abort();
        } catch {}
        task.abortController = null;
      }
      // FX5-A (D6): release the task's goose slot immediately on cancel.
      // releaseGooseSlot is idempotent, so a cancel landing after natural
      // completion (slot already freed by runQueued's finally) is a no-op.
      if (task.slot) {
        releaseGooseSlot(task.slot);
        task.slot = null;
      }
      task.status = "cancelled";
      task.done = true;
      task.isError = true;
      task.finishedAt = Date.now();
      task.result = { isError: true, text: `Task ${task.id} was ${reason}.` };
      saveTaskToDisk(task);
      notifyWaiters(task);
      count++;
      if (task.sessionId) memSessionIds.add(task.sessionId);
    }
  }

  // 2. Cancel disk tasks
  // P15: collect the session ids of the disk tasks we cancel here.
  const diskSessionIds = new Set();
  for (const diskTask of listTasksFromDisk()) {
    if (!diskTask.done) {
      diskTask.status = "cancelled";
      diskTask.done = true;
      diskTask.isError = true;
      diskTask.finishedAt = Date.now();
      diskTask.result = { isError: true, text: `Task ${diskTask.id} was ${reason}.` };
      saveTaskToDisk(diskTask);
      count++;
      if (diskTask.sessionId) diskSessionIds.add(diskTask.sessionId);
    }
  }

  // 3. P15: anchored per-session sweep instead of a machine-wide
  // `pkill -9 -f "goose run"` / `taskkill /F /IM goose.exe`. The old
  // machine-wide kill violated the multi-instance rule (it killed OTHER
  // instances' live goose children and wiped their slot leases). The anchored
  // sweep (pgrep -> /proc cmdline boundary verify -> kill) only matches a
  // session id at an exact `--name <id>` boundary, so substring decoys and
  // other instances' sessions survive. Sync kills are fast; cancel_all still
  // returns promptly.
  const sweepIds = new Set([...memSessionIds, ...diskSessionIds]);
  for (const sessionId of sweepIds) {
    try {
      killGooseSessionSync(sessionId);
    } catch {}
  }

  // 4. Clean up slot lease locks (only this process's own or dead owners'
  // leases — never another live instance's lease)
  clearReclaimableGooseSlots();

  return count;
}

export let statusServerOwned = false;

export const statusHttpServer = http.createServer((req, res) => {
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
        streamTail: (t.streamTail || "")
          .replace(/["\\{}\[\]]|type|message|content|delta|thinking|text/g, " ")
          .replace(/\s+/g, " ")
          .slice(-150),
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
      if (diskTask && diskTask.corrupted) {
        // D11 (FX6): a corrupt task file is an explicit corruption signal,
        // never conflated with a clean not-found. Surface it as a 500 with
        // the file and the parse error.
        res.writeHead(500, { "Content-Type": "application/json" });
        return res.end(
          JSON.stringify({
            found: true,
            id: taskId,
            corrupted: true,
            file: diskTask.file,
            error: `Task file corrupted: ${diskTask.error}`,
          })
        );
      }
      if (!diskTask) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        return res.end(`Task not found: ${taskId}`);
      }
    }

    const isDone = task ? task.done : diskTask.done;
    const isError = task ? task.isError : diskTask.isError;
    const resText =
      (task ? task.result?.text : diskTask.result?.text) ||
      (isError ? "Task failed." : "Task completed.");

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
    let absentTicks = 0;
    const diskPoll = setInterval(() => {
      const current = readTaskFromDisk(taskId);
      if (current?.transientLock) {
        // Transient Windows file lock (EBUSY/EPERM) during worker saveTaskToDisk.
        // Worker is actively writing; skip tick and continue polling.
        return;
      }
      if (current?.corrupted) {
        // D11 (FX6): the task file is corrupt. End the wait with an explicit
        // corruption signal (500) naming the file and the parse error — never
        // debounced into a fabricated "Task failed."
        clearInterval(diskPoll);
        try {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              id: taskId,
              corrupted: true,
              file: current.file,
              error: `Task file corrupted: ${current.error}`,
            })
          );
        } catch {}
        return;
      }

      if (!current) {
        absentTicks++;
        // Debounce: require 3 consecutive absent ticks (6 seconds) before treating as missing/failed
        if (absentTicks < 3) {
          return;
        }
      } else {
        absentTicks = 0;
      }

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
    if (task && task.corrupted) {
      // D11 (FX6): a corrupt task file is an explicit corruption signal,
      // never conflated with a clean not-found. Surface it as a 500 with the
      // file and the parse error.
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(
        JSON.stringify({
          found: true,
          id: taskId,
          corrupted: true,
          file: task.file,
          error: `Task file corrupted: ${task.error}`,
        })
      );
    }
    if (!task) {
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ found: false, id: taskId }));
    }
    const now = Date.now();
    const elapsed_s = Math.round(((task.finishedAt || now) - task.createdAt) / 1000);
    const lastActivitySecAgo = task.lastActivityAt
      ? Math.max(0, Math.round((now - task.lastActivityAt) / 1000))
      : null;
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
          reasoningEffort: task.reasoningEffort ?? null,
          elapsed_s,
          startedAt: task.startedAt,
          lastActivitySecAgo,
          streamBytes: task.streamBytes || 0,
          streamTail: (task.streamTail || "")
            .replace(/["\\{}\[\]]|type|message|content|delta|thinking|text/g, " ")
            .replace(/\s+/g, " ")
            .slice(-250),
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
        // P10: trigger the native runner's abort signal so the in-flight
        // LLM call stops and the runner's finally block disposes the MCP
        // extension bridge (no leaked children). For a native task
        // `task.child` is null, so this is the only way to stop it.
        if (task.abortController) {
          try {
            task.abortController.abort();
          } catch {}
        }
        // FX5-A (D6): release the task's goose slot immediately on cancel
        // (idempotent — a cancel after natural completion is a no-op).
        if (task.slot) {
          releaseGooseSlot(task.slot);
          task.slot = null;
        }
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
    if (diskTask && diskTask.corrupted) {
      // D11 (FX6): a corrupt task file is an explicit corruption signal.
      // There is no live task to cancel (the file is already quarantined);
      // surface the corruption as a 500 rather than fabricating a cancel.
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(
        JSON.stringify({
          cancelled: false,
          id: taskId,
          corrupted: true,
          file: diskTask.file,
          error: `Task file corrupted: ${diskTask.error}`,
        })
      );
    }
    if (diskTask) {
      if (diskTask.sessionId) {
        // P15: anchored sweep (pgrep -> /proc cmdline boundary verify -> kill)
        // instead of a raw unanchored `pkill -9 -f` — a session id that is a
        // substring of another session's id must never be over-killed.
        try {
          killGooseSessionSync(diskTask.sessionId);
        } catch {}
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
  if (
    (req.method === "POST" || req.method === "DELETE") &&
    (pathname === "/tasks/cancel" || pathname === "/tasks/cancel_all")
  ) {
    cancelAllTasks("cancelled via HTTP coordinator")
      .then((count) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ cancelled: true, count }));
      })
      .catch((err) => {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ cancelled: false, error: err.message }));
      });
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

statusHttpServer.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    statusServerOwned = false;
  } else {
    console.error("Status HTTP Server Error:", err);
  }
});

// ---------------------------------------------------------------------------
// FX3-B (F1) — status-server keeper re-election
// ---------------------------------------------------------------------------
//
// The status server is a single machine-wide coordinator on STATUS_PORT.
// Exactly one process (the "keeper") owns the port; every other process is a
// "follower". At boot, initStatusServer() does a ONE-SHOT listen: the first
// process to win the port becomes keeper, the rest become followers.
//
// The defect (F1): a follower that lost the boot race set statusServerOwned=
// false FOREVER. If the keeper process later exited, the port went dark
// permanently while task dispatches kept advertising a wait_command URL on it
// (live-observed). The fix is a re-election protocol, in the same honest-
// signal style as the stream proxy's identity verification:
//
//   * The /health endpoint already self-identifies:
//       {"status":"ok","service":"mcp-qwen-status","port":STATUS_PORT}
//     so a follower can tell OUR service from a foreign one.
//   * A follower periodically probes /health. If the port is DARK (connection
//     refused / timeout), the follower attempts to re-listen. If the responder
//     is OUR identity, it stays a follower. If the responder is a FOREIGN
//     identity, it stays a follower and reports loudly — it never fights a
//     foreign process for the port (stream-proxy PortConflictError doctrine).
//   * The re-listen is a SINGLE atomic listen() call. The OS grants the port
//     to exactly one process, so with N client processes at most one wins the
//     election; the losers get EADDRINUSE and remain followers. This is the
//     thundering-herd guard: no lockfile, no coordination channel — the port
//     itself is the atomic arbiter.
//
//   This is NOT a fallback. A failed re-listen (EADDRINUSE) is an honest
//   "someone else owns the port" signal, and we keep polling — the election
//   protocol working as designed. We never fabricate ownership: statusServer-
//   Owned becomes true ONLY when our own listen() callback fires.
//
// The OWNER path is unchanged: initStatusServer() still does the one-shot
// boot listen, and a process that wins at boot never runs the election.

// The identity our /health endpoint advertises. A responder with this exact
// service string is a healthy keeper of OUR service; anything else is foreign.
export const STATUS_SERVICE_IDENTITY = "mcp-qwen-status";

// How often a follower re-probes the port. ~60s keeps the test suite fast
// (tests inject a shorter interval) while bounding real-world dark-port
// recovery to a minute.
const STATUS_ELECTION_INTERVAL_MS = 60_000;
// Per-probe fetch timeout. A dark port (connection refused) fails fast; this
// only bounds a half-open / black-holed socket.
const STATUS_ELECTION_PROBE_TIMEOUT_MS = 2_000;

/**
 * Pure election decision. Given the raw /health body (or null when the port
 * is dark / the probe failed) and whether we currently own the port, decide
 * what to do. Exported as a pure function so it can be unit-tested without
 * any socket or timer.
 *
 * @param {object|null} healthBody parsed /health JSON, or null when dark.
 * @param {boolean} owned whether this process currently owns the port.
 * @returns {"stay"|"takeover"|"foreign"}
 *   "stay"     = keep the current role (owner, or our live keeper holds it);
 *   "takeover" = the port is dark — attempt re-listen;
 *   "foreign"  = a non-Anser process holds the port — never fight it; report
 *                loudly and stay a follower.
 */
export function decideElection(healthBody, owned) {
  // Owner path: never re-elect. The one-shot boot listen is the owner's
  // contract; it is left exactly as-is.
  if (owned) return "stay";
  // Follower: a dark port (null) means the keeper is gone — take over.
  if (healthBody === null) return "takeover";
  // A healthy responder with OUR identity is a live keeper — stay follower.
  if (healthBody && healthBody.service === STATUS_SERVICE_IDENTITY) return "stay";
  // A FOREIGN service occupies the port. We never fight a foreign process
  // for the port (same doctrine as the stream proxy's PortConflictError on
  // unverified alien listeners): the tick reports it loudly and stays a
  // follower, re-probing so we can take over the moment the port frees.
  return "foreign";
}

/**
 * Probe the status port's /health endpoint. Returns the parsed JSON body, or
 * null when the port is dark (connection refused / timeout / non-2xx /
 * unparseable). Never throws.
 *
 * @param {number} [port] defaults to STATUS_PORT.
 * @param {number} [timeoutMs] defaults to STATUS_ELECTION_PROBE_TIMEOUT_MS.
 * @returns {Promise<object|null>}
 */
export async function probeStatusHealth(port = STATUS_PORT, timeoutMs = STATUS_ELECTION_PROBE_TIMEOUT_MS) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const text = await res.text();
    const body = JSON.parse(text);
    return body && typeof body === "object" ? body : null;
  } catch {
    // Connection refused / timeout / bad JSON: the port is dark for our
    // purposes. This is a real signal (keeper gone), not an error to swallow.
    return null;
  }
}

/**
 * Attempt a single atomic re-listen on the status port. Returns true if this
 * process won the election (became keeper), false if the port is still held
 * by someone else (EADDRINUSE) or the listen failed for another reason.
 *
 * The listen() call is the atomic arbiter: the OS grants the port to exactly
 * one process, so concurrent callers cannot both win.
 *
 * @param {number} [port] defaults to STATUS_PORT.
 * @returns {Promise<boolean>}
 */
export function attemptStatusReListen(port = STATUS_PORT) {
  return new Promise((resolve) => {
    let settled = false;
    let onErr = null;
    const done = (won) => {
      if (settled) return;
      settled = true;
      if (onErr) statusHttpServer.removeListener("error", onErr);
      resolve(won);
    };
    try {
      onErr = (err) => {
        if (err && err.code === "EADDRINUSE") {
          done(false); // someone else owns it — remain follower
        } else {
          // A non-EADDRINUSE error: do not claim ownership. Log it (honest
          // signal) and stay a follower; the next tick will re-probe.
          console.error("[status-election] re-listen error:", err);
          done(false);
        }
      };
      statusHttpServer.once("error", onErr);
      statusHttpServer.listen(port, "127.0.0.1", () => {
        statusServerOwned = true; // we won the election — we are keeper
        done(true);
      });
    } catch (err) {
      if (err && err.code === "EADDRINUSE") {
        done(false);
      } else {
        console.error("[status-election] re-listen threw:", err);
        done(false);
      }
    }
  });
}

/**
 * Start the follower re-election loop. Only meaningful when this process is
 * a follower (statusServerOwned === false after the boot listen). The timer
 * is .unref()ed so it never keeps the process alive.
 *
 * @param {object} [opts]
 * @param {number} [opts.intervalMs] probe interval (default 60s).
 * @param {number} [opts.port] status port (default STATUS_PORT).
 * @returns {NodeJS.Timeout|null} the unref'd interval, or null if we are
 *   already the owner (nothing to elect).
 */
export function startStatusServerElection({
  intervalMs = STATUS_ELECTION_INTERVAL_MS,
  port = STATUS_PORT,
} = {}) {
  // Owner path: nothing to do. The one-shot boot listen already won.
  if (statusServerOwned) return null;

  const tick = async () => {
    // If we became owner some other way (or a prior tick won), stop.
    if (statusServerOwned) {
      clearInterval(timer);
      return;
    }
    const body = await probeStatusHealth(port);
    const verdict = decideElection(body, statusServerOwned);
    if (verdict === "takeover") {
      const won = await attemptStatusReListen(port);
      if (won) {
        clearInterval(timer); // we are keeper now — stop the election loop
      }
      // If we did not win, remain a follower and let the next tick re-probe.
    } else if (verdict === "foreign") {
      // Honest, recurring signal (follower-only, unref'd timer): a non-Anser
      // process holds the status port. We do not fight it; each tick says so
      // until the situation resolves.
      console.error(
        `[status-election] foreign service on 127.0.0.1:${port} (service=${body && body.service}): not ours; staying follower`
      );
    }
  };

  const timer = setInterval(() => {
    // Fire-and-forget each tick; a slow probe must not block the next.
    tick().catch((err) => {
      // A probe/listen failure is a real signal, not a crash. Log it and
      // keep the election alive on the next tick.
      console.error("[status-election] tick error:", err);
    });
  }, intervalMs);
  timer.unref(); // never hold the process open
  return timer;
}

export function initStatusServer() {
  try {
    statusHttpServer.listen(STATUS_PORT, "127.0.0.1", () => {
      statusServerOwned = true;
    });
  } catch (err) {
    if (err.code === "EADDRINUSE") {
      statusServerOwned = false;
    }
  }
  // FX3-B (F1): if the boot listen did NOT win the port (we are a follower),
  // start the re-election loop so we can take over the status port if the
  // current keeper later exits. The owner path (statusServerOwned true) is
  // left exactly as-is — startStatusServerElection returns null for it.
  if (!statusServerOwned) {
    startStatusServerElection();
  }
  setInterval(cleanOldTasks, 300_000).unref();
}
