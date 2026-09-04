import fs from "node:fs";
import path from "node:path";
import {
  TASK_DIR,
  SLOTS_DIR,
  MAX_CONCURRENT_GOOSE,
  SLOT_HEARTBEAT_MS,
  SLOT_WEDGED_MS,
  SLOT_POLL_MS,
} from "./config.js";

/**
 * Checks whether a given PID is currently alive on the host.
 */
export function pidAlive(pid) {
  if (!pid) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0); // signal 0 = liveness probe, no signal sent
    return true;
  } catch (err) {
    return err.code === "EPERM"; // EPERM = exists, just owned by another user
  }
}

export function slotFilePath(i) {
  return path.join(SLOTS_DIR, `slot_${i}.json`);
}

export function readLease(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function leaseReclaimable(lease) {
  if (!lease) return true; // unreadable = crashed mid-write
  // If the claiming process is dead, reclaim the slot immediately
  if (!pidAlive(lease.pid)) return true;
  const age = Date.now() - (lease.hb ?? lease.at ?? 0);
  return age > SLOT_WEDGED_MS;
}

/**
 * Acquires a global cross-process goose slot lease.
 * Resolves with {file, refresh} once a slot is held, or null if the task was
 * cancelled while waiting.
 */
export async function acquireGooseSlot(taskEntry) {
  try {
    fs.mkdirSync(SLOTS_DIR, { recursive: true });
  } catch {}

  for (;;) {
    if (taskEntry?.done) return null;
    for (let i = 0; i < MAX_CONCURRENT_GOOSE; i++) {
      const file = slotFilePath(i);
      const claim = {
        pid: process.pid,
        taskId: taskEntry?.id ?? null,
        at: Date.now(),
        hb: Date.now(),
      };
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
            fs.writeFileSync(
              file,
              JSON.stringify({ ...(cur ?? claim), pid: process.pid, hb: Date.now() })
            );
          } catch {}
        }, SLOT_HEARTBEAT_MS);
        refresh.unref();
        return { file, refresh };
      } catch (err) {
        if (err.code !== "EEXIST") continue; // transient fs error: try next slot
        const lease = readLease(file);
        if (!leaseReclaimable(lease)) continue;
        // Reclaim: atomic rename
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

/**
 * Releases a held goose slot lease.
 */
export function releaseGooseSlot(slot) {
  if (!slot) return;
  clearInterval(slot.refresh);
  try {
    const cur = readLease(slot.file);
    if (!cur || cur.pid === process.pid || !pidAlive(cur.pid)) {
      fs.rmSync(slot.file, { force: true });
    }
  } catch {}
}

/**
 * Returns active (non-reclaimable) leases across all instances for status reporting.
 */
export function listGooseSlots() {
  const out = [];
  for (let i = 0; i < MAX_CONCURRENT_GOOSE; i++) {
    const file = slotFilePath(i);
    const lease = readLease(file);
    if (lease && !leaseReclaimable(lease)) out.push(lease);
  }
  return out;
}

/**
 * Clears all lingering slot lease locks in ~/.qwen/tasks/goose_slots/.
 */
export function clearAllGooseSlots() {
  try {
    if (fs.existsSync(SLOTS_DIR)) {
      for (const f of fs.readdirSync(SLOTS_DIR)) {
        if (f.startsWith("slot_") && f.endsWith(".json")) {
          fs.rmSync(path.join(SLOTS_DIR, f), { force: true });
        }
      }
    }
  } catch {}
}

/**
 * Runs a function within an acquired global goose slot.
 */
export async function runQueued(fn, taskEntry, onStart) {
  const slot = await acquireGooseSlot(taskEntry);
  if (!slot) {
    return (
      taskEntry?.result ?? {
        isError: true,
        text: "Task cancelled before acquiring a goose slot.",
      }
    );
  }
  if (taskEntry?.done || taskEntry?.status === "cancelled") {
    releaseGooseSlot(slot);
    return (
      taskEntry?.result ?? {
        isError: true,
        text: "Task cancelled before execution.",
      }
    );
  }
  if (taskEntry && !taskEntry.done) {
    taskEntry.status = "executing";
    taskEntry.startedAt = Date.now();
    if (typeof onStart === "function") {
      onStart(taskEntry);
    }
  }
  try {
    return await fn();
  } finally {
    releaseGooseSlot(slot);
  }
}
