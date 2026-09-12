#!/usr/bin/env node
/**
 * Task-state lifecycle hygiene tests (fully OFFLINE).
 *
 * Covers the retention / orphan-reaping / save-failure-signal defects in the
 * ~/.qwen/tasks persistence layer (src/config.js, src/task_registry.js):
 *
 *   R1  QWEN_TASK_RETENTION_MS env override + floor clamp. The retention
 *       window is now env-configurable (default 7 days) but is ALWAYS clamped
 *       up to the invariant floor (DEFAULT_TIMEOUT_MS + 30min) so a live
 *       task's JSON can never be unlinked mid-run, even by a misconfiguration.
 *       Verified in a child process (config.js pins the value at import time,
 *       so each env setting needs its own process).
 *   R2  The sweeper (listTasksFromDisk) reaps an orphaned
 *       `task_*.json.tmp_<pid>_<ts>` file whose mtime is older than the
 *       retention window. These orphans (a saveTaskToDisk whose writeFileSync
 *       succeeded but whose renameSync never ran) never match the `.json`
 *       filter, so without this they accumulate forever.
 *   R3  A healthy `task_*.json` within the retention window SURVIVES the
 *       sweep (zero behavior change for fresh task files). A fresh tmp orphan
 *       within the window also survives.
 *   R4  saveTaskToDisk no longer silently swallows a save failure: it logs the
 *       path + error message to stderr and does NOT throw into the runner.
 *
 * Isolated (established pattern): QWEN_STATE_DIR is pinned to a fresh temp dir
 * BEFORE any src import so config.js pins TASK_DIR to the private dir. The
 * production ~/.qwen state is never read or written.
 *
 * Run: node tests/task_retention.test.js
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Isolate ALL on-disk state in a fresh temp dir BEFORE any src import so
// config.js pins QWEN_STATE_DIR (and TASK_DIR under it) to the private dir.
// The production ~/.qwen is never read or written.
//
// QWEN_TASK_RETENTION_MS is set to a value ABOVE the invariant floor
// (DEFAULT_TIMEOUT_MS + 30min = 16200000ms) so the reaping vectors below can
// age a file just past the window without waiting hours. 20000000ms (~5.5h)
// is above the 4.5h floor, so it is honored as-is (no clamp).
// ---------------------------------------------------------------------------
const TMP_STATE = fs.mkdtempSync(path.join(os.tmpdir(), "task_retention_"));
process.env.QWEN_STATE_DIR = TMP_STATE;
process.env.HOME = TMP_STATE;
process.env.QWEN_WSL_HOME = TMP_STATE;
process.env.QWEN_WIN_HOME = TMP_STATE;
process.env.QWEN_TASK_RETENTION_MS = "20000000"; // ~5.5h, above the 4.5h floor

const { TASK_DIR, TASK_RETENTION_MS, TASK_RETENTION_FLOOR_MS, DEFAULT_TIMEOUT_MS } =
  await import("../src/config.js");
const { listTasksFromDisk, saveTaskToDisk } = await import("../src/task_registry.js");

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
}, 60_000).unref();

// Set a file's mtime into the past (deterministic aging, no real waiting).
function ageFile(filePath, ageMs) {
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(filePath, t, t);
}

// ---------------------------------------------------------------------------
// R1: QWEN_TASK_RETENTION_MS env override + floor clamp (child process).
// config.js pins TASK_RETENTION_MS at import time, so each env setting needs
// its own process. We spawn `node --input-type=module -e` with the env set and
// read the computed value back from stdout.
// ---------------------------------------------------------------------------
function retentionChild(envValue) {
  const code =
    "import { TASK_RETENTION_MS, TASK_RETENTION_FLOOR_MS, DEFAULT_TIMEOUT_MS } from './src/config.js';" +
    "console.log(JSON.stringify({t:TASK_RETENTION_MS,f:TASK_RETENTION_FLOOR_MS,d:DEFAULT_TIMEOUT_MS}));";
  const env = { ...process.env };
  if (envValue === null) delete env.QWEN_TASK_RETENTION_MS;
  else env.QWEN_TASK_RETENTION_MS = envValue;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
      cwd: path.resolve(__dirname, ".."),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", () => resolve({ out, err }));
  });
}

async function testRetentionEnvOverride() {
  console.log("\n[R1] QWEN_TASK_RETENTION_MS env override + floor clamp");

  // (a) No env -> default 7 days (604800000).
  let r = await retentionChild(null);
  let j = JSON.parse(r.out);
  check("R1a: no env -> default 7 days", j.t === 604800000, `t=${j.t}`);
  check(
    "R1a: floor is DEFAULT_TIMEOUT_MS + 30min",
    j.f === j.d + 1_800_000,
    `f=${j.f} d=${j.d}`
  );

  // (b) Env above the floor -> honored as-is.
  r = await retentionChild("999999999");
  j = JSON.parse(r.out);
  check("R1b: env above floor honored", j.t === 999999999, `t=${j.t}`);

  // (c) Env below the floor -> clamped UP to the floor (invariant preserved).
  r = await retentionChild("1000");
  j = JSON.parse(r.out);
  check(
    "R1c: env below floor clamped to floor",
    j.t === j.f && j.f === 16200000,
    `t=${j.t} f=${j.f}`
  );

  // (d) Invalid (non-numeric) env -> falls back to the 7-day default.
  r = await retentionChild("not-a-number");
  j = JSON.parse(r.out);
  check("R1d: invalid env -> 7-day default", j.t === 604800000, `t=${j.t}`);

  // (e) Negative / zero env -> falls back to the 7-day default.
  r = await retentionChild("-5");
  j = JSON.parse(r.out);
  check("R1e: negative env -> 7-day default", j.t === 604800000, `t=${j.t}`);
}

// ---------------------------------------------------------------------------
// R2: an orphaned tmp file older than retention is reaped by the sweeper.
// ---------------------------------------------------------------------------
async function testTmpOrphanReaped() {
  console.log("\n[R2] orphaned .tmp_* older than retention is reaped");
  const orphanName = "task_orphan_reap.json.tmp_424242_1699999999999";
  const orphanPath = path.join(TASK_DIR, orphanName);
  fs.writeFileSync(orphanPath, '{"id":"task_orphan_reap","done":true}', "utf8");
  // Age it just past the 20000000ms retention window.
  ageFile(orphanPath, 21_000_000);

  listTasksFromDisk(); // triggers the retention sweep

  check(
    "R2: aged tmp orphan is unlinked",
    !fs.existsSync(orphanPath),
    `exists=${fs.existsSync(orphanPath)}`
  );
}

// ---------------------------------------------------------------------------
// R3: a healthy .json within retention SURVIVES (zero behavior change for
// fresh task files). A fresh tmp orphan within the window also survives.
// ---------------------------------------------------------------------------
async function testFreshFilesSurvive() {
  console.log("\n[R3] fresh .json and fresh tmp orphan within retention survive");
  const jsonName = "task_fresh_survive.json";
  const jsonPath = path.join(TASK_DIR, jsonName);
  // A valid, healthy, done task (so it is parsed, not quarantined).
  fs.writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        id: "task_fresh_survive",
        sessionId: "fresh",
        cwd: TMP_STATE,
        createdAt: Date.now(),
        startedAt: Date.now(),
        finishedAt: Date.now(),
        lastHeartbeatAt: Date.now(),
        status: "completed",
        done: true,
        isError: false,
        fileOps: [],
        toolCallsCount: 0,
        result: { isError: false, text: "ok" },
      },
      null,
      2
    ),
    "utf8"
  );
  // Fresh mtime (just written) -> within retention.

  const tmpName = "task_fresh_tmp_survive.json.tmp_515151_1700000000000";
  const tmpPath = path.join(TASK_DIR, tmpName);
  fs.writeFileSync(tmpPath, '{"id":"task_fresh_tmp_survive","done":true}', "utf8");
  // Fresh mtime -> within retention.

  const listed = listTasksFromDisk(); // triggers the retention sweep

  check("R3a: fresh .json within retention survives", fs.existsSync(jsonPath));
  check("R3b: fresh tmp orphan within retention survives", fs.existsSync(tmpPath));
  check(
    "R3c: the healthy .json is returned by the list",
    listed.some((t) => t && t.id === "task_fresh_survive"),
    `ids=${JSON.stringify(listed.map((t) => t && t.id))}`
  );

  // Clean up the survivors so later vectors start from a known state.
  try {
    fs.unlinkSync(jsonPath);
  } catch {}
  try {
    fs.unlinkSync(tmpPath);
  } catch {}
}

// ---------------------------------------------------------------------------
// R4: saveTaskToDisk no longer silently swallows a save failure — it logs the
// path + error to stderr and does NOT throw into the runner.
// ---------------------------------------------------------------------------
async function testSaveFailureLogging() {
  console.log("\n[R4] save-failure is logged to stderr and does not throw");
  const realWriteFileSync = fs.writeFileSync;
  const realConsoleError = console.error;
  const captured = [];
  console.error = (...args) => {
    captured.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  // Force the write to fail (simulates ENOSPC / EBUSY / permission).
  fs.writeFileSync = () => {
    throw new Error("simulated ENOSPC: no space left on device");
  };

  let threw = false;
  let throwMsg = "";
  try {
    saveTaskToDisk({
      id: "task_save_fail",
      sessionId: "sf",
      cwd: TMP_STATE,
      prompt: "p",
      createdAt: Date.now(),
      startedAt: Date.now(),
      finishedAt: null,
      lastHeartbeatAt: Date.now(),
      status: "executing",
      done: false,
      isError: false,
      fileOps: [],
      toolCallsCount: 0,
      result: null,
    });
  } catch (err) {
    threw = true;
    throwMsg = err && err.message ? err.message : String(err);
  } finally {
    fs.writeFileSync = realWriteFileSync;
    console.error = realConsoleError;
  }

  check("R4a: saveTaskToDisk did NOT throw into the runner", !threw, `threw=${threw} ${throwMsg}`);
  const joined = captured.join("\n");
  check(
    "R4b: failure logged to stderr",
    captured.length >= 1,
    `captured=${JSON.stringify(captured)}`
  );
  check(
    "R4c: log names the target path",
    joined.includes("task_save_fail.json"),
    joined
  );
  check(
    "R4d: log carries the underlying error message",
    joined.includes("simulated ENOSPC: no space left on device"),
    joined
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  await testRetentionEnvOverride();
  await testTmpOrphanReaped();
  await testFreshFilesSurvive();
  await testSaveFailureLogging();

  // Clean up the isolated state dir.
  fs.rmSync(TMP_STATE, { recursive: true, force: true });

  console.log("\n==========================================");
  console.log(`Task-Retention Tests: ${passed} PASSED, ${failed} FAILED`);
  console.log("==========================================");
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Task-retention test uncaught error:", err);
  process.exit(1);
});
