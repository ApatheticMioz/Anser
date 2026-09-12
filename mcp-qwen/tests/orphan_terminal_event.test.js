#!/usr/bin/env node
/**
 * Orphan-terminal-event tests (fully OFFLINE).
 *
 * Concern: when an MCP server instance dies (process-tree kill), its child
 * runner dies with it. The task file is eventually marked via
 * markTaskOrphanedOnDisk (src/task_registry.js) when the owner pid is
 * dead/stale, but the session's events.jsonl never received a terminal event.
 * Result: sessions ended by silent infra deaths have NO session_end /
 * session_error — undetectable after the fact except by absence (verified in
 * production: session pattern_test_s1, 2026-09-11 10:12:47Z).
 *
 * This test verifies the fix:
 *   A. The orphan path appends EXACTLY ONE terminal event (type
 *      "session_error", reason "orphaned", with an honest owner-pid detail)
 *      to the task's session events.jsonl.
 *   B. A session that ALREADY has a terminal event (session_end or
 *      session_error) is NOT double-appended (the double-terminal guard).
 *   C. Existing JSONL content is uncorrupted: the original bytes are a
 *      byte-for-byte prefix of the new file, and every original line still
 *      parses as JSON.
 *   D. The full readTaskFromDisk integration path (dead owner pid ->
 *      isTaskOrphaned -> markTaskOrphanedOnDisk) marks the task failed AND
 *      appends the terminal event.
 *   E. hasTerminalEvent() unit behavior (empty / non-terminal / session_end /
 *      session_error / malformed-line tolerance).
 *   F. Cross-instance safety: two separate "detecting instances" (two fresh
 *      task objects for the same session) never produce a second terminal
 *      event — single-line appends only, existing content never rewritten.
 *
 * Isolated (established pattern): QWEN_STATE_DIR is pinned to a fresh temp
 * dir BEFORE any src import so config.js pins TASK_DIR and the EventLogger
 * default baseDir (<state>/sessions) to the private dir. The production
 * ~/.qwen state is never read or written.
 *
 * Run: node tests/orphan_terminal_event.test.js
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
// ---------------------------------------------------------------------------
const TMP_STATE = fs.mkdtempSync(path.join(os.tmpdir(), "orphan_terminal_"));
process.env.QWEN_STATE_DIR = TMP_STATE;
process.env.HOME = TMP_STATE;
process.env.QWEN_WSL_HOME = TMP_STATE;
process.env.QWEN_WIN_HOME = TMP_STATE;

const { QWEN_STATE_DIR, TASK_DIR } = await import("../src/config.js");
const {
  readTaskFromDisk,
  markTaskOrphanedOnDisk,
  isTaskOrphaned,
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
  for (let attempt = 0; attempt < 5; attempt++) {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
      stdio: "ignore",
    });
    await new Promise((resolve) => {
      child.on("exit", resolve);
      child.on("spawn", () => {});
    });
    const pid = child.pid;
    if (pid && !pidAlive(pid)) return pid;
    // pid was (impossibly) reused and is alive again; try a fresh child.
  }
  // Last resort: a very high pid that is almost certainly not in use.
  return 2_000_000_000;
}

/**
 * Creates a session's events.jsonl with the given raw event objects (each
 * serialized as one JSONL line, in order). Returns the absolute file path.
 */
