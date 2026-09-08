#!/usr/bin/env node
/**
 * FX3 + FX5 — status-server / task-lifecycle hardening (fully OFFLINE).
 *
 * Covers the four confirmed defects in the status-server / task-lifecycle
 * domain, using the repo's established offline patterns (isolated
 * QWEN_STATE_DIR temp dir, mocked globalThis.fetch, injected WSL runner,
 * check() counters, hard watchdog). No real vLLM, no real WSL, no real
 * 18021/18020 traffic, and the production ~/.qwen state is never touched.
 *
 *   F2  (FX3-A)  qwen_task status: the QUEUED and EXECUTING branches used to
 *                reference an undeclared `elapsed_s` -> ReferenceError. Now
 *                elapsed is computed once before the dispatch; the payload for
 *                a queued AND an executing task carries a correct elapsed and
 *                does not throw.
 *   F1  (FX3-B)  status-server keeper re-election: the pure decision function
 *                decideElection(healthBody, owned), the probeStatusHealth
 *                fetch wrapper, and the re-listen wiring (dark -> win, our
 *                identity -> stay follower, EADDRINUSE -> stay follower, no
 *                throw).
 *   D6  (FX5-A)  cancel releases the goose slot: a cancelled task frees its
 *                slot immediately, a second acquire succeeds, and releasing an
 *                already-released slot is an idempotent no-op (distinguishable
 *                result, never a throw).
 *   D7  (FX5-B)  stopServer honesty: a still-responding engine yields
 *                {stopped:false, reason:"engine_still_responding"}; a dead
 *                engine yields {stopped:true}.
 *
 * Run: node tests/status_lifecycle.test.js
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import assert from "node:assert";

// ---------------------------------------------------------------------------
// Isolate ALL on-disk state in a fresh temp dir BEFORE any src import so
// config.js pins QWEN_STATE_DIR (and SLOTS_DIR under it) to the private dir.
// The production ~/.qwen (C:\Users\<user>\.qwen) is never read or written.
// ---------------------------------------------------------------------------
const TMP_STATE = fs.mkdtempSync(path.join(os.tmpdir(), "status_lifecycle_"));
process.env.QWEN_STATE_DIR = TMP_STATE;
process.env.HOME = TMP_STATE;
process.env.QWEN_WSL_HOME = TMP_STATE;
process.env.QWEN_WIN_HOME = TMP_STATE;

const { STATUS_PORT } = await import("../src/config.js");
const taskRegistry = await import("../src/task_registry.js");
const {
  tasks,
  cancelAllTasks,
  decideElection,
  probeStatusHealth,
  attemptStatusReListen,
  startStatusServerElection,
  statusHttpServer,
  STATUS_SERVICE_IDENTITY,
} = taskRegistry;
// NOTE: `statusServerOwned` is a module `let` that the module reassigns at
// runtime (boot listen / re-election). Destructuring it would snapshot the
// import-time value (frozen at false). Read it through the live namespace
// object (taskRegistry.statusServerOwned) so the test observes the real
// current ownership state.
const { acquireGooseSlot, releaseGooseSlot, listGooseSlots } = await import(
  "../src/semaphore.js"
);
const { stopServer, setWslRunner } = await import("../src/server_lifecycle.js");
const { registerTools } = await import("../src/tools.js");

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
async function waitFor(cond, timeoutMs = 3000, stepMs = 20) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return true;
    await sleep(stepMs);
  }
  return cond();
}
// Hard watchdog: force termination so a wedged check can never hang the suite.
setTimeout(() => {
  console.error(`\nHARD WATCHDOG fired - forcing exit (failures=${failed})`);
  process.exit(failed === 0 ? 0 : 1);
}, 60_000).unref();

// Find a free loopback port (listen on 0, read the assigned port, close).
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}
// Occupy a port with a throwaway HTTP server (for the EADDRINUSE vector).
function occupyPort(port) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", service: "foreign-occupant" }));
    });
    srv.once("error", reject);
    srv.listen(port, "127.0.0.1", () => resolve(srv));
  });
}

// ---------------------------------------------------------------------------
// F2 (FX3-A): qwen_task status — queued AND executing payloads carry a correct
// elapsed and do NOT throw (the old `elapsed_s` ReferenceError).
// ---------------------------------------------------------------------------
console.log("\n[F2] qwen_task status elapsed (queued + executing)");
{
  const tools = {};
  const fakeServer = {
    registerTool: (name, _schema, handler) => {
      tools[name] = handler;
    },
  };
  registerTools(fakeServer);
  const qwenTask = tools["qwen_task"];
  assert.ok(qwenTask, "qwen_task tool is registered");

  const now = Date.now();
  // A queued task: 60s since createdAt, never started.
  const queued = {
    id: "task_f2_queued",
    sessionId: "f2q",
    cwd: TMP_STATE,
    createdAt: now - 60_000,
    startedAt: null,
    finishedAt: null,
    status: "queued",
    done: false,
    isError: false,
    toolCallsCount: 0,
    result: null,
  };
  // An executing task: started 30s ago, still running.
  const executing = {
    id: "task_f2_exec",
    sessionId: "f2e",
    cwd: TMP_STATE,
    createdAt: now - 90_000,
    startedAt: now - 30_000,
    finishedAt: null,
    status: "executing",
    done: false,
    isError: false,
    toolCallsCount: 4,
    result: null,
  };
  tasks.set(queued.id, queued);
  tasks.set(executing.id, executing);

  // (a) queued: must not throw, must report a ~60s wait.
  let queuedRes;
  let queuedThrew = false;
  try {
    queuedRes = await qwenTask({ action: "status", task_id: queued.id });
  } catch (err) {
    queuedThrew = true;
    queuedRes = { __err: err };
  }
  check("F2a: queued status does not throw", !queuedThrew, queuedRes?.__err?.message);
  const qText = queuedRes?.content?.[0]?.text ?? "";
  const qElapsed = Number((qText.match(/(\d+)s waiting/) || [])[1]);
  check("F2a: queued payload says QUEUED", /QUEUED/.test(qText), qText.slice(0, 80));
  check(
    "F2a: queued elapsed ~60s (55-65)",
    Number.isFinite(qElapsed) && qElapsed >= 55 && qElapsed <= 65,
    `elapsed=${qElapsed}`
  );

  // (b) executing: must not throw, must report a ~30s elapsed.
  let execRes;
  let execThrew = false;
  try {
    execRes = await qwenTask({ action: "status", task_id: executing.id });
  } catch (err) {
    execThrew = true;
    execRes = { __err: err };
  }
  check("F2b: executing status does not throw", !execThrew, execRes?.__err?.message);
  const eText = execRes?.content?.[0]?.text ?? "";
  const eElapsed = Number((eText.match(/(\d+)s elapsed/) || [])[1]);
  check("F2b: executing payload says EXECUTING", /EXECUTING/.test(eText), eText.slice(0, 80));
  check(
    "F2b: executing elapsed ~30s (25-35)",
    Number.isFinite(eElapsed) && eElapsed >= 25 && eElapsed <= 35,
    `elapsed=${eElapsed}`
  );

  // Clean up so later tests start from a known task set.
  tasks.delete(queued.id);
  tasks.delete(executing.id);
}

// ---------------------------------------------------------------------------
// D6 (FX5-A): cancel releases the goose slot; release is idempotent.
// ---------------------------------------------------------------------------
console.log("\n[D6] cancel releases the goose slot (idempotent release)");
{
  // A fake queued task that holds the single goose slot.
  const task = {
    id: "task_d6_slot",
    sessionId: "d6",
    cwd: TMP_STATE,
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    status: "queued",
    done: false,
    isError: false,
    result: null,
  };
  tasks.set(task.id, task);

  const slot = await acquireGooseSlot(task);
  check("D6: task acquired a goose slot", !!slot);
  if (slot) {
    // runQueued records the live handle on the task entry; mirror that here.
    task.slot = slot;
  }
  check("D6: slot is held (1 active lease)", listGooseSlots().length === 1, `n=${listGooseSlots().length}`);

  // Cancel it (cancelAllTasks cancels every not-done in-memory task).
  const cancelled = await cancelAllTasks("test cancel");
  check("D6: cancelAllTasks cancelled the task", cancelled >= 1, `count=${cancelled}`);
  check("D6: task marked done+cancelled", task.done === true && task.status === "cancelled");
  check("D6: slot released on cancel (0 active leases)", listGooseSlots().length === 0, `n=${listGooseSlots().length}`);

  // A second acquire now succeeds (the slot is free again).
  const slot2 = await acquireGooseSlot({ id: "task_d6_second" });
  check("D6: second acquire succeeds after cancel", !!slot2);
  if (slot2) releaseGooseSlot(slot2);
  check("D6: no leases remain after second release", listGooseSlots().length === 0);

  // Idempotent release: releasing the already-released slot is a no-op with a
  // distinguishable result, NOT a throw.
  let idem;
  let idemThrew = false;
  try {
    idem = releaseGooseSlot(slot);
  } catch (err) {
    idemThrew = true;
    idem = { __err: err };
  }
  check("D6: re-release does not throw", !idemThrew, idem?.__err?.message);
  check(
    "D6: re-release is an idempotent no-op",
    idem && idem.released === false && idem.reason === "already_released",
    JSON.stringify(idem)
  );
  // Releasing null is also a clean no-op.
  const nullRes = releaseGooseSlot(null);
  check("D6: release(null) is a clean no-op", nullRes.released === false && nullRes.reason === "no_slot", JSON.stringify(nullRes));

  tasks.delete(task.id);
}

// ---------------------------------------------------------------------------
// D6b (FX5-A): the INLINE single-task cancel path — qwen_task action:"cancel"
// on a locally-owned task — must also release the slot. For a wedged task the
// runner's finally never fires (the fn never returns), so this path is the
// ONLY thing standing between a cancel and hours of slot starvation.
// ---------------------------------------------------------------------------
console.log("\n[D6b] inline qwen_task cancel releases the slot");
{
  const tools = {};
  registerTools({
    registerTool: (name, _schema, handler) => {
      tools[name] = handler;
    },
  });
  assert.ok(tools["qwen_task"], "qwen_task tool is registered");

  const task = {
    id: "task_d6b_inline",
    sessionId: "d6b",
    cwd: TMP_STATE,
    createdAt: Date.now(),
    startedAt: Date.now(),
    finishedAt: null,
    status: "executing",
    done: false,
    isError: false,
    result: null,
    child: null, // native task: no goose subprocess; killProcessTree is a no-op
    abortController: null,
  };
  tasks.set(task.id, task);

  const slot = await acquireGooseSlot(task);
  check("D6b: task acquired a goose slot", !!slot);
  task.slot = slot; // runQueued records the live handle; mirror it here.
  check("D6b: slot is held (1 active lease)", listGooseSlots().length === 1, `n=${listGooseSlots().length}`);

  const cancelRes = await tools["qwen_task"]({ action: "cancel", task_id: task.id });
  check("D6b: tool reported the cancellation", /cancelled/.test(cancelRes?.content?.[0]?.text || ""));
  check("D6b: task marked done+cancelled", task.done === true && task.status === "cancelled");
  check("D6b: slot released by inline cancel (0 active leases)", listGooseSlots().length === 0, `n=${listGooseSlots().length}`);
  check("D6b: task.slot handle cleared", task.slot === null);
  tasks.delete(task.id);
}

// ---------------------------------------------------------------------------
// F1 (FX3-B): status-server keeper re-election.
// ---------------------------------------------------------------------------
console.log("\n[F1] status-server keeper re-election");
{
  // (1) decideElection — the pure decision function.
  check("F1: identity constant is mcp-qwen-status", STATUS_SERVICE_IDENTITY === "mcp-qwen-status");
  check("F1: owned=true -> stay (owner path untouched)", decideElection({ service: "mcp-qwen-status" }, true) === "stay");
  check("F1: owned=true -> stay even if body is null", decideElection(null, true) === "stay");
  check("F1: dark port (null) + follower -> takeover", decideElection(null, false) === "takeover");
  check(
    "F1: our identity + follower -> stay (healthy keeper)",
    decideElection({ status: "ok", service: "mcp-qwen-status", port: STATUS_PORT }, false) === "stay"
  );
  check("F1: foreign identity + follower -> foreign (never fight it)", decideElection({ service: "some-other-service" }, false) === "foreign");
  check("F1: malformed body (no service) + follower -> foreign (fail-closed)", decideElection({ status: "ok" }, false) === "foreign");

  // (2) probeStatusHealth — the fetch wrapper (mocked fetch, no real network).
  const realFetch = globalThis.fetch;
  let probeFetchLog = [];
  globalThis.fetch = async (url, _opts) => {
    probeFetchLog.push(String(url));
    const u = String(url);
    if (u.includes("/health")) {
      // Simulate a dark port: connection refused.
      throw new Error("ECONNREFUSED");
    }
    return { ok: true, status: 200, text: async () => "{}" };
  };
  const darkBody = await probeStatusHealth(STATUS_PORT, 500);
  check("F1: probe of a dark port returns null (no throw)", darkBody === null);
  check("F1: probe hit the /health endpoint", probeFetchLog.some((u) => u.includes("/health")));

  // A healthy keeper with our identity.
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ status: "ok", service: "mcp-qwen-status", port: STATUS_PORT }),
  });
  const ourBody = await probeStatusHealth(STATUS_PORT, 500);
  check("F1: probe of our keeper returns the identity body", ourBody && ourBody.service === "mcp-qwen-status");
  globalThis.fetch = realFetch;

  // (3) attemptStatusReListen — EADDRINUSE -> stays follower, no throw.
  const occPort = await getFreePort();
  const occupant = await occupyPort(occPort);
  let eai;
  let eaiThrew = false;
  try {
    eai = await attemptStatusReListen(occPort);
  } catch (err) {
    eaiThrew = true;
    eai = { __err: err };
  }
  check("F1: re-listen on an occupied port does not throw", !eaiThrew, eai?.__err?.message);
  check("F1: re-listen on an occupied port -> false (stays follower)", eai === false, `got=${eai}`);
  check("F1: statusServerOwned still false after EADDRINUSE", taskRegistry.statusServerOwned === false);
  occupant.close();

  // (4) startStatusServerElection wiring — follower sees OUR identity -> stays
  //     follower (no re-listen, statusServerOwned stays false).
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ status: "ok", service: "mcp-qwen-status", port: STATUS_PORT }),
  });
  const stayPort = await getFreePort();
  const stayTimer = startStatusServerElection({ intervalMs: 20, port: stayPort });
  check("F1: election timer started (unref'd) for a follower", !!stayTimer);
  await sleep(120); // several ticks
  check("F1: healthy keeper with our identity -> stays follower", taskRegistry.statusServerOwned === false);
  if (stayTimer) clearInterval(stayTimer);
  globalThis.fetch = realFetch;

  // (4b) startStatusServerElection wiring — follower sees a FOREIGN identity
  // -> must NOT attempt a re-listen (no fight), stays follower. EADDRINUSE
  // would also keep it a follower, so assert the ownership flag never flips
  // while a foreign service holds the port across several ticks.
  console.log("[F1-4b] follower vs FOREIGN occupant -> stays follower, no fight");
  {
    const foreignPort = await getFreePort();
    const foreignOcc = await occupyPort(foreignPort);
    const ownedBefore = taskRegistry.statusServerOwned === true;
    assert.ok(!ownedBefore, "precondition: this test process is a status follower");
    let foreignErrs = 0;
    const origErr = console.error;
    console.error = (...args) => {
      if (String(args[0] || "").includes("foreign service")) foreignErrs++;
    };
    const foreignTimer = startStatusServerElection({ intervalMs: 20, port: foreignPort });
    await new Promise((r) => setTimeout(r, 120)); // ~6 ticks
    if (foreignTimer) clearInterval(foreignTimer);
    console.error = origErr;
    foreignOcc.close();
    assert.strictEqual(
      taskRegistry.statusServerOwned,
      false,
      "follower must NOT take the port from a foreign service"
    );
    assert.ok(foreignErrs >= 1, `foreign occupation reported loudly (got ${foreignErrs} reports)`);
    console.log("  [PASS] F1: foreign occupant -> no takeover, loud report");
  }

  // (5) startStatusServerElection wiring — follower sees a DARK port ->
  //     re-listens and WINS (becomes owner). This is the last F1 case so the
  //     shared statusHttpServer / statusServerOwned can be left in the owned
  //     state without affecting earlier checks.
  const winPort = await getFreePort();
  globalThis.fetch = async () => {
    // Dark port: connection refused.
    throw new Error("ECONNREFUSED");
  };
  const winTimer = startStatusServerElection({ intervalMs: 20, port: winPort });
  const won = await waitFor(() => taskRegistry.statusServerOwned === true, 3000);
  check("F1: dark port -> re-listen wins, becomes owner", won, `statusServerOwned=${taskRegistry.statusServerOwned}`);
  if (winTimer) clearInterval(winTimer);
  globalThis.fetch = realFetch;
  // Clean up the now-listening status server.
  await new Promise((res) => {
    try {
      statusHttpServer.close(res);
    } catch {
      res();
    }
  });
}

// ---------------------------------------------------------------------------
// D7 (FX5-B): stopServer honesty.
// ---------------------------------------------------------------------------
console.log("\n[D7] stopServer honesty");
{
  const realFetch = globalThis.fetch;
  let wslCalls = [];
  setWslRunner(async (cmd) => {
    wslCalls.push(cmd);
    return { stdout: "", stderr: "" };
  });

  // (a) Engine STILL responds after the grace window -> honest failure.
  let engineUp = true;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/models")) {
      if (!engineUp) throw new Error("ECONNREFUSED");
      return { ok: true, status: 200, json: async () => ({ data: [{ max_model_len: 245760 }] }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const aliveRes = await stopServer();
  check("D7a: stop invoked the stop script", wslCalls.some((c) => c.includes("stop_server.sh")));
  check("D7a: still-responding engine -> stopped:false", aliveRes.stopped === false, JSON.stringify(aliveRes));
  check(
    "D7a: reason is engine_still_responding",
    aliveRes.reason === "engine_still_responding",
    `reason=${aliveRes.reason}`
  );

  // (b) Dead engine -> honest success (early exit on the first poll).
  engineUp = false;
  const deadRes = await stopServer();
  check("D7b: dead engine -> stopped:true", deadRes.stopped === true, JSON.stringify(deadRes));
  check("D7b: no spurious reason on success", deadRes.reason === undefined);

  globalThis.fetch = realFetch;
  setWslRunner(null);
}

// ---------------------------------------------------------------------------
// Summary + cleanup.
// ---------------------------------------------------------------------------
fs.rmSync(TMP_STATE, { recursive: true, force: true });
console.log("\n==========================================");
console.log(`Status-Lifecycle Completed: ${passed} PASSED, ${failed} FAILED`);
console.log("==========================================");
process.exit(failed === 0 ? 0 : 1);
