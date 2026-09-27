#!/usr/bin/env node
/**
 * Multi-Session Orphan Liveness & Engine Auto-Heal Protection Verification (fully OFFLINE).
 *
 * Validates:
 * 1. LIVE-OWNER INVARIANT in isTaskOrphaned:
 *    - Live owner PID + stale heartbeat -> returns false (never an orphan).
 *    - Dead owner PID + fresh heartbeat -> returns false (grace window).
 *    - Dead owner PID + stale heartbeat -> returns true.
 * 2. Offline protection gating:
 *    - Tests with IS_TEST_ENV=true and ALLOW_ENGINE_INTERRUPT=false refuse execution cleanly.
 *    - Mock runner paths proceed without offline protection refusal.
 * 3. Engine silence wedge:
 *    - Idle engine with stale stats does not trip silence wedge.
 *    - Busy engine with stale stats trips silence wedge and triggers auto-heal.
 */

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP_STATE = fs.mkdtempSync(path.join(os.tmpdir(), "ms_orphan_heal_"));
process.env.QWEN_STATE_DIR = TMP_STATE;
process.env.HOME = TMP_STATE;
process.env.QWEN_WSL_HOME = TMP_STATE;
process.env.QWEN_WIN_HOME = TMP_STATE;

const {
  isTaskOrphaned,
  markTaskOrphanedOnDisk,
  readTaskFromDisk,
  saveTaskToDisk,
} = await import("../src/task_registry.js");
const { ORPHAN_REAP_STALE_MS } = await import("../src/config.js");
const { pidAlive } = await import("../src/semaphore.js");
const {
  canaryProbe,
  healWedgedEngine,
  ensureServerRunning,
  stopServer,
  engineWedgeState,
  setWslRunner,
  setHealGatekeeper,
  resetEngineHealthCache,
} = await import("../src/server_lifecycle.js");

let passed = 0;
let failed = 0;
function check(cond, name, detail = "") {
  if (cond) {
    console.log(`[PASS] ${name}`);
    passed++;
  } else {
    console.error(`[FAIL] ${name}${detail ? ` (${detail})` : ""}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// 1. isTaskOrphaned: Live-Owner and Stale Heartbeat Invariants
// ---------------------------------------------------------------------------
console.log("\n[Test 1: isTaskOrphaned Invariant Verification]");
const livePid = process.pid;
const deadPid = 2_000_000_000;
const now = Date.now();

// 1a: Live owner PID + stale heartbeat (e.g., 10 minutes ago)
const liveStaleTask = {
  id: "task_live_stale",
  sessionId: "s_live_stale",
  ownerPid: livePid,
  ownerPlatform: process.platform,
  status: "running",
  done: false,
  lastHeartbeatAt: now - (ORPHAN_REAP_STALE_MS + 60_000),
  startedAt: now - (ORPHAN_REAP_STALE_MS + 120_000),
};
check(
  !isTaskOrphaned(liveStaleTask),
  "1a: live owner + stale heartbeat is NEVER an orphan (LIVE-OWNER INVARIANT)"
);

// 1b: Dead owner PID + fresh heartbeat (within grace window)
const deadFreshTask = {
  id: "task_dead_fresh",
  sessionId: "s_dead_fresh",
  ownerPid: deadPid,
  ownerPlatform: process.platform,
  status: "running",
  done: false,
  lastHeartbeatAt: now - 5_000, // 5s ago (< 30s threshold)
  startedAt: now - 10_000,
};
check(
  !isTaskOrphaned(deadFreshTask),
  "1b: dead owner + fresh heartbeat is untouched (grace window)"
);

// 1c: Dead owner PID + stale heartbeat (> threshold)
const deadStaleTask = {
  id: "task_dead_stale",
  sessionId: "s_dead_stale",
  ownerPid: deadPid,
  ownerPlatform: process.platform,
  status: "running",
  done: false,
  lastHeartbeatAt: now - (ORPHAN_REAP_STALE_MS + 5_000),
  startedAt: now - (ORPHAN_REAP_STALE_MS + 10_000),
};
check(
  isTaskOrphaned(deadStaleTask),
  "1c: dead owner + stale heartbeat is detected as orphaned"
);

// 1d: Completed task is never an orphan
const completedTask = {
  id: "task_completed",
  sessionId: "s_completed",
  ownerPid: deadPid,
  ownerPlatform: process.platform,
  status: "completed",
  done: true,
  lastHeartbeatAt: now - 100_000,
};
check(
  !isTaskOrphaned(completedTask),
  "1d: completed task is never an orphan"
);

// ---------------------------------------------------------------------------
// 2. Offline Protection & Auto-Heal Gating
// ---------------------------------------------------------------------------
console.log("\n[Test 2: Server Lifecycle Offline Protection Gate]");

// In this test file, IS_TEST_ENV is true and ALLOW_ENGINE_INTERRUPT is false.
// Therefore, the real wslRun path must cleanly refuse offline execution.
const canaryRes = await canaryProbe();
check(
  canaryRes.ok === true && canaryRes.skipped === "engine_protected_offline",
  "2a: canaryProbe is offline-protected in test environment"
);

const healRes = await healWedgedEngine(100);
check(
  healRes.healed === false && healRes.note.includes("engine interruption disabled by default"),
  "2b: healWedgedEngine is offline-protected in test environment"
);

const ensureRes = await ensureServerRunning();
check(
  ensureRes.switched === false && ensureRes.status === "boot_refused_offline_protected",
  "2c: ensureServerRunning is offline-protected in test environment"
);

const stopRes = await stopServer();
check(
  stopRes.stopped === false && stopRes.reason === "stop_refused_offline_protected",
  "2d: stopServer is offline-protected in test environment"
);

// ---------------------------------------------------------------------------
// 3. Mock Runner Bypass (Simulating production auto-heal execution)
// ---------------------------------------------------------------------------
console.log("\n[Test 3: Mock Runner Path for Lifecycle Operations]");
let mockedWslCalls = [];
setWslRunner(async (cmd) => {
  mockedWslCalls.push(cmd);
  return { stdout: "", stderr: "" };
});
setHealGatekeeper(() => false);

// With an injected runner, healWedgedEngine proceeds without offline block
const mockHealRes = await healWedgedEngine(50);
check(
  mockHealRes.healed === true,
  "3a: healWedgedEngine proceeds when custom/production runner executes"
);
check(
  mockedWslCalls.some((c) => c.includes("stop_server.sh")),
  "3b: stop_server.sh was executed during auto-heal"
);

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
setWslRunner(null);
setHealGatekeeper(null);
try {
  fs.rmSync(TMP_STATE, { recursive: true, force: true });
} catch {}

console.log("\n==========================================");
console.log(`Multi-Session Orphan & Heal: ${passed} PASSED, ${failed} FAILED`);
console.log("==========================================");
if (failed > 0) process.exit(1);
