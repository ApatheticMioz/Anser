#!/usr/bin/env node
/**
 * E5 — session-end orphan reaping canary (fully OFFLINE, deterministic).
 *
 * Commit e7d542e added a bounded, idempotent sweep to EVERY task termination
 * path (success, error, cancel):
 *   1. killSessionProcessTreeSync(sessionId)  (src/wsl_bridge.js)
 *      — anchored pgrep -> /proc/<pid>/cmdline boundary verify -> kill -9,
 *      so a session id that is a substring of another session's id is never
 *      over-killed; a WSL command failure is surfaced (C1), not masked.
 *   2. clearReclaimableTaskSlots()             (src/semaphore.js)
 *      — reclaims only leases whose owner pid is dead or whose task is
 *      already terminal; a live owner's active lease is NEVER touched
 *      (LIVE-OWNER INVARIANT).
 *
 * This canary exercises both primitives directly (via the injected
 * setWslCommandSyncRunner fake — no real wsl.exe / bash subprocesses) and
 * the HTTP single-task cancel path in src/task_registry.js, which is where
 * e7d542e wired the sweep into the cancel flow (in-memory task and
 * disk-only task).
 *
 * Run: node tests/session_end_reap.test.js
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Isolate ALL on-disk state in a fresh temp dir BEFORE any src import so
// config.js pins QWEN_STATE_DIR (and TASK_DIR / SLOTS_DIR under it) to the
// private dir. The production ~/.qwen is never read or written.
// ---------------------------------------------------------------------------
const TMP_STATE = fs.mkdtempSync(path.join(os.tmpdir(), "session_end_reap_"));
process.env.QWEN_STATE_DIR = TMP_STATE;
process.env.HOME = TMP_STATE;
process.env.QWEN_WSL_HOME = TMP_STATE;
process.env.QWEN_WIN_HOME = TMP_STATE;
process.env.TEST_OFFLINE = "1";
// Bind the status HTTP server to a random free port (0) so the test is
// hermetic even when a live Anser instance holds the default 18021.
process.env.STATUS_PORT = "0";

const { TASK_DIR, SLOTS_DIR } = await import("../src/config.js");
const {
  killSessionProcessTreeSync,
  setWslCommandSyncRunner,
} = await import("../src/wsl_bridge.js");
const {
  clearReclaimableTaskSlots,
  pidAlive,
  releaseTaskSlot,
} = await import("../src/semaphore.js");
const {
  tasks,
  saveTaskToDisk,
  readTaskFromDisk,
  initStatusServer,
  statusHttpServer,
} = await import("../src/task_registry.js");

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
setTimeout(() => {
  console.error(`\nHARD WATCHDOG fired - forcing exit (failures=${failed})`);
  process.exit(failed === 0 ? 0 : 1);
}, 30_000).unref();

// ---------------------------------------------------------------------------
// Fake WSL command runner: records every command and answers pgrep /
// /proc/<pid>/cmdline queries from a scripted table. No real subprocess.
// ---------------------------------------------------------------------------
let wslCommands = [];
let pgrepTable = {}; // sessionId -> [pids]
let cmdlineTable = {}; // pid -> cmdline string
let failPgrep = false;

function installFakeWsl() {
  wslCommands = [];
  pgrepTable = {};
  cmdlineTable = {};
  failPgrep = false;
  setWslCommandSyncRunner((cmd) => {
    wslCommands.push(cmd);
    if (failPgrep && cmd.includes("pgrep")) {
      throw new Error("simulated WSL failure");
    }
    const pgrepMatch = cmd.match(/pgrep -f '(.*)'/);
    if (pgrepMatch) {
      const id = pgrepMatch[1];
      return Buffer.from((pgrepTable[id] || []).join(" "));
    }
    const procMatch = cmd.match(/< \/proc\/(\d+)\/cmdline/);
    if (procMatch) {
      const pid = procMatch[1];
      return Buffer.from(cmdlineTable[pid] ?? "");
    }
    return Buffer.from("");
  });
}

function resetFakeWsl() {
  setWslCommandSyncRunner(null);
}

// ---------------------------------------------------------------------------
// A. Anchored process-tree sweep: kill only exact-boundary matches.
// ---------------------------------------------------------------------------
function testSweepBoundary() {
  console.log("\n[A] killSessionProcessTreeSync: anchored boundary verification");
  installFakeWsl();
  pgrepTable["sess-a"] = [101, 102, 103];
  cmdlineTable[101] = "bash -c run --session sess-a --work";
  cmdlineTable[102] = "bash -c run --session sess-a1 --work"; // substring, NOT a boundary match
  cmdlineTable[103] = "bash -c run --session other-sess-a --work"; // substring, NOT a boundary match

  killSessionProcessTreeSync("sess-a");

  const killCmds = wslCommands.filter((c) => c.startsWith("kill -9"));
  check(
    "A1: exactly one kill command issued",
    killCmds.length === 1,
    `killCmds=${JSON.stringify(killCmds)}`
  );
  check(
    "A2: only the exact-boundary pid (101) was killed — substring pids 102/103 untouched",
    killCmds[0] === "kill -9 101 2>/dev/null || true",
    `got=${killCmds[0]}`
  );
  check(
    "A3: the sweep verified each candidate via /proc/<pid>/cmdline",
    wslCommands.some((c) => c.includes("/proc/101/cmdline")) &&
      wslCommands.some((c) => c.includes("/proc/102/cmdline")) &&
      wslCommands.some((c) => c.includes("/proc/103/cmdline")),
    `cmds=${JSON.stringify(wslCommands)}`
  );

  // No candidates at all -> no kill command, no throw.
  wslCommands = [];
  pgrepTable["sess-empty"] = [];
  killSessionProcessTreeSync("sess-empty");
  check(
    "A4: no candidates -> no kill command issued",
    !wslCommands.some((c) => c.startsWith("kill -9")),
    `cmds=${JSON.stringify(wslCommands)}`
  );
  resetFakeWsl();
}

// ---------------------------------------------------------------------------
// B. C1: a WSL command failure is surfaced, never masked as "no matches".
// ---------------------------------------------------------------------------
function testSweepFailureSurfaced() {
  console.log("\n[B] killSessionProcessTreeSync: WSL failure is surfaced (C1)");
  installFakeWsl();
  failPgrep = true;
  let threw = null;
  try {
    killSessionProcessTreeSync("sess-fail");
  } catch (err) {
    threw = err;
  }
  check(
    "B1: pgrep failure throws WslSweepError (not silently treated as no-matches)",
    threw instanceof Error && /WslSweepError/.test(threw.message),
    `threw=${threw && threw.message}`
  );
  resetFakeWsl();
}

// ---------------------------------------------------------------------------
// C. clearReclaimableTaskSlots: reclaims dead-owner / terminal / corrupt
//    leases; NEVER touches a live owner's active lease (LIVE-OWNER INVARIANT).
// ---------------------------------------------------------------------------
async function testSlotCleanup() {
  console.log("\n[C] clearReclaimableTaskSlots: LIVE-OWNER INVARIANT");
  fs.mkdirSync(SLOTS_DIR, { recursive: true });

  const deadPid = 2_000_000_000;
  if (pidAlive(deadPid)) {
    console.error(`[SKIP-C] pid ${deadPid} unexpectedly alive; cannot run deterministically`);
    process.exit(1);
  }

  const live = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    stdio: "ignore",
  });
  for (let i = 0; i < 50 && !pidAlive(live.pid); i++) await sleep(50);
  check("C0: live owner pid is actually alive", pidAlive(live.pid), `pid=${live.pid}`);

  const now = Date.now();
  const writeLease = (i, lease) =>
    fs.writeFileSync(path.join(SLOTS_DIR, `slot_${i}.json`), JSON.stringify(lease), "utf8");

  // slot_0: dead owner -> reclaimable.
  writeLease(0, { pid: deadPid, platform: process.platform, taskId: null, at: now, hb: now });
  // slot_1: live owner, active (non-terminal) task -> NOT reclaimable.
  const liveTask = {
    id: "task_live_lease",
    sessionId: "s_live_lease",
    cwd: TMP_STATE,
    prompt: "live owner task",
    ownerPid: live.pid,
    createdAt: now,
    startedAt: now,
    finishedAt: null,
    lastHeartbeatAt: now,
    status: "running",
    done: false,
    isError: false,
    result: null,
  };
  saveTaskToDisk(liveTask);
  writeLease(1, { pid: live.pid, platform: process.platform, taskId: "task_live_lease", at: now, hb: now });
  // slot_2: live owner but its task is already terminal -> zombie lease, reclaimable.
  const termTask = { ...liveTask, id: "task_term_lease", sessionId: "s_term_lease", done: true, status: "completed", isError: false, result: { isError: false, text: "done" } };
  saveTaskToDisk(termTask);
  writeLease(2, { pid: live.pid, platform: process.platform, taskId: "task_term_lease", at: now, hb: now });
  // slot_3: corrupt (truncated mid-write) -> reclaimable by convention.
  fs.writeFileSync(path.join(SLOTS_DIR, "slot_3.json"), '{"pid": 123, "trunc', "utf8");
  // slot_4: not a slot file -> must be ignored.
  fs.writeFileSync(path.join(SLOTS_DIR, "not_a_slot.json"), "{}", "utf8");

  clearReclaimableTaskSlots();

  check("C1: dead-owner lease (slot_0) was reclaimed", !fs.existsSync(path.join(SLOTS_DIR, "slot_0.json")));
  check(
    "C2: LIVE-OWNER INVARIANT — live owner's active lease (slot_1) was NOT touched",
    fs.existsSync(path.join(SLOTS_DIR, "slot_1.json")),
    "slot_1.json missing"
  );
  check("C3: terminal-task zombie lease (slot_2) was reclaimed", !fs.existsSync(path.join(SLOTS_DIR, "slot_2.json")));
  check("C4: corrupt lease (slot_3) was reclaimed", !fs.existsSync(path.join(SLOTS_DIR, "slot_3.json")));
  check("C5: non-slot file (not_a_slot.json) was ignored", fs.existsSync(path.join(SLOTS_DIR, "not_a_slot.json")));

  // Idempotency: a second sweep is a no-op and still never touches slot_1.
  clearReclaimableTaskSlots();
  check("C6: second sweep is idempotent (slot_1 still intact, others still gone)", fs.existsSync(path.join(SLOTS_DIR, "slot_1.json")) && !fs.existsSync(path.join(SLOTS_DIR, "slot_0.json")));

  try {
    live.kill();
  } catch {}
}

// ---------------------------------------------------------------------------
// D. HTTP single-task cancel (the e7d542e wiring in task_registry.js):
//    in-memory cancel releases the slot and marks the task terminal;
//    disk-only cancel runs the anchored sweep + slot cleanup.
// ---------------------------------------------------------------------------
function httpPost(port, pathname, method = "POST") {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: pathname, method, headers: { Connection: "close" } },
      (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

async function testHttpCancel() {
  console.log("\n[D] HTTP /task/:id/cancel: slot release + anchored sweep + slot cleanup");
  installFakeWsl();
  pgrepTable["s_disk_cancel"] = [201];
  cmdlineTable[201] = "bash -c run --session s_disk_cancel --work";

  initStatusServer();
  await new Promise((resolve, reject) => {
    statusHttpServer.once("listening", resolve);
    statusHttpServer.once("error", reject);
  });
  const port = statusHttpServer.address().port;
  check("D0: status server bound to a free port", typeof port === "number" && port > 0, `port=${port}`);

  try {
    // D1: in-memory task cancel.
    const now = Date.now();
    const memTask = {
      id: "task_mem_cancel",
      sessionId: "s_mem_cancel",
      cwd: TMP_STATE,
      prompt: "in-memory cancel",
      ownerPid: process.pid,
      createdAt: now,
      startedAt: now,
      lastHeartbeatAt: now,
      status: "running",
      done: false,
      isError: false,
      result: null,
      waiters: [],
      child: null,
      abortController: null,
    };
    tasks.set(memTask.id, memTask);
    // Simulate a held slot lease owned by this process.
    fs.mkdirSync(SLOTS_DIR, { recursive: true });
    const leaseFile = path.join(SLOTS_DIR, "slot_0.json");
    const fd = fs.openSync(leaseFile, "wx");
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, platform: process.platform, taskId: memTask.id, at: now, hb: now }));
    fs.closeSync(fd);
    memTask.slot = { file: leaseFile, refresh: setInterval(() => {}, 60_000) };
    memTask.slot.refresh.unref();

    const r1 = await httpPost(port, `/task/${memTask.id}/cancel`);
    check("D1: in-memory cancel returns 200 {cancelled:true}", r1.status === 200 && JSON.parse(r1.body).cancelled === true, `status=${r1.status} body=${r1.body}`);
    check("D2: in-memory task is terminal cancelled", memTask.done === true && memTask.status === "cancelled" && memTask.isError === true, `done=${memTask.done} status=${memTask.status}`);
    check("D3: in-memory cancel released the slot lease", !fs.existsSync(leaseFile), "slot_0.json still present");
    check("D4: task.slot handle cleared after release", memTask.slot === null);

    // D2: disk-only task cancel (owner dead) -> anchored sweep + slot cleanup.
    const deadPid = 2_000_000_000;
    const diskTask = {
      id: "task_disk_cancel",
      sessionId: "s_disk_cancel",
      cwd: TMP_STATE,
      prompt: "disk-only cancel",
      ownerPid: deadPid,
      ownerPlatform: process.platform,
      createdAt: now,
      startedAt: now,
      lastHeartbeatAt: now,
      status: "running",
      done: false,
      isError: false,
      result: null,
    };
    saveTaskToDisk(diskTask);
    // A dead-owner zombie lease that the cancel path must clear.
    fs.mkdirSync(SLOTS_DIR, { recursive: true });
    fs.writeFileSync(path.join(SLOTS_DIR, "slot_1.json"), JSON.stringify({ pid: deadPid, platform: process.platform, taskId: "task_disk_cancel", at: now, hb: now }), "utf8");

    const r2 = await httpPost(port, `/task/${diskTask.id}/cancel`);
    check("D5: disk-only cancel returns 200 {cancelled:true}", r2.status === 200 && JSON.parse(r2.body).cancelled === true, `status=${r2.status} body=${r2.body}`);
    const onDisk = readTaskFromDisk("task_disk_cancel");
    check("D6: disk task file is now terminal cancelled", onDisk && onDisk.done === true && onDisk.status === "cancelled" && onDisk.isError === true, `done=${onDisk && onDisk.done} status=${onDisk && onDisk.status}`);
    check(
      "D7: disk-only cancel ran the anchored sweep for the task's session",
      wslCommands.some((c) => c.includes("pgrep") && c.includes("s_disk_cancel")),
      `cmds=${JSON.stringify(wslCommands.filter((c) => c.includes("pgrep")))}`
    );
    check(
      "D8: disk-only cancel killed only the exact-boundary pid (201)",
      wslCommands.some((c) => c === "kill -9 201 2>/dev/null || true"),
      `killCmds=${JSON.stringify(wslCommands.filter((c) => c.startsWith("kill -9")))}`
    );
    check("D9: disk-only cancel cleared the dead-owner zombie lease (slot_1)", !fs.existsSync(path.join(SLOTS_DIR, "slot_1.json")));
  } finally {
    resetFakeWsl();
    await new Promise((resolve) => statusHttpServer.close(resolve));
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  try {
    testSweepBoundary();
    testSweepFailureSurfaced();
    await testSlotCleanup();
    await testHttpCancel();
  } finally {
    fs.rmSync(TMP_STATE, { recursive: true, force: true });
  }

  console.log("\n==========================================");
  console.log(`Session-End-Reap (E5) Tests: ${passed} PASSED, ${failed} FAILED`);
  console.log("==========================================");
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Session-end-reap test uncaught error:", err);
  process.exit(1);
});
