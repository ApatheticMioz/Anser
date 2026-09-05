/**
 * Wedge-Guard Verification (fully OFFLINE — no engine, no network, no WSL)
 *
 * Proves the busy-gate + heal backstop in src/server_lifecycle.js:
 *   (a) engine BUSY (running_requests=1) + canary WOULD time out
 *       -> engineWedgeState returns wedged=false, canary.skipped="engine_busy",
 *          and /chat/completions is NEVER fetched (canary not fired).
 *   (b) engine IDLE (0/0) + canary returns HTTP 500 -> wedged=true.
 *   (c) healWedgedEngine with a live task (gatekeeper true)
 *       -> {healed:false, note contains "refused"}, engine stop NOT invoked,
 *          wedge counter NOT bumped, heal lock NOT written.
 *   (d) healWedgedEngine with no live work (gatekeeper false)
 *       -> heal proceeds: heal lock written, stop invoked, healed=true.
 *   (e) engine IDLE (0/0) + canary ok -> wedged=false.
 *
 * global.fetch is monkey-patched; the WSL runner and heal gatekeeper are
 * injected via the module's setWslRunner / setHealGatekeeper seams.
 */

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate all on-disk state (task dir, heal lock, wedge counter) in a temp dir
// BEFORE importing config so the module picks it up at load time.
const TMP_STATE = fs.mkdtempSync(path.join(os.tmpdir(), "wedge-guard-"));
process.env.QWEN_STATE_DIR = TMP_STATE;
process.env.QWEN_AUTO_HEAL = "1";

const {
  engineWedgeState,
  healWedgedEngine,
  resetEngineHealthCache,
  setWslRunner,
  setHealGatekeeper,
  readWedgeCounter,
} = await import("../src/server_lifecycle.js");
const { HEAL_LOCK_FILE, WEDGE_COUNTER_FILE, BASE_URL } = await import(
  "../src/config.js"
);

// ---------------------------------------------------------------------------
// fetch mock: dispatch on URL.
// ---------------------------------------------------------------------------
let fetchLog = [];
let metricsMap = {}; // vllm metric name -> value
let canaryBehavior = "ok"; // "ok" | "http500" | "timeout"
let modelsUp = true;

function fakeResponse(status, body) {
  const isJson = typeof body === "object";
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => (isJson ? body : JSON.parse(body)),
    text: async () => (isJson ? JSON.stringify(body) : body),
  };
}

function metricsText() {
  const lines = [];
  for (const [k, v] of Object.entries(metricsMap)) {
    lines.push(`# HELP ${k} x\n# TYPE ${k} gauge\n${k} ${v}`);
  }
  return lines.join("\n") + "\n";
}

globalThis.fetch = async (url, opts) => {
  const u = String(url);
  fetchLog.push(u);
  if (u.endsWith("/metrics")) {
    return fakeResponse(200, metricsText());
  }
  if (u.endsWith("/models")) {
    if (!modelsUp) throw new Error("ECONNREFUSED");
    return fakeResponse(200, { data: [{ max_model_len: 245760 }] });
  }
  if (u.includes("/chat/completions")) {
    if (canaryBehavior === "timeout") {
      const err = new Error("aborted");
      err.name = "TimeoutError";
      throw err;
    }
    if (canaryBehavior === "http500") {
      return fakeResponse(500, { error: "boom" });
    }
    return fakeResponse(200, {
      choices: [{ message: { content: "ok" } }],
    });
  }
  // stream proxy health etc.
  return fakeResponse(200, { status: "ok" });
};

