import fs from "node:fs";
import path from "node:path";
import {
  TASK_DIR,
  SLOTS_DIR,
  MAX_CONCURRENT_TASKS,
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
  // LIVE PROCESS INVARIANT: A live process's lease is NEVER reclaimable!
  // Prevents dual-generation collisions on the MAX_SEQS=1 engine during long tasks.
  return false;
}

/**
 * Acquires a global cross-process task slot lease.
 * Resolves with {file, refresh} once a slot is held, or null if the task was
 * cancelled while waiting.
 *
 * Single-Tenant Multi-Slot Invariant:
 * Up to MAX_CONCURRENT_TASKS (default 2) are permitted machine-wide, but ALL
 * concurrently active slots MUST belong to the SAME tenant (process.pid).
 * If an alien tenant (lease.pid !== process.pid where lease is live) holds any slot,
 * this process is blocked and queues at $0 until the alien tenant releases all slots.
 */
export async function acquireTaskSlot(taskEntry) {
  try {
    fs.mkdirSync(SLOTS_DIR, { recursive: true });
  } catch {}

  let lastHeartbeatUpdate = Date.now();

  for (;;) {
    if (taskEntry?.done) return null;

    const now = Date.now();
    // Keep queued task heartbeat fresh so observers/reaper don't treat it as dead while waiting
    if (now - lastHeartbeatUpdate > 15_000) {
      if (taskEntry) {
        taskEntry.lastHeartbeatAt = now;
      }
      lastHeartbeatUpdate = now;
    }

    // Tenant affinity invariant: check if an alien tenant holds ANY active lease
    let alienTenantActive = false;
    for (let i = 0; i < MAX_CONCURRENT_TASKS; i++) {
      const file = slotFilePath(i);
      const lease = readLease(file);
      if (lease && !leaseReclaimable(lease) && lease.pid !== process.pid) {
        alienTenantActive = true;
        break;
      }
    }

    if (!alienTenantActive) {
      for (let i = 0; i < MAX_CONCURRENT_TASKS; i++) {
        const file = slotFilePath(i);
        const claim = {
          pid: process.pid,
          taskId: taskEntry?.id ?? null,
          cwd: taskEntry?.cwd ?? null,
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
              const tmp = `${file}.tmp_${Date.now()}_${process.pid}`;
              fs.writeFileSync(
                tmp,
                JSON.stringify({ ...(cur ?? claim), pid: process.pid, hb: Date.now() }),
                "utf8"
              );
              fs.renameSync(tmp, file);
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
    }

    await new Promise((r) => setTimeout(r, SLOT_POLL_MS));
  }
}

/**
 * Releases a held task slot lease.
 *
 * FX5-A (D6): this is now IDEMPOTENT and returns a distinguishable result
 * instead of throwing, so a cancel that lands after natural completion (or a
 * double-release from runQueued's finally AND a cancel path) is a harmless
 * no-op. The atomic-heartbeat design (O_EXCL claim, heartbeat refresh,
 * ownership-guarded unlink) is untouched.
 *
 * @returns {{released: boolean, reason?: string}}
 *   - {released:true}  we freed a lease we owned (or a dead/unreadable one).
 *   - {released:false, reason:"no_slot"}         no handle passed in.
 *   - {released:false, reason:"already_released"} this handle was already
 *     released (idempotent no-op).
 *   - {released:false, reason:"not_ours"}        another LIVE instance owns
 *     the lease; we never delete it (P15 multi-instance invariant).
 *   - {released:false, reason:"release_failed"} the unlink threw; the handle
 *     is NOT marked released so a later call may retry.
 */
export function releaseTaskSlot(slot) {
  if (!slot) return { released: false, reason: "no_slot" };
  if (slot.released) return { released: false, reason: "already_released" };
  clearInterval(slot.refresh);
  try {
    const cur = readLease(slot.file);
    if (!cur || cur.pid === process.pid || !pidAlive(cur.pid)) {
      fs.rmSync(slot.file, { force: true });
      slot.released = true;
      return { released: true };
    }
    // Another LIVE instance owns this lease — never delete it (P15).
    slot.released = true;
    return { released: false, reason: "not_ours" };
  } catch {
    // Do NOT mark released on failure so a later call can retry the unlink.
    return { released: false, reason: "release_failed" };
  }
}

/**
 * Returns active (non-reclaimable) leases across all instances for status reporting.
 */
export function listTaskSlots() {
  const out = [];
  for (let i = 0; i < MAX_CONCURRENT_TASKS; i++) {
    const file = slotFilePath(i);
    const lease = readLease(file);
    if (lease && !leaseReclaimable(lease)) out.push(lease);
  }
  return out;
}

/**
 * Returns deterministic slot status distinguishing same-session vs alien-session usage.
 * Used for anti-panic status telemetry and orchestrator wait advisories.
 */
export function getSlotStatus(currentPid = process.pid) {
  const slots = [];
  const alienHolders = [];
  const sameHolders = [];
  for (let i = 0; i < MAX_CONCURRENT_TASKS; i++) {
    const file = slotFilePath(i);
    const lease = readLease(file);
    if (lease && !leaseReclaimable(lease)) {
      const entry = { slot: i, ...lease };
      slots.push(entry);
      if (lease.pid === currentPid) {
        sameHolders.push(entry);
      } else {
        alienHolders.push(entry);
      }
    }
  }
  return {
    slots,
    totalCapacity: MAX_CONCURRENT_TASKS,
    alienHolders,
    sameHolders,
    isAlienActive: alienHolders.length > 0,
    isSameActive: sameHolders.length > 0,
    isFullyOccupied: slots.length >= MAX_CONCURRENT_TASKS,
  };
}

/**
 * Clears reclaimable slot lease locks in SLOTS_DIR.
 *
 * P15: only deletes leases whose owner is this process or whose owner pid is
 * not alive. A lease that cannot be parsed (truncated mid-write) is treated
 * as reclaimable, matching the readLease/leaseReclaimable convention.
 */
export function clearReclaimableTaskSlots() {
  try {
    if (fs.existsSync(SLOTS_DIR)) {
      for (const f of fs.readdirSync(SLOTS_DIR)) {
        if (!f.startsWith("slot_") || !f.endsWith(".json")) continue;
        const lease = readLease(path.join(SLOTS_DIR, f));
        if (lease && lease.pid !== process.pid && pidAlive(lease.pid)) continue;
        fs.rmSync(path.join(SLOTS_DIR, f), { force: true });
      }
    }
  } catch {}
}

/**
 * Runs a function within an acquired global task slot.
 */
export async function runQueued(fn, taskEntry, onStart) {
  const slot = await acquireTaskSlot(taskEntry);
  if (!slot) {
    return (
      taskEntry?.result ?? {
        isError: true,
        text: "Task cancelled before acquiring an execution slot.",
      }
    );
  }
  // FX5-A (D6): record the live slot handle on the task entry so a cancel
  // path (tools.js `cancel`, the HTTP /task/:id/cancel, or cancelAllTasks)
  // can release the slot immediately instead of waiting for natural
  // completion. Cleared in the finally below once the slot is released.
  if (taskEntry) taskEntry.slot = slot;
  if (taskEntry?.done || taskEntry?.status === "cancelled") {
    releaseTaskSlot(slot);
    if (taskEntry) taskEntry.slot = null;
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
    releaseTaskSlot(slot);
    if (taskEntry) taskEntry.slot = null;
  }
}
