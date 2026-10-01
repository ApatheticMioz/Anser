#!/usr/bin/env node
/**
 * M9 (P2, N2) — mid-session liveness-reaper tests (fully OFFLINE).
 *
 * Defect N2: the boot-only orphan sweep (markTaskOrphanedOnDisk, invoked from
 * readTaskFromDisk) only runs when a task file is READ at process start. A task
 * whose owner process dies MID-SESSION — e.g. task_anomaly-probe-s1, frozen at
 * status:"running" with a dead ownerPid and no terminal event — is never
 * re-read by a boot sweep, so it stays "running" forever and misleads every
 * later probe.
 *
 * This test verifies the fix (reapOrphans in src/task_registry.js):
 *   A. dead-PID + STALE heartbeat  -> reaped with the orphaned terminal marker
 *      ({type:"session_error", reason:"orphaned"} + status/isError terminal +
 *      finishedAt), both for an in-memory task and an on-disk task.
 *   B. LIVE-PID (owner alive)      -> untouched, regardless of heartbeat age
 *      (the LIVE-OWNER INVARIANT), both in-memory and on-disk.
 *   C. dead-PID + FRESH heartbeat (within the stale window) -> untouched
 *      (conservative: the owner may still be writing its final state), both
 *      in-memory and on-disk.
 *   D. The reaped task's session events.jsonl carries EXACTLY ONE terminal
 *      event with reason "orphaned" (the same marker the boot sweep writes).
 *   E. Idempotency: re-running reapOrphans does not double-reap or
 *      double-append a terminal event.
 *
 * Isolated (established pattern): QWEN_STATE_DIR is pinned to a fresh temp dir
 * BEFORE any src import so config.js pins TASK_DIR and the EventLogger default
 * baseDir (<state>/sessions) to the private dir. The production ~/.qwen state
 * is never read or written. QWEN_ORPHAN_REAP_STALE_MS is pinned to 1000ms so
 * the "stale" vs "fresh" boundary is deterministic (stale = >1s, fresh = <1s).
 *
 * Run: node tests/orphan_reaper.test.js
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Isolate ALL on-disk state in a fresh temp dir BEFORE any src import so
// config.js pins QWEN_STATE_DIR (and TASK_DIR + the EventLogger default
// baseDir under it) to the private dir. The production ~/.qwen is never
// read or written.
//
// Pin the reaper's stale window to 1000ms so the "stale" vs "fresh" boundary
// is deterministic: a heartbeat >1s old is stale, <1s old is fresh.
// ---------------------------------------------------------------------------
const TMP_STATE = fs.mkdtempSync(path.join(os.tmpdir(), "orphan_reaper_"));
process.env.QWEN_STATE_DIR = TMP_STATE;
process.env.HOME = TMP_STATE;
process.env.QWEN_WSL_HOME = TMP_STATE;
process.env.QWEN_WIN_HOME = TMP_STATE;
process.env.QWEN_ORPHAN_REAP_STALE_MS = "1000"; // 1s stale window (test)

const { QWEN_STATE_DIR, TASK_DIR, ORPHAN_REAP_STALE_MS } = await import(
  "../src/config.js"
);
const {
  tasks,
  reapOrphans,
  markTaskOrphanedOnDisk,
  isTaskOrphaned,
  readTaskFromDisk,
  listTasksFromDisk,
} = await import("../src/task_registry.js");
const { EventLoggerService } = await import(
  "../src/harness/services/event_logger.js"
);
const { pidAlive } = await import("../src/semaphore.js");

const SESSIONS_DIR = path.join(QWEN_STATE_DIR, "sessions");

// ---------------------------------------------------------------------------
// check() harness + hard watchdog (the verdict is the checks; the watchdog
// only guarantees the process always terminates).
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;
function check(name, cond, detail = "") {
  if (cond) {
    console.log(`[PASS] ${name}`);
    passed++;
  } else {
    console.error(`[FAIL] ${name}${detail ? ` (${detail})` : ""}`);
    failed++;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Hard watchdog: force termination so a wedged check can never hang the suite.
setTimeout(() => {
  console.error(`\nHARD WATCHDOG fired - forcing exit (failures=${failed})`);
  process.exit(failed === 0 ? 0 : 1);
}, 30_000).unref();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns a PID that pidAlive() reports as dead, by spawning a short-lived
 * child and waiting for it to exit. Retries a few times in the (rare) case
 * the OS reuses the pid before we probe it.
 */
