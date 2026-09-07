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
import { pidAlive, listGooseSlots, clearReclaimableGooseSlots } from "./semaphore.js";
import { killProcessTree, killGooseSessionSync } from "./wsl_bridge.js";

try {
  fs.mkdirSync(TASK_DIR, { recursive: true });
} catch {}

export const tasks = new Map();

export function saveTaskToDisk(task) {
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
  return diskTask;
}

export function readTaskFromDisk(taskId) {
  try {
    const filePath = path.join(TASK_DIR, `${taskId}.json`);
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (parsed && !parsed.done && isTaskOrphaned(parsed)) {
        return markTaskOrphanedOnDisk(parsed);
      }
      return parsed;
    }
  } catch (err) {
    if (err && (err.code === "EBUSY" || err.code === "EPERM")) {
      return { transientLock: true, id: taskId };
    }
  }
  return null;
}

export function listTasksFromDisk() {
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
            try {
              fs.unlinkSync(filePath);
            } catch {}
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
  setInterval(cleanOldTasks, 300_000).unref();
}