// WSL runner stub: record every command, return empty stdout.
let wslCalls = [];
setWslRunner(async (cmd) => {
  wslCalls.push(cmd);
  return { stdout: "", stderr: "" };
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function recentStatsLine() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const ts = `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes()
  )}:${p(d.getSeconds())}`;
  return `${ts} Engine 000: Running: 0 reqs, Waiting: 0 reqs`;
}

function reset() {
  fetchLog = [];
  wslCalls = [];
  metricsMap = {};
  canaryBehavior = "ok";
  modelsUp = true;
  resetEngineHealthCache();
  try {
    fs.rmSync(HEAL_LOCK_FILE, { force: true });
  } catch {}
  try {
    fs.rmSync(WEDGE_COUNTER_FILE, { force: true });
  } catch {}
}

let passed = 0;
let failed = 0;
function check(cond, name) {
  if (cond) {
    console.log(`[PASS] ${name}`);
    passed++;
  } else {
    console.error(`[FAIL] ${name}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// (a) BUSY: canary skipped, wedged=false, /chat/completions never fetched
// ---------------------------------------------------------------------------
console.log("\n[Test a: engine busy -> canary skipped, no wedge]");
reset();
metricsMap = {
  "vllm:num_requests_running": 1,
  "vllm:num_requests_waiting": 0,
};
canaryBehavior = "timeout"; // would time out IF fired
const a = await engineWedgeState();
check(a.engineBusy === true, "a: engineBusy detected from metrics");
check(a.canary.skipped === "engine_busy", "a: canary.skipped === 'engine_busy'");
check(a.canary.ok === true, "a: canary sentinel ok=true");
check(a.wedged === false, "a: wedged=false (canary ignored while busy)");
check(
  !fetchLog.some((u) => u.includes("/chat/completions")),
  "a: /chat/completions NEVER fetched (canary not fired)"
);

// ---------------------------------------------------------------------------
// (b) IDLE + canary HTTP 500 -> wedged=true
// ---------------------------------------------------------------------------
console.log("\n[Test b: idle + canary HTTP 500 -> wedged]");
reset();
metricsMap = {
  "vllm:num_requests_running": 0,
  "vllm:num_requests_waiting": 0,
};
canaryBehavior = "http500";
const b = await engineWedgeState();
check(b.engineBusy === false, "b: engine idle");
check(b.canary.skipped === undefined, "b: canary not skipped (fired)");
check(b.canary.ok === false, "b: canary failed (HTTP 500)");
check(b.wedged === true, "b: wedged=true (canary authoritative when idle)");
check(
  fetchLog.some((u) => u.includes("/chat/completions")),
  "b: /chat/completions fetched (canary fired)"
);

// ---------------------------------------------------------------------------
// (e) IDLE + canary ok -> wedged=false
// ---------------------------------------------------------------------------
console.log("\n[Test e: idle + canary ok -> no wedge]");
reset();
metricsMap = {
  "vllm:num_requests_running": 0,
  "vllm:num_requests_waiting": 0,
};
canaryBehavior = "ok";
const e = await engineWedgeState();
check(e.engineBusy === false, "e: engine idle");
check(e.canary.ok === true, "e: canary ok");
check(e.wedged === false, "e: wedged=false");

// ---------------------------------------------------------------------------
// (c) heal with live work -> refused, stop NOT invoked, counter NOT bumped
// ---------------------------------------------------------------------------
console.log("\n[Test c: heal refused while tasks in flight]");
reset();
setHealGatekeeper(() => true); // live work in flight
const c = await healWedgedEngine(10);
check(c.healed === false, "c: healed=false");
check(
  typeof c.note === "string" && c.note.includes("refused"),
  `c: note contains 'refused' (got: ${c.note})`
);
check(
  !wslCalls.some((cmd) => cmd.includes("stop_server.sh")),
  "c: engine stop NOT invoked"
);
check(
  !fs.existsSync(HEAL_LOCK_FILE),
  "c: heal lock NOT written"
);
check(
  (readWedgeCounter().count ?? 0) === 0,
  "c: wedge counter NOT bumped"
);

// ---------------------------------------------------------------------------
// (d) heal with no live work -> proceeds (lock written, stop invoked)
// ---------------------------------------------------------------------------
console.log("\n[Test d: heal proceeds when no live work]");
reset();
setHealGatekeeper(() => false); // no live work
// After stop, ensureServerRunning sees the engine back up (models up) and
// idle+canary-ok -> returns quickly without a 180s boot wait.
modelsUp = true;
metricsMap = {
  "vllm:num_requests_running": 0,
  "vllm:num_requests_waiting": 0,
};
canaryBehavior = "ok";
const d = await healWedgedEngine(10);
check(d.healed === true, "d: healed=true");
check(
  wslCalls.some((cmd) => cmd.includes("stop_server.sh")),
  "d: engine stop invoked"
);
check(fs.existsSync(HEAL_LOCK_FILE), "d: heal lock written");
check(
  (readWedgeCounter().count ?? 0) === 1,
  "d: wedge counter bumped once"
);

// ---------------------------------------------------------------------------
// cleanup
// ---------------------------------------------------------------------------
setHealGatekeeper(null);
setWslRunner(null);
fs.rmSync(TMP_STATE, { recursive: true, force: true });

console.log("\n==========================================");
console.log(`Wedge-Guard Completed: ${passed} PASSED, ${failed} FAILED`);
console.log("==========================================");
if (failed > 0) process.exit(1);
