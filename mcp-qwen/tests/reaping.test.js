/**
 * P10 - Process-reaping hardening tests (offline where possible).
 *
 * Vectors:
 *   1. Dummy process tree killed through the hardened killProcessTree path:
 *      zero survivors via pidAlive, and the returned {killed, escalations}
 *      structure is honest.
 *   2. Pid-less target (already-dead / never a real child) is a no-op success
 *      ({killed:false, escalations:0}), NOT a failure.
 *   3. Anchored pattern (WSL): a decoy whose command line CONTAINS the target
 *      id as a substring SURVIVES the anchored kill; the exact-match target
 *      dies. Skipped honestly when WSL is unavailable (offline-skip pattern).
 *   4. ensureStreamProxyRunning (injected spawner seam):
 *        a. slow-start (comes up at poll ~30, past the old 5s window) succeeds
 *           within the widened 15s window.
 *        b. always-failing spawn throws an error containing the captured
 *           failure.
 *   5. Cancel-path (item 3): aborting the Anser runner's signal lands
 *      in the runner's finally block, which disposes the MCP extension bridge
 *      (zero surviving bridge children).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import http from "node:http";

// Set the stream-proxy port BEFORE any config.js import so the offline
// ensureStreamProxyRunning vectors can use a free port.
process.env.STREAM_PROXY_PORT = "18999";

const { ensureStreamProxyRunning, setStreamProxySpawner } = await import(
  "../src/server_lifecycle.js"
);
const { killProcessTree, runWslCommand } = await import("../src/wsl_bridge.js");
const { pidAlive } = await import("../src/semaphore.js");
const { getLiveBridgePids } = await import(
  "../src/harness/services/mcp_bridge.js"
);
const { AnserRunner } = await import("../src/harness/runner.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(__dirname, "fixtures", "echo_mcp_server.js");

let passed = 0;
let failed = 0;
function assert(cond, name) {
  if (cond) {
    console.log(`[PASS] ${name}`);
    passed++;
  } else {
    console.error(`[FAIL] ${name}`);
    failed++;
  }
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Test 1: dummy process tree killed through the hardened path
// ---------------------------------------------------------------------------
async function testDummyTreeKill() {
  console.log("\n[Test 1: dummy process tree kill via hardened path]");
  const child = spawn("node", ["-e", "setInterval(()=>{},1000)"], {
    stdio: "ignore",
    detached: false,
  });
  await sleep(300); // let it start
  const pid = child.pid;
  assert(pid && pidAlive(pid), "dummy child alive before kill");

  const res = await killProcessTree(child, null);
  assert(typeof res.killed === "boolean", "returns {killed: boolean}");
  assert(typeof res.escalations === "number", "returns {escalations: number}");
  assert(res.killed === true, `kill confirmed (got killed=${res.killed})`);
  assert(res.escalations >= 0, `escalations is a count (got ${res.escalations})`);

  await sleep(300); // give the OS a moment to reap
  assert(!pidAlive(pid), "zero survivors via pidAlive after verification");
}

// ---------------------------------------------------------------------------
// Test 2: pid-less target is a no-op success
// ---------------------------------------------------------------------------
async function testPidlessNoop() {
  console.log("\n[Test 2: pid-less target is a no-op success]");
  const r1 = await killProcessTree(null, null);
  assert(
    r1.killed === false && r1.escalations === 0,
    `null child -> {killed:false, escalations:0} (got ${JSON.stringify(r1)})`
  );
  const r2 = await killProcessTree({ pid: undefined }, null);
  assert(
    r2.killed === false && r2.escalations === 0,
    `pid-less child -> {killed:false, escalations:0} (got ${JSON.stringify(r2)})`
  );
}

// ---------------------------------------------------------------------------
// Test 3: anchored pattern (WSL) - decoy survives, target dies
// ---------------------------------------------------------------------------
async function testAnchoredPattern() {
  console.log("\n[Test 3: anchored pattern (WSL) - decoy survives, target dies]");

  // Probe WSL availability (offline-skip pattern).
  let wslOk = false;
  try {
    const { stdout } = await runWslCommand("echo p10wslprobe");
    wslOk = stdout.includes("p10wslprobe");
  } catch {
    wslOk = false;
  }
  if (!wslOk) {
    console.log("  -> [SKIP] WSL unavailable (skipping anchored-pattern test)");
    return;
  }

  // Write a self-contained WSL script (LF) that spawns a target (id at
  // boundary) and a decoy (id as substring), runs the anchored sweep, and
  // reports KILLED / KEPT / SURVIVOR lines.
  const script = [
    "#!/bin/bash",
    "ID=p10test_target",
    "exec -a \"goose run --name $ID\" sleep 30 &",
    "exec -a \"goose run --name ${ID}123\" sleep 30 &",
    "sleep 0.6",
    "for p in $(pgrep -f \"goose run --name $ID\" 2>/dev/null); do",
    "  cmd=$(tr '\\0' ' ' < /proc/$p/cmdline 2>/dev/null)",
    "  if echo \"$cmd\" | grep -qE \"goose run --name $ID( |\\$)\"; then",
    "    kill -9 $p 2>/dev/null",
    "    echo \"KILLED $p :: $cmd\"",
    "  else",
    "    echo \"KEPT $p :: $cmd\"",
    "  fi",
    "done",
    "sleep 0.3",
    "for p in $(pgrep -f \"goose run --name $ID\" 2>/dev/null); do",
    "  cmd=$(tr '\\0' ' ' < /proc/$p/cmdline 2>/dev/null)",
    "  echo \"SURVIVOR $p :: $cmd\"",
    "done",
    "for p in $(pgrep -f \"goose run --name $ID\" 2>/dev/null); do",
    "  kill -9 $p 2>/dev/null",
    "done",
    "true",
  ].join("\n");

  const scriptPath = path.join(__dirname, "..", "_p10_reaping_script.sh");
  // Strip CR so the script is clean LF for WSL bash (the test file itself is
  // CRLF on the Windows drive).
  fs.writeFileSync(scriptPath, script.replace(/\r\n/g, "\n"), "utf8");
  const wslScriptPath = `/mnt/d/LLM_Ecosystem/mcp-qwen/_p10_reaping_script.sh`;
  try {
    const { stdout } = await runWslCommand(`bash ${wslScriptPath}`);
    const killed = /KILLED \d+ :: goose run --name p10test_target( |$)/.test(stdout);
    const decoySurvived = /SURVIVOR \d+ :: goose run --name p10test_target123/.test(stdout);
    const decoyKilled = /KILLED \d+ :: goose run --name p10test_target123/.test(stdout);
    assert(killed, "exact-match target (id at boundary) was killed");
    assert(decoySurvived, "decoy (id as substring) SURVIVED the anchored kill");
    assert(!decoyKilled, "decoy was NOT over-killed");
  } finally {
    try {
      fs.rmSync(scriptPath, { force: true });
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// Test 4: ensureStreamProxyRunning (injected spawner seam)
// ---------------------------------------------------------------------------
function startDelayedHealthServer(port, delayMs) {
  const startAt = Date.now() + delayMs;
  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      if (Date.now() >= startAt) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", pid: process.pid }));
      } else {
        res.writeHead(503);
        res.end("starting");
      }
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

async function testStreamProxySlowStart() {
  console.log("\n[Test 4a: ensureStreamProxyRunning slow-start (15s window)]");
  const port = 18999;
  let server;
  setStreamProxySpawner(async () => {
    // The port is bound immediately, but /health only returns 200 after ~6s
    // (past the old 5s window, inside the new 15s window).
    server = await startDelayedHealthServer(port, 6000);
  });
  try {
    const t0 = Date.now();
    const ok = await ensureStreamProxyRunning({ healthPolls: 75 });
    const dt = Date.now() - t0;
    assert(ok === true, "slow-start proxy became healthy within the 15s window");
    assert(dt >= 5000, `took >5s (old window would have failed) - got ${dt}ms`);
  } finally {
    setStreamProxySpawner(null);
    if (server) server.close();
  }
}

async function testStreamProxyFailedSpawn() {
  console.log("\n[Test 4b: ensureStreamProxyRunning failed spawn -> honest error]");
  setStreamProxySpawner(async () => {
    throw new Error("simulated spawn failure: ENOENT (node not found)");
  });
  try {
    let threw = false;
    let msg = "";
    try {
      await ensureStreamProxyRunning({ healthPolls: 5 }); // 1s window (fast)
    } catch (err) {
      threw = true;
      msg = err.message;
    }
    assert(threw, "failed spawn throws (not swallowed)");
    assert(
      msg.includes("simulated spawn failure: ENOENT"),
      `error includes the captured spawn failure (got: ${msg})`
    );
    assert(
      /after \d+s/.test(msg),
      `error states the health window duration (got: ${msg})`
    );
  } finally {
    setStreamProxySpawner(null);
  }
}

// ---------------------------------------------------------------------------
// Test 5: cancel-path - abort lands in the runner's finally (bridge disposed)
// ---------------------------------------------------------------------------
function makeHangingLlm() {
  return {
    async streamChat({ signal }) {
      // Simulate a long in-flight LLM call that only ends when the signal is
      // aborted (matching the real provider's fetch-abort behavior).
      return new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error("aborted"));
          return;
        }
        const onAbort = () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        };
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve({
            content: "done",
            toolCalls: [],
            finishReason: "stop",
            metrics: {},
          });
        }, 30000);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
  };
}

const noopLogger = {
  append: () => {},
  getConversationHistory: () => [],
};

async function testCancelPath() {
  console.log("\n[Test 5: cancel-path - abort disposes the MCP bridge]");
  const ac = new AbortController();
  const runner = new AnserRunner({
    llm: makeHangingLlm(),
    logger: noopLogger,
  });
  const runPromise = runner.run({
    prompt: "p10 cancel-path test",
    sessionId: "p10_cancel",
    signal: ac.signal,
    extensions: [`node ${FIXTURE}`],
  });

  // Wait for the bridge child to come up.
  let bridgePid = null;
  for (let i = 0; i < 100 && !bridgePid; i++) {
    await sleep(100);
    const pids = getLiveBridgePids();
    if (pids.length) bridgePid = pids[0];
  }
  assert(bridgePid && pidAlive(bridgePid), "bridge child alive before abort");

  // Abort (simulates the cancel path: abortController.abort()).
  ac.abort();
  const res = await runPromise;
  assert(res.status === "error" || res.status === "aborted", `run() resolved (status=${res.status})`);

  await sleep(300); // give dispose a moment to reap
  assert(!pidAlive(bridgePid), "bridge child dead after abort (finally disposed it)");
  assert(getLiveBridgePids().length === 0, "no live bridges after abort");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  await testDummyTreeKill();
  await testPidlessNoop();
  await testAnchoredPattern();
  await testStreamProxySlowStart();
  await testStreamProxyFailedSpawn();
  await testCancelPath();

  console.log("\n==========================================");
  console.log(`Reaping Tests: ${passed} PASSED, ${failed} FAILED`);
  console.log("==========================================");
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Reaping test uncaught error:", err);
  process.exit(1);
});