async function getDeadPid() {
  const candidate = 2_000_000_000;
  if (!pidAlive(candidate)) return candidate;
  for (let pid = 2_000_000_001; pid < 2_000_000_050; pid++) {
    if (!pidAlive(pid)) return pid;
  }
  return 2_000_000_000;
}

/**
 * Spawns a long-lived child and returns {pid, child} where pidAlive(pid) is
 * true for the child's lifetime. Used to exercise the LIVE-OWNER INVARIANT
 * with a real, separate live process (not just process.pid).
 */
async function getLivePid() {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    stdio: "ignore",
  });
  // Wait until the child is actually up (pidAlive true).
  for (let i = 0; i < 50; i++) {
    if (child.pid && pidAlive(child.pid)) return { pid: child.pid, child };
    await sleep(50);
  }
  return { pid: child.pid, child };
}

/**
 * Creates a session's events.jsonl with the given raw event objects (each
 * serialized as one JSONL line, in order). Returns the absolute file path.
 */
function writeSessionEvents(sessionId, events) {
  const dir = path.join(SESSIONS_DIR, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "events.jsonl");
  const content =
    events.map((e) => JSON.stringify(e)).join("\n") +
    (events.length ? "\n" : "");
  fs.writeFileSync(file, content, "utf8");
  return file;
}

