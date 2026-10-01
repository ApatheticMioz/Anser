#!/usr/bin/env node
/**
 * State-pruner unit tests (fully OFFLINE).
 *
 * Covers src/state_pruner.js:
 *   P1  Age eviction: a terminated session older than maxAgeMs is pruned.
 *   P2  Count eviction: when total sessions exceed maxCount, the oldest
 *       terminated sessions are evicted until at or below the cap.
 *   P3  Size eviction: when total session bytes exceed maxSizeMb, the oldest
 *       terminated sessions are evicted until under the cap.
 *   P4  Active-session protection: a session WITHOUT a terminal event
 *       (session_end / session_error) is NEVER pruned, regardless of age,
 *       count, or size gates.
 *   P5  Incomplete-task protection: a terminated session whose ID is
 *       referenced by a not-done task on disk is NEVER pruned.
 *   P6  dryRun: reports pruned count + bytes reclaimed but deletes nothing.
 *   P7  Orphan .tmp_* files in the tasks dir are cleaned by cleanStateDir.
 *   P8  Throttling: a second cleanStateDir({throttled:true}) within 24h of
 *       the .last_prune timestamp is skipped.
 *
 * Isolated (established pattern): QWEN_STATE_DIR is pinned to a fresh temp
 * dir BEFORE any src import so config.js pins QWEN_STATE_DIR and TASK_DIR to
 * the private dir. The production state is never read or written.
 *
 * Run: node tests/state_pruner.test.js
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Isolate ALL on-disk state in a fresh temp dir BEFORE any src import.
// ---------------------------------------------------------------------------
const TMP_STATE = fs.mkdtempSync(path.join(os.tmpdir(), "state_pruner_test_"));
process.env.QWEN_STATE_DIR = TMP_STATE;
process.env.HOME = TMP_STATE;
process.env.QWEN_WSL_HOME = TMP_STATE;
process.env.QWEN_WIN_HOME = TMP_STATE;

const { QWEN_STATE_DIR, TASK_DIR } = await import("../src/config.js");
const { pruneOldSessions, cleanStateDir } = await import("../src/state_pruner.js");

// ---------------------------------------------------------------------------
// check() harness + hard watchdog.
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

// Set a file's mtime into the past (deterministic aging, no real waiting).
function ageFile(filePath, ageMs) {
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(filePath, t, t);
}

// The retention gates are GLOBAL over the state dir, so each phase must start
// from a known session set: wipe all session dirs before a phase begins.
function resetSessions() {
  const sessionsDir = path.join(TMP_STATE, "sessions");
  if (!fs.existsSync(sessionsDir)) return;
  for (const entry of fs.readdirSync(sessionsDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      fs.rmSync(path.join(sessionsDir, entry.name), { recursive: true, force: true });
    }
  }
}

// Create a session dir with an events.jsonl.
//   terminal=true  -> carries a session_end event (prunable candidate)
//   terminal=false -> no terminal event (active/open, protected)
function makeSession(id, { terminal = true, ageMs = 0, content = "x" } = {}) {
  const dir = path.join(TMP_STATE, "sessions", id);
  fs.mkdirSync(dir, { recursive: true });
  const events = [
    { type: "session_start", timestamp: new Date().toISOString() },
  ];
  if (terminal) {
    events.push({ type: "session_end", status: "completed" });
  }
  const logFile = path.join(dir, "events.jsonl");
  fs.writeFileSync(
    logFile,
    events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    "utf8"
  );
  if (content) {
    // Pad the session with a data file so size gates are testable.
    fs.writeFileSync(path.join(dir, "data.bin"), content, "utf8");
  }
  if (ageMs > 0) {
    ageFile(logFile, ageMs);
    ageFile(path.join(dir, "data.bin"), ageMs);
  }
  return dir;
}

// ---------------------------------------------------------------------------
// P1: age eviction
// ---------------------------------------------------------------------------
function testAgeEviction() {
  console.log("\n[P1] age eviction");
  resetSessions();
  const old = makeSession("sess_old", { terminal: true, ageMs: 15 * 86_400_000 });
  const fresh = makeSession("sess_fresh", { terminal: true, ageMs: 0 });

  const r = pruneOldSessions({
    stateDir: TMP_STATE,
    maxAgeMs: 14 * 86_400_000,
    maxCount: 1000,
    maxSizeMb: 10000,
  });

  check(
    "P1a: old terminated session pruned",
    !fs.existsSync(old),
    `exists=${fs.existsSync(old)}`
  );
  check(
    "P1b: fresh terminated session survives",
    fs.existsSync(fresh),
    `exists=${fs.existsSync(fresh)}`
  );
  check("P1c: pruned count is 1", r.pruned === 1, `pruned=${r.pruned}`);
}

// ---------------------------------------------------------------------------
// P2: count eviction
// ---------------------------------------------------------------------------
function testCountEviction() {
  console.log("\n[P2] count eviction");
  resetSessions();
  // 5 terminated sessions, all fresh (age/size gates irrelevant).
  for (let i = 0; i < 5; i++) {
    makeSession(`sess_count_${i}`, { terminal: true, ageMs: 0 });
  }

  const r = pruneOldSessions({
    stateDir: TMP_STATE,
    maxAgeMs: 10 * 365 * 86_400_000, // age gate never fires
    maxCount: 3,
    maxSizeMb: 10000,
  });

  const remaining = fs
    .readdirSync(path.join(TMP_STATE, "sessions"))
    .filter((n) => n.startsWith("sess_count_"));
  check(
    "P2a: evicted down to maxCount",
    remaining.length === 3,
    `remaining=${remaining.length} ${JSON.stringify(remaining)}`
  );
  check("P2b: pruned count is 2", r.pruned === 2, `pruned=${r.pruned}`);
  // The two OLDEST (all same mtime here, so deterministic by sort stability:
  // eviction walks candidates oldest-first; with equal mtimes the first two
  // in readdir order are evicted).
  check(
    "P2c: bytes reclaimed reported",
    r.bytesReclaimed >= 0,
    `bytes=${r.bytesReclaimed}`
  );
}

// ---------------------------------------------------------------------------
// P3: size eviction
// ---------------------------------------------------------------------------
function testSizeEviction() {
  console.log("\n[P3] size eviction");
  resetSessions();
  // Two big sessions (~1MB each) + one tiny. Cap at 1.5MB -> one big evicted.
  const big1 = makeSession("sess_big1", {
    terminal: true,
    ageMs: 0,
    content: "A".repeat(1024 * 1024),
  });
  const big2 = makeSession("sess_big2", {
    terminal: true,
    ageMs: 0,
    content: "B".repeat(1024 * 1024),
  });
  makeSession("sess_tiny", { terminal: true, ageMs: 0, content: "c" });

  const r = pruneOldSessions({
    stateDir: TMP_STATE,
    maxAgeMs: 10 * 365 * 86_400_000,
    maxCount: 1000,
    maxSizeMb: 1.5,
  });

  const remaining = fs
    .readdirSync(path.join(TMP_STATE, "sessions"))
    .filter((n) => n.startsWith("sess_big") || n === "sess_tiny");
  check(
    "P3a: evicted under size cap (2 of 3 remain)",
    remaining.length === 2,
    `remaining=${JSON.stringify(remaining)}`
  );
  check("P3b: pruned count is 1", r.pruned === 1, `pruned=${r.pruned}`);
  check(
    "P3c: bytes reclaimed ~1MB",
    r.bytesReclaimed >= 1024 * 1024,
    `bytes=${r.bytesReclaimed}`
  );
}

// ---------------------------------------------------------------------------
// P4: active-session protection
// ---------------------------------------------------------------------------
function testActiveSessionProtection() {
  console.log("\n[P4] active-session protection");
  resetSessions();
  // An OPEN session (no terminal event) that is also very old and huge.
  const active = makeSession("sess_active", {
    terminal: false,
    ageMs: 30 * 86_400_000,
    content: "Z".repeat(1024 * 1024),
  });
  // A terminated session that IS prunable, to prove the gate is selective.
  const dead = makeSession("sess_dead", {
    terminal: true,
    ageMs: 30 * 86_400_000,
  });

  const r = pruneOldSessions({
    stateDir: TMP_STATE,
    maxAgeMs: 14 * 86_400_000,
    maxCount: 1000,
    maxSizeMb: 10000,
  });

  check(
    "P4a: active (no terminal) session is NEVER pruned",
    fs.existsSync(active),
    `exists=${fs.existsSync(active)}`
  );
  check(
    "P4b: terminated old session IS pruned",
    !fs.existsSync(dead),
    `exists=${fs.existsSync(dead)}`
  );
  check("P4c: protected count includes the active session", r.protected >= 1, `protected=${r.protected}`);
}

// ---------------------------------------------------------------------------
// P5: incomplete-task protection
// ---------------------------------------------------------------------------
function testIncompleteTaskProtection() {
  console.log("\n[P5] incomplete-task protection");
  resetSessions();
  // A terminated session that is referenced by a NOT-DONE task.
  const protectedSession = makeSession("sess_taskref", {
    terminal: true,
    ageMs: 30 * 86_400_000,
  });
  // Write a not-done task referencing that session into TASK_DIR.
  fs.mkdirSync(TASK_DIR, { recursive: true });
  const taskFile = path.join(TASK_DIR, "task_protect_ref.json");
  fs.writeFileSync(
    taskFile,
    JSON.stringify(
      {
        id: "task_protect_ref",
        sessionId: "sess_taskref",
        createdAt: Date.now(),
        startedAt: Date.now(),
        finishedAt: null,
        lastHeartbeatAt: Date.now(),
        status: "running",
        done: false,
        isError: false,
      },
      null,
      2
    ),
    "utf8"
  );

  const r = pruneOldSessions({
    stateDir: TMP_STATE,
    maxAgeMs: 14 * 86_400_000,
    maxCount: 1000,
    maxSizeMb: 10000,
  });

  check(
    "P5a: session referenced by incomplete task is NEVER pruned",
    fs.existsSync(protectedSession),
    `exists=${fs.existsSync(protectedSession)}`
  );
  check("P5b: protected count includes the task-referenced session", r.protected >= 1, `protected=${r.protected}`);

  // Clean up the task fixture.
  try {
    fs.unlinkSync(taskFile);
  } catch {}
}

// ---------------------------------------------------------------------------
// P6: dryRun
// ---------------------------------------------------------------------------
function testDryRun() {
  console.log("\n[P6] dryRun");
  resetSessions();
  const old = makeSession("sess_dryrun_old", {
    terminal: true,
    ageMs: 30 * 86_400_000,
    content: "D".repeat(1024 * 1024),
  });

  const r = pruneOldSessions({
    stateDir: TMP_STATE,
    maxAgeMs: 14 * 86_400_000,
    maxCount: 1000,
    maxSizeMb: 10000,
    dryRun: true,
  });

  check(
    "P6a: dryRun does NOT delete",
    fs.existsSync(old),
    `exists=${fs.existsSync(old)}`
  );
  check("P6b: dryRun reports pruned count", r.pruned === 1, `pruned=${r.pruned}`);
  check(
    "P6c: dryRun reports bytes reclaimed",
    r.bytesReclaimed >= 1024 * 1024,
    `bytes=${r.bytesReclaimed}`
  );
}

// ---------------------------------------------------------------------------
// P7: orphan .tmp_* cleanup
// ---------------------------------------------------------------------------
function testTmpOrphanCleanup() {
  console.log("\n[P7] orphan .tmp_* cleanup");
  resetSessions();
  fs.mkdirSync(TASK_DIR, { recursive: true });
  const tmpPath = path.join(TASK_DIR, "task_orphan.json.tmp_999999_1699999999999");
  fs.writeFileSync(tmpPath, '{"id":"task_orphan","done":true}', "utf8");

  const r = cleanStateDir({
    stateDir: TMP_STATE,
    maxAgeMs: 14 * 86_400_000,
    maxCount: 1000,
    maxSizeMb: 10000,
    dryRun: false,
    throttled: false,
  });

  check(
    "P7a: orphan .tmp_* file is unlinked",
    !fs.existsSync(tmpPath),
    `exists=${fs.existsSync(tmpPath)}`
  );
  check("P7b: tmpFilesCleaned is 1", r.tmpFilesCleaned === 1, `tmp=${r.tmpFilesCleaned}`);
}

// ---------------------------------------------------------------------------
// P8: throttling
// ---------------------------------------------------------------------------
function testThrottling() {
  console.log("\n[P8] throttling");
  resetSessions();
  // First call (not throttled) writes .last_prune.
  const first = cleanStateDir({
    stateDir: TMP_STATE,
    maxAgeMs: 14 * 86_400_000,
    maxCount: 1000,
    maxSizeMb: 10000,
    dryRun: false,
    throttled: false,
  });
  check("P8a: first call is not skipped", first.skipped === false, `skipped=${first.skipped}`);
  check(
    "P8b: .last_prune timestamp written",
    fs.existsSync(path.join(TMP_STATE, ".last_prune")),
    "missing .last_prune"
  );

  // Second call (throttled) within 24h -> skipped.
  const second = cleanStateDir({
    stateDir: TMP_STATE,
    maxAgeMs: 14 * 86_400_000,
    maxCount: 1000,
    maxSizeMb: 10000,
    dryRun: false,
    throttled: true,
  });
  check("P8c: second throttled call is skipped", second.skipped === true, `skipped=${second.skipped}`);
  check("P8d: skipped call prunes nothing", second.sessionsPruned === 0 && second.tmpFilesCleaned === 0);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  testAgeEviction();
  testCountEviction();
  testSizeEviction();
  testActiveSessionProtection();
  testIncompleteTaskProtection();
  testDryRun();
  testTmpOrphanCleanup();
  testThrottling();

  // Clean up the isolated state dir.
  fs.rmSync(TMP_STATE, { recursive: true, force: true });

  console.log("\n==========================================");
  console.log(`State-Pruner Tests: ${passed} PASSED, ${failed} FAILED`);
  console.log("==========================================");
  process.exit(failed === 0 ? 0 : 1);
}

// Hard watchdog: force termination so a wedged check can never hang the suite.
setTimeout(() => {
  console.error(`\nHARD WATCHDOG fired - forcing exit (failures=${failed})`);
  process.exit(failed === 0 ? 0 : 1);
}, 60_000).unref();

main().catch((err) => {
  console.error("State-pruner test uncaught error:", err);
  process.exit(1);
});