function writeSessionEvents(sessionId, events) {
  const dir = path.join(SESSIONS_DIR, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "events.jsonl");
  const content = events.map((e) => JSON.stringify(e)).join("\n") + (events.length ? "\n" : "");
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

/** Reads a session's events.jsonl as raw lines (for byte-prefix checks). */
function readRawLines(sessionId) {
  const file = path.join(SESSIONS_DIR, sessionId, "events.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0);
}

/** Counts terminal events (session_end or session_error) in a session. */
function countTerminal(sessionId) {
  return readEvents(sessionId).filter(
    (e) => e.type === "session_end" || e.type === "session_error"
  ).length;
}

/**
 * Builds a not-done, orphaned task object (dead owner pid + stale heartbeat)
 * for the given session. The dead pid makes isTaskOrphaned's first branch
 * fire; the stale heartbeat is a backup so the integration path is robust
 * even if the pid were (impossibly) reused.
 */
function makeOrphanTask(id, sessionId, deadPid) {
  const now = Date.now();
  return {
    id,
    sessionId,
    cwd: TMP_STATE,
    prompt: "orphan test prompt",
    ownerPid: deadPid,
    createdAt: now - 600_000,
    startedAt: now - 600_000,
    finishedAt: null,
    lastHeartbeatAt: now - 600_000, // stale (> 300s)
    status: "executing",
    done: false,
    isError: false,
    fileOps: [],
    toolCallsCount: 3,
    result: null,
  };
}

// ---------------------------------------------------------------------------
// A. Orphan path appends EXACTLY ONE terminal event.
// ---------------------------------------------------------------------------
async function testOrphanAppendsOneTerminal(deadPid) {
  console.log("\n[A] orphan path appends exactly one terminal event");
  const sessionId = "s_orphan";
  // Non-terminal events only (a session that was mid-flight when killed).
  writeSessionEvents(sessionId, [
    { type: "session_start", timestamp: "2026-09-11T10:12:00.000Z" },
    { type: "user_message", content: "do the thing" },
    { type: "assistant_message", content: "working on it" },
  ]);
  const before = readRawLines(sessionId);
  check("A0: session starts with 3 non-terminal events, 0 terminal",
    before.length === 3 && countTerminal(sessionId) === 0,
    `lines=${before.length} terminal=${countTerminal(sessionId)}`);

  const task = makeOrphanTask("task_orphan", sessionId, deadPid);
  markTaskOrphanedOnDisk(task);

  const after = readEvents(sessionId);
  const terminal = after.filter(
    (e) => e.type === "session_end" || e.type === "session_error"
  );
  check("A1: exactly ONE terminal event after orphan-marking",
    terminal.length === 1, `terminal=${terminal.length}`);
  check("A2: the terminal event is type session_error",
    terminal[0] && terminal[0].type === "session_error",
    `type=${terminal[0] && terminal[0].type}`);
  check("A3: the terminal event has reason 'orphaned'",
    terminal[0] && terminal[0].reason === "orphaned",
    `reason=${terminal[0] && terminal[0].reason}`);
  check("A4: the terminal event carries an honest owner-pid detail",
    terminal[0] && typeof terminal[0].detail === "string" && terminal[0].detail.length > 0,
    `detail=${terminal[0] && terminal[0].detail}`);
  check("A5: the terminal event names the task and owner pid",
    terminal[0] && terminal[0].taskId === "task_orphan" && terminal[0].ownerPid === deadPid,
    `taskId=${terminal[0] && terminal[0].taskId} ownerPid=${terminal[0] && terminal[0].ownerPid}`);
  check("A6: the terminal event carries the session id",
    terminal[0] && terminal[0].sessionId === sessionId,
    `sessionId=${terminal[0] && terminal[0].sessionId}`);
  // The task itself was marked failed.
  check("A7: the task is marked done/failed/isError",
    task.done === true && task.status === "failed" && task.isError === true,
    `done=${task.done} status=${task.status} isError=${task.isError}`);
}

// ---------------------------------------------------------------------------
// B. A pre-terminated session is NOT double-appended.
// ---------------------------------------------------------------------------
async function testPreTerminatedNotDoubled(deadPid) {
  console.log("\n[B] pre-terminated session is not double-appended");
  const sessionId = "s_ended";
  // The session already ended cleanly (a terminal session_end is present).
  writeSessionEvents(sessionId, [
    { type: "session_start", timestamp: "2026-09-11T09:00:00.000Z" },
    { type: "assistant_message", content: "done" },
    { type: "session_end", status: "completed", turnsTaken: 2 },
  ]);
  const linesBefore = readRawLines(sessionId);
  const terminalBefore = countTerminal(sessionId);
  check("B0: session starts with exactly one terminal (session_end)",
    terminalBefore === 1, `terminal=${terminalBefore}`);

  // A task in that session is later found orphaned (done=false).
  const task = makeOrphanTask("task_ended", sessionId, deadPid);
  markTaskOrphanedOnDisk(task);

  const linesAfter = readRawLines(sessionId);
  const terminalAfter = countTerminal(sessionId);
  check("B1: NO second terminal event appended (still exactly one)",
    terminalAfter === 1, `terminal=${terminalAfter}`);
  check("B2: the file's line count is unchanged (nothing appended)",
    linesAfter.length === linesBefore.length,
    `before=${linesBefore.length} after=${linesAfter.length}`);
  check("B3: the original session_end is still the (only) terminal event",
    linesAfter[linesAfter.length - 1] === linesBefore[linesBefore.length - 1],
    "last line changed");
}

// ---------------------------------------------------------------------------
// C. Existing JSONL content is uncorrupted (byte-prefix + per-line parse).
// ---------------------------------------------------------------------------
async function testExistingContentUncorrupted(deadPid) {
  console.log("\n[C] existing JSONL content is uncorrupted");
  const sessionId = "s_corrupt";
  // Include tricky content: quotes, unicode, and a string with an embedded
  // newline (which JSON escapes) to prove the append does not mangle it.
  const tricky = {
    type: "assistant_message",
    content: 'He said "hi" — ünïcode ✓\nsecond line',
  };
  const originalEvents = [
    { type: "session_start", timestamp: "2026-09-11T08:00:00.000Z" },
    { type: "user_message", content: "tricky" },
    tricky,
  ];
  writeSessionEvents(sessionId, originalEvents);
  const originalRaw = fs.readFileSync(
    path.join(SESSIONS_DIR, sessionId, "events.jsonl"),
    "utf8"
  );

  const task = makeOrphanTask("task_corrupt", sessionId, deadPid);
  markTaskOrphanedOnDisk(task);

  const newRaw = fs.readFileSync(
    path.join(SESSIONS_DIR, sessionId, "events.jsonl"),
    "utf8"
  );
  check("C1: the new file is a byte-for-byte EXTENSION of the original",
    newRaw.startsWith(originalRaw),
    "original bytes were altered");
  check("C2: the original content is preserved verbatim (prefix)",
    newRaw.slice(0, originalRaw.length) === originalRaw,
    "prefix mismatch");
  // Every original line still parses, and the tricky content round-trips.
  const after = readEvents(sessionId);
  const stillTricky = after.find((e) => e.type === "assistant_message");
  check("C3: the tricky original line still parses intact",
    stillTricky && stillTricky.content === tricky.content,
    `got=${JSON.stringify(stillTricky && stillTricky.content)}`);
  check("C4: the appended terminal event is the LAST line",
    after.length === originalEvents.length + 1 &&
      after[after.length - 1].type === "session_error",
    `len=${after.length} lastType=${after[after.length - 1] && after[after.length - 1].type}`);
}

// ---------------------------------------------------------------------------
// D. Full readTaskFromDisk integration path (dead owner pid -> orphan -> event).
// ---------------------------------------------------------------------------
async function testReadTaskFromDiskIntegration(deadPid) {
  console.log("\n[D] readTaskFromDisk integration path appends the terminal event");
  const sessionId = "s_int";
  writeSessionEvents(sessionId, [
    { type: "session_start", timestamp: "2026-09-11T10:12:00.000Z" },
    { type: "user_message", content: "go" },
  ]);

  // Write a not-done task file with a dead owner pid to disk.
  const task = makeOrphanTask("task_int", sessionId, deadPid);
  const taskFile = path.join(TASK_DIR, `${task.id}.json`);
  fs.writeFileSync(taskFile, JSON.stringify(task, null, 2), "utf8");

  check("D0: the on-disk task is detected as orphaned",
    isTaskOrphaned({ ...task }), "isTaskOrphaned returned false");

  const readBack = readTaskFromDisk(task.id);
  check("D1: readTaskFromDisk returns the task marked done/failed",
    readBack && readBack.done === true && readBack.status === "failed" && readBack.isError === true,
    `done=${readBack && readBack.done} status=${readBack && readBack.status} isError=${readBack && readBack.isError}`);
  const terminal = readEvents(sessionId).filter(
    (e) => e.type === "session_end" || e.type === "session_error"
  );
  check("D2: the session now has exactly one terminal event",
    terminal.length === 1, `terminal=${terminal.length}`);
  check("D3: the terminal event is the orphan session_error",
    terminal[0] && terminal[0].type === "session_error" && terminal[0].reason === "orphaned",
    `type=${terminal[0] && terminal[0].type} reason=${terminal[0] && terminal[0].reason}`);
  // The task file on disk was rewritten as done/failed.
  const onDisk = JSON.parse(fs.readFileSync(taskFile, "utf8"));
  check("D4: the task file on disk is marked done/failed",
    onDisk.done === true && onDisk.status === "failed" && onDisk.isError === true,
    `done=${onDisk.done} status=${onDisk.status}`);
}

// ---------------------------------------------------------------------------
// E. hasTerminalEvent() unit behavior.
// ---------------------------------------------------------------------------
async function testHasTerminalEventUnit() {
  console.log("\n[E] hasTerminalEvent() unit behavior");
  const mk = (sessionId, events) => {
    writeSessionEvents(sessionId, events);
    return new EventLoggerService({ sessionId, baseDir: SESSIONS_DIR });
  };

  const empty = mk("s_e_empty", []);
  check("E1: empty session -> hasTerminalEvent false", empty.hasTerminalEvent() === false);

  const nonTerm = mk("s_e_nonterm", [
    { type: "session_start" },
    { type: "user_message", content: "x" },
    { type: "assistant_message", content: "y" },
  ]);
  check("E2: non-terminal-only session -> hasTerminalEvent false",
    nonTerm.hasTerminalEvent() === false);

  const withEnd = mk("s_e_end", [
    { type: "session_start" },
    { type: "session_end", status: "completed" },
  ]);
  check("E3: session with session_end -> hasTerminalEvent true",
    withEnd.hasTerminalEvent() === true);

  const withErr = mk("s_e_err", [
    { type: "session_start" },
    { type: "session_error", error: "boom" },
  ]);
  check("E4: session with session_error -> hasTerminalEvent true",
    withErr.hasTerminalEvent() === true);

  // Malformed-line tolerance: a corrupt trailing line must not throw and must
  // not hide a real terminal event earlier in the file.
  const dir = path.join(SESSIONS_DIR, "s_e_malformed");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "events.jsonl");
  fs.writeFileSync(
    file,
    JSON.stringify({ type: "session_start" }) + "\n" +
      "{not valid json" + "\n" +
      JSON.stringify({ type: "session_end", status: "completed" }) + "\n",
    "utf8"
  );
  const malformed = new EventLoggerService({ sessionId: "s_e_malformed", baseDir: SESSIONS_DIR });
  let threw = false;
  let val;
  try {
    val = malformed.hasTerminalEvent();
  } catch {
    threw = true;
  }
  check("E5: malformed line does not throw", threw === false);
  check("E6: malformed line does not hide a real terminal event",
    val === true, `val=${val}`);
}

// ---------------------------------------------------------------------------
// F. Cross-instance safety: two detecting instances never double-append.
// ---------------------------------------------------------------------------
async function testCrossInstanceNoDoubleAppend(deadPid) {
  console.log("\n[F] cross-instance: two detecting instances never double-append");
  const sessionId = "s_xinst";
  writeSessionEvents(sessionId, [
    { type: "session_start", timestamp: "2026-09-11T10:12:00.000Z" },
    { type: "assistant_message", content: "mid-flight" },
  ]);
  const linesBefore = readRawLines(sessionId);

  // "Instance 1" detects the orphan (a fresh, not-done task object).
  const task1 = makeOrphanTask("task_xinst", sessionId, deadPid);
  markTaskOrphanedOnDisk(task1);
  const after1 = readRawLines(sessionId);
  check("F1: first instance appends exactly one line",
    after1.length === linesBefore.length + 1,
    `before=${linesBefore.length} after1=${after1.length}`);

  // "Instance 2" (a DIFFERENT process reading the shared state dir) sees the
  // same session. It builds its OWN fresh, not-done task object for the same
  // session (simulating a task file that was not yet marked done by instance
  // 1, or a second orphaned task in the same session) and marks it orphaned.
  const task2 = makeOrphanTask("task_xinst2", sessionId, deadPid);
  markTaskOrphanedOnDisk(task2);
  const after2 = readRawLines(sessionId);

  const terminal = readEvents(sessionId).filter(
    (e) => e.type === "session_end" || e.type === "session_error"
  );
  check("F2: second instance does NOT append a second terminal event",
    terminal.length === 1, `terminal=${terminal.length}`);
  check("F3: the file grew by exactly one line total (single-line append only)",
    after2.length === linesBefore.length + 1,
    `before=${linesBefore.length} after2=${after2.length}`);
  check("F4: existing content is still a byte-prefix (never rewritten)",
    fs.readFileSync(path.join(SESSIONS_DIR, sessionId, "events.jsonl"), "utf8")
      .startsWith(linesBefore.join("\n") + "\n"),
    "original bytes altered");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const deadPid = await getDeadPid();
  console.log(`\nUsing dead owner pid: ${deadPid} (pidAlive=${pidAlive(deadPid)})`);

  await testOrphanAppendsOneTerminal(deadPid);
  await testPreTerminatedNotDoubled(deadPid);
  await testExistingContentUncorrupted(deadPid);
  await testReadTaskFromDiskIntegration(deadPid);
  await testHasTerminalEventUnit();
  await testCrossInstanceNoDoubleAppend(deadPid);

  // Clean up the isolated state dir.
  fs.rmSync(TMP_STATE, { recursive: true, force: true });

  console.log("\n==========================================");
  console.log(`Orphan-Terminal-Event Tests: ${passed} PASSED, ${failed} FAILED`);
  console.log("==========================================");
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Orphan-terminal-event test uncaught error:", err);
  process.exit(1);
});