/** Reads a session's events.jsonl as parsed events (skips malformed lines). */
function readEvents(sessionId) {
  const file = path.join(SESSIONS_DIR, sessionId, "events.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/** Counts terminal events (session_end or session_error) in a session. */
function countTerminal(sessionId) {
  return readEvents(sessionId).filter(
    (e) => e.type === "session_end" || e.type === "session_error"
  ).length;
}

/**
 * Builds a not-done task object with the given liveness/staleness profile.
 *
 * @param {object} o
 * @param {string} o.id
 * @param {string} o.sessionId
 * @param {number} o.ownerPid
 * @param {string} o.status "running" or "queued"
 * @param {number} o.heartbeatAgeMs how long ago the last heartbeat was
 *   (0 = fresh/now; large = stale).
 */
function makeTask({ id, sessionId, ownerPid, status, heartbeatAgeMs }) {
  const now = Date.now();
  return {
    id,
    sessionId,
    cwd: TMP_STATE,
    prompt: "orphan reaper test prompt",
    ownerPid,
    createdAt: now - 600_000,
    startedAt: now - 600_000,
    finishedAt: null,
    lastHeartbeatAt: now - heartbeatAgeMs,
    status,
    done: false,
    isError: false,
    fileOps: [],
    toolCallsCount: 2,
    result: null,
  };
}

/** Writes a task object to its on-disk JSON file (as saveTaskToDisk would). */
function writeTaskFile(task) {
  const filePath = path.join(TASK_DIR, `${task.id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(task, null, 2), "utf8");
  return filePath;
}

/** Reads a task's on-disk JSON file back (or null if absent). */
function readTaskFile(id) {
  const filePath = path.join(TASK_DIR, `${id}.json`);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

// Staleness constants relative to the 1000ms test window.
const STALE_AGE_MS = 10_000; // 10s old  -> stale  (> 1s window)
const FRESH_AGE_MS = 200; // 0.2s old -> fresh  (< 1s window)

// ---------------------------------------------------------------------------
// A. dead-PID + STALE heartbeat -> reaped with the orphaned terminal marker.
// ---------------------------------------------------------------------------
async function testDeadStaleReaped(deadPid) {
  console.log("\n[A] dead-PID + stale heartbeat -> reaped (in-memory + on-disk)");

  // A1: in-memory task.
  const memSession = "s_reap_mem";
  writeSessionEvents(memSession, [
    { type: "session_start", timestamp: "2026-09-12T10:00:00.000Z" },
    { type: "assistant_message", content: "mid-flight" },
  ]);
  const memTask = makeTask({
    id: "task_reap_mem",
    sessionId: memSession,
    ownerPid: deadPid,
    status: "running",
    heartbeatAgeMs: STALE_AGE_MS,
  });
  tasks.set(memTask.id, memTask);
  check(
    "A0: in-memory dead+stale task is a reaper candidate (not done, running, stale, dead owner)",
    !memTask.done &&
      memTask.status === "running" &&
      Date.now() - memTask.lastHeartbeatAt > ORPHAN_REAP_STALE_MS &&
      !pidAlive(deadPid),
    `done=${memTask.done} status=${memTask.status} age=${Date.now() - memTask.lastHeartbeatAt}ms window=${ORPHAN_REAP_STALE_MS}ms`
  );

  const reaped = reapOrphans();
  check("A1: reapOrphans reaped at least one task", reaped >= 1, `reaped=${reaped}`);
  check(
    "A2: in-memory task is now terminal (done/failed/isError/finishedAt)",
    memTask.done === true &&
      memTask.status === "failed" &&
      memTask.isError === true &&
      typeof memTask.finishedAt === "number",
    `done=${memTask.done} status=${memTask.status} isError=${memTask.isError} finishedAt=${memTask.finishedAt}`
  );
  const memTerminal = readEvents(memSession).filter(
    (e) => e.type === "session_end" || e.type === "session_error"
  );
  check(
    "A3: in-memory task's session got EXACTLY ONE terminal event",
    memTerminal.length === 1,
    `terminal=${memTerminal.length}`
  );
  check(
    "A4: the terminal event is the orphaned marker (type session_error, reason orphaned)",
    memTerminal[0] &&
      memTerminal[0].type === "session_error" &&
      memTerminal[0].reason === "orphaned",
    `type=${memTerminal[0] && memTerminal[0].type} reason=${memTerminal[0] && memTerminal[0].reason}`
  );
  check(
    "A5: the terminal event names the reaped task and its dead owner pid",
    memTerminal[0] &&
      memTerminal[0].taskId === "task_reap_mem" &&
      memTerminal[0].ownerPid === deadPid,
    `taskId=${memTerminal[0] && memTerminal[0].taskId} ownerPid=${memTerminal[0] && memTerminal[0].ownerPid}`
  );

  // A6: on-disk task (the actual N2 scenario: a task file left by a dead
  // instance, never re-read by a boot sweep).
  const diskSession = "s_reap_disk";
  writeSessionEvents(diskSession, [
    { type: "session_start", timestamp: "2026-09-12T10:00:00.000Z" },
    { type: "assistant_message", content: "mid-flight" },
  ]);
  const diskTask = makeTask({
    id: "task_reap_disk",
    sessionId: diskSession,
    ownerPid: deadPid,
    status: "running",
    heartbeatAgeMs: STALE_AGE_MS,
  });
  writeTaskFile(diskTask);
  check(
    "A6: on-disk dead+stale task is detected as orphaned by the boot-sweep predicate",
    isTaskOrphaned({ ...diskTask }),
    "isTaskOrphaned returned false"
  );

  const reaped2 = reapOrphans();
  check(
    "A7: the on-disk dead+stale task was reaped (reapOrphans returned a reap)",
    reaped2 >= 1,
    `reaped=${reaped2}`
  );
  const onDisk = readTaskFile("task_reap_disk");
  check(
    "A8: the on-disk task file is now terminal (done/failed/isError/finishedAt)",
    onDisk &&
      onDisk.done === true &&
      onDisk.status === "failed" &&
      onDisk.isError === true &&
      typeof onDisk.finishedAt === "number",
    `done=${onDisk && onDisk.done} status=${onDisk && onDisk.status} isError=${onDisk && onDisk.isError}`
  );
  const diskTerminal = readEvents(diskSession).filter(
    (e) => e.type === "session_end" || e.type === "session_error"
  );
  check(
    "A9: the on-disk task's session got EXACTLY ONE orphaned terminal event",
    diskTerminal.length === 1 &&
      diskTerminal[0].type === "session_error" &&
      diskTerminal[0].reason === "orphaned",
    `terminal=${diskTerminal.length} type=${diskTerminal[0] && diskTerminal[0].type} reason=${diskTerminal[0] && diskTerminal[0].reason}`
  );
}

// ---------------------------------------------------------------------------
// B. LIVE-PID (owner alive) -> untouched, regardless of heartbeat age.
// ---------------------------------------------------------------------------
async function testLiveOwnerUntouched(livePid) {
  console.log("\n[B] LIVE-PID (owner alive) -> untouched (LIVE-OWNER INVARIANT)");
  check("B0: the live owner pid is actually alive", pidAlive(livePid), `pid=${livePid}`);

  // B1: in-memory task with a STALE heartbeat but a LIVE owner.
  const memSession = "s_live_mem";
  writeSessionEvents(memSession, [
    { type: "session_start", timestamp: "2026-09-12T11:00:00.000Z" },
    { type: "assistant_message", content: "long deep-thinking turn" },
  ]);
  const memTask = makeTask({
    id: "task_live_mem",
    sessionId: memSession,
    ownerPid: livePid,
    status: "running",
    heartbeatAgeMs: STALE_AGE_MS, // stale, but the owner is alive
  });
  tasks.set(memTask.id, memTask);

  reapOrphans();
  check(
    "B1: in-memory task with a LIVE owner is NOT reaped (stale heartbeat ignored)",
    memTask.done === false &&
      memTask.status === "running" &&
      memTask.isError === false,
    `done=${memTask.done} status=${memTask.status} isError=${memTask.isError}`
  );
  check(
    "B2: no terminal event was appended to the live-owner session",
    countTerminal(memSession) === 0,
    `terminal=${countTerminal(memSession)}`
  );

  // B3: on-disk task with a STALE heartbeat but a LIVE owner.
  const diskSession = "s_live_disk";
  writeSessionEvents(diskSession, [
    { type: "session_start", timestamp: "2026-09-12T11:00:00.000Z" },
    { type: "assistant_message", content: "long deep-thinking turn" },
  ]);
  const diskTask = makeTask({
    id: "task_live_disk",
    sessionId: diskSession,
    ownerPid: livePid,
    status: "running",
    heartbeatAgeMs: STALE_AGE_MS, // stale, but the owner is alive
  });
  writeTaskFile(diskTask);

  reapOrphans();
  const onDisk = readTaskFile("task_live_disk");
  check(
    "B3: on-disk task with a LIVE owner is NOT reaped (file still not-done/running)",
    onDisk && onDisk.done === false && onDisk.status === "running",
    `done=${onDisk && onDisk.done} status=${onDisk && onDisk.status}`
  );
  check(
    "B4: no terminal event was appended to the live-owner on-disk session",
    countTerminal(diskSession) === 0,
    `terminal=${countTerminal(diskSession)}`
  );
}

// ---------------------------------------------------------------------------
// C. dead-PID + FRESH heartbeat (within the stale window) -> untouched
//    (conservative: the owner may still be writing its final state).
// ---------------------------------------------------------------------------
async function testFreshHeartbeatUntouched(deadPid) {
  console.log("\n[C] dead-PID + FRESH heartbeat (within window) -> untouched (conservative)");

  // C1: in-memory task with a FRESH heartbeat and a dead owner.
  const memSession = "s_fresh_mem";
  writeSessionEvents(memSession, [
    { type: "session_start", timestamp: "2026-09-12T12:00:00.000Z" },
    { type: "assistant_message", content: "just wrote a heartbeat" },
  ]);
  const memTask = makeTask({
    id: "task_fresh_mem",
    sessionId: memSession,
    ownerPid: deadPid,
    status: "running",
    heartbeatAgeMs: FRESH_AGE_MS, // fresh (< 1s window)
  });
  tasks.set(memTask.id, memTask);
  check(
    "C0: in-memory fresh+dead task is within the stale window (not yet stale)",
    Date.now() - memTask.lastHeartbeatAt <= ORPHAN_REAP_STALE_MS,
    `age=${Date.now() - memTask.lastHeartbeatAt}ms window=${ORPHAN_REAP_STALE_MS}ms`
  );

  reapOrphans();
  check(
    "C1: in-memory task with a FRESH heartbeat is NOT reaped (conservative)",
    memTask.done === false &&
      memTask.status === "running" &&
      memTask.isError === false,
    `done=${memTask.done} status=${memTask.status} isError=${memTask.isError}`
  );
  check(
    "C2: no terminal event was appended to the fresh-heartbeat session",
    countTerminal(memSession) === 0,
    `terminal=${countTerminal(memSession)}`
  );

  // C3: on-disk task with a FRESH heartbeat and a dead owner.
  const diskSession = "s_fresh_disk";
  writeSessionEvents(diskSession, [
    { type: "session_start", timestamp: "2026-09-12T12:00:00.000Z" },
    { type: "assistant_message", content: "just wrote a heartbeat" },
  ]);
  const diskTask = makeTask({
    id: "task_fresh_disk",
    sessionId: diskSession,
    ownerPid: deadPid,
    status: "running",
    heartbeatAgeMs: FRESH_AGE_MS, // fresh (< 1s window)
  });
  writeTaskFile(diskTask);

  reapOrphans();
  const onDisk = readTaskFile("task_fresh_disk");
  check(
    "C3: on-disk task with a FRESH heartbeat is NOT reaped (file still not-done/running)",
    onDisk && onDisk.done === false && onDisk.status === "running",
    `done=${onDisk && onDisk.done} status=${onDisk && onDisk.status}`
  );
  check(
    "C4: no terminal event was appended to the fresh-heartbeat on-disk session",
    countTerminal(diskSession) === 0,
    `terminal=${countTerminal(diskSession)}`
  );
}

// ---------------------------------------------------------------------------
// D. Idempotency: re-running reapOrphans does not double-reap or double-append.
// ---------------------------------------------------------------------------
async function testIdempotent(deadPid) {
  console.log("\n[D] idempotency: re-running reapOrphans does not double-reap / double-append");
  const sessionId = "s_idem";
  writeSessionEvents(sessionId, [
    { type: "session_start", timestamp: "2026-09-12T13:00:00.000Z" },
    { type: "assistant_message", content: "mid-flight" },
  ]);
  const task = makeTask({
    id: "task_idem",
    sessionId,
    ownerPid: deadPid,
    status: "running",
    heartbeatAgeMs: STALE_AGE_MS,
  });
  writeTaskFile(task);

  const first = reapOrphans();
  const terminalAfterFirst = countTerminal(sessionId);
  check("D0: first reapOrphans reaped the task", first >= 1, `reaped=${first}`);
  check(
    "D1: exactly one terminal event after the first reap",
    terminalAfterFirst === 1,
    `terminal=${terminalAfterFirst}`
  );

  // Re-run: the task is now done, so it must NOT be reaped again, and no
  // second terminal event may be appended (the double-terminal guard).
  const second = reapOrphans();
  const terminalAfterSecond = countTerminal(sessionId);
  check(
    "D2: a second reapOrphans does NOT re-reap an already-done task",
    second === 0,
    `reaped=${second}`
  );
  check(
    "D3: no second terminal event was appended (still exactly one)",
    terminalAfterSecond === 1,
    `terminal=${terminalAfterSecond}`
  );
  const onDisk = readTaskFile("task_idem");
  check(
    "D4: the on-disk task remains terminal after the re-run",
    onDisk && onDisk.done === true && onDisk.status === "failed",
    `done=${onDisk && onDisk.done} status=${onDisk && onDisk.status}`
  );
}

// ---------------------------------------------------------------------------
// E. The reaper is wired into the existing cleanOldTasks retention cadence.
// ---------------------------------------------------------------------------
async function testWiredIntoCleanOldTasks(deadPid) {
  console.log("\n[E] reapOrphans is invoked by cleanOldTasks (the existing retention cadence)");
  const { cleanOldTasks } = await import("../src/task_registry.js");
  const sessionId = "s_wire";
  writeSessionEvents(sessionId, [
    { type: "session_start", timestamp: "2026-09-12T14:00:00.000Z" },
    { type: "assistant_message", content: "mid-flight" },
  ]);
  const task = makeTask({
    id: "task_wire",
    sessionId,
    ownerPid: deadPid,
    status: "running",
    heartbeatAgeMs: STALE_AGE_MS,
  });
  writeTaskFile(task);

  // cleanOldTasks is the existing 5-minute retention cadence (driven by the
  // setInterval in initStatusServer). It must now also run the reaper.
  cleanOldTasks();
  const onDisk = readTaskFile("task_wire");
  const terminal = readEvents(sessionId).filter(
    (e) => e.type === "session_end" || e.type === "session_error"
  );
  check(
    "E0: cleanOldTasks reaped the dead+stale on-disk task (piggybacked reaper)",
    onDisk && onDisk.done === true && onDisk.status === "failed",
    `done=${onDisk && onDisk.done} status=${onDisk && onDisk.status}`
  );
  check(
    "E1: the reaped task's session got the orphaned terminal event via cleanOldTasks",
    terminal.length === 1 &&
      terminal[0].type === "session_error" &&
      terminal[0].reason === "orphaned",
    `terminal=${terminal.length} reason=${terminal[0] && terminal[0].reason}`
  );
}

// ---------------------------------------------------------------------------
// F. On-demand orphan reaping via readTaskFromDisk (closes the mid-session gap without waiting for periodic cadence).
// ---------------------------------------------------------------------------
async function testOnDemandReadReaped(deadPid) {
  console.log("\n[F] on-demand orphan reaping: readTaskFromDisk immediately reaps dead+stale tasks");
  const { readTaskFromDisk } = await import("../src/task_registry.js");
  const sessionId = "s_ondemand";
  writeSessionEvents(sessionId, [
    { type: "session_start", timestamp: "2026-09-12T15:00:00.000Z" },
    { type: "assistant_message", content: "in flight when power cut occurred" },
  ]);
  const task = makeTask({
    id: "task_ondemand",
    sessionId,
    ownerPid: deadPid,
    status: "running",
    heartbeatAgeMs: STALE_AGE_MS,
  });
  writeTaskFile(task);

  // Directly call readTaskFromDisk WITHOUT calling reapOrphans or waiting for cleanOldTasks!
  const reaped = readTaskFromDisk("task_ondemand");
  check(
    "F0: readTaskFromDisk reaped the dead+stale task on-demand",
    reaped && reaped.done === true && reaped.status === "failed",
    `done=${reaped && reaped.done} status=${reaped && reaped.status}`
  );
  const onDisk = readTaskFile("task_ondemand");
  check(
    "F1: the task file on disk was updated to terminal failed immediately",
    onDisk && onDisk.done === true && onDisk.status === "failed",
    `done=${onDisk && onDisk.done} status=${onDisk && onDisk.status}`
  );
  const terminal = readEvents(sessionId).filter(
    (e) => e.type === "session_end" || e.type === "session_error"
  );
  check(
    "F2: session got orphaned terminal event via on-demand read",
    terminal.length === 1 &&
      terminal[0].type === "session_error" &&
      terminal[0].reason === "orphaned",
    `terminal=${terminal.length} reason=${terminal[0] && terminal[0].reason}`
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const deadPid = await getDeadPid();
  const { pid: livePid, child: liveChild } = await getLivePid();
  console.log(
    `\nUsing dead owner pid: ${deadPid} (pidAlive=${pidAlive(deadPid)}), live owner pid: ${livePid} (pidAlive=${pidAlive(livePid)}), stale window: ${ORPHAN_REAP_STALE_MS}ms`
  );

  try {
    await testDeadStaleReaped(deadPid);
    await testLiveOwnerUntouched(livePid);
    await testFreshHeartbeatUntouched(deadPid);
    await testIdempotent(deadPid);
    await testWiredIntoCleanOldTasks(deadPid);
    await testOnDemandReadReaped(deadPid);
  } finally {
    if (liveChild) {
      try {
        liveChild.kill();
      } catch {}
    }
    // Clean up the isolated state dir.
    fs.rmSync(TMP_STATE, { recursive: true, force: true });
  }

  console.log("\n==========================================");
  console.log(`Orphan-Reaper Tests: ${passed} PASSED, ${failed} FAILED`);
  console.log("==========================================");
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Orphan-reaper test uncaught error:", err);
  process.exit(1);
});
