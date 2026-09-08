#!/usr/bin/env node
/**
 * FX6 — Provider/Disk-Honesty + Dead-Code Drift (fully OFFLINE)
 *
 * Covers the three confirmed defect clusters in the provider/disk-honesty +
 * dead-code domain, using the repo's established offline patterns (isolated
 * QWEN_STATE_DIR temp dir, mocked globalThis.fetch, check() counters, hard
 * watchdog). No real vLLM, no real WSL, and the production ~/.qwen state is
 * never touched.
 *
 *   A (D8)  listModels fabricated fallback: a probe failure (network reject,
 *           non-2xx, unparseable body, missing data array) must THROW a loud
 *           error carrying the upstream status/detail — never return a
 *           fabricated `[this.model]` list. A genuine 2xx with a parseable
 *           `data` array returns the real list.
 *   B (D11) readTaskFromDisk corrupt-file conflation: an ABSENT file is a
 *           clean not-found (null); a CORRUPT/unreadable file is quarantined
 *           (renamed to `<name>.corrupt-<epochms>`, the LineageDag pattern),
 *           logged loudly to stderr, and surfaced as a distinguishable
 *           `{corrupted:true, id, file, error}` result — never conflated with
 *           not-found. listTasksFromDisk (the sibling bulk read) applies the
 *           same quarantine instead of silently skipping.
 *   C (D13) dead/dual-source config constants: PROXY_MAX_BODY_BYTES is the
 *           single source (imported by stream_proxy.js, inline literal gone);
 *           the genuinely-dead SLOT_STALE_MS is deleted; the documented
 *           FIRST_TOKEN_TIMEOUT_MS is retained (near-term consumer); config.js
 *           still imports cleanly with all live exports intact.
 *
 * Run: node tests/honesty_drift.test.js
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Isolate ALL on-disk state in a fresh temp dir BEFORE any src import so
// config.js pins QWEN_STATE_DIR (and TASK_DIR under it) to the private dir.
// The production ~/.qwen is never read or written.
// ---------------------------------------------------------------------------
const TMP_STATE = fs.mkdtempSync(path.join(os.tmpdir(), "fx6_state_"));
process.env.QWEN_STATE_DIR = TMP_STATE;
process.env.HOME = TMP_STATE;
process.env.QWEN_WSL_HOME = TMP_STATE;
process.env.QWEN_WIN_HOME = TMP_STATE;

const config = await import("../src/config.js");
const { TASK_DIR, PROXY_MAX_BODY_BYTES, FIRST_TOKEN_TIMEOUT_MS, SLOT_STALE_MS } = config;
const { readTaskFromDisk, listTasksFromDisk } = await import("../src/task_registry.js");
const { VllmProviderService } = await import("../src/harness/services/provider_vllm.js");

// ---------------------------------------------------------------------------
// check() harness + hard watchdog (the verdict is the checks; the watchdog
// only guarantees the process always terminates).
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`[PASS] ${name}`);
    passed++;
  } catch (err) {
    console.error(`[FAIL] ${name}: ${err.message}`);
    failed++;
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    console.log(`[PASS] ${name}`);
    passed++;
  } catch (err) {
    console.error(`[FAIL] ${name}: ${err.message}`);
    failed++;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Hard watchdog: force termination so a wedged check can never hang the suite.
setTimeout(() => {
  console.error(`\nHARD WATCHDOG fired - forcing exit (failures=${failed})`);
  process.exit(failed === 0 ? 0 : 1);
}, 90_000).unref();

// ---------------------------------------------------------------------------
// A (D8): listModels — no fabricated fallback; every failure path throws.
// ---------------------------------------------------------------------------
await checkAsync("A1: listModels throws on network failure (no fabricated list)", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("ECONNREFUSED 127.0.0.1:18022");
  };
  const svc = new VllmProviderService({ baseUrl: "http://127.0.0.1:18022/v1" });
  let threw = null;
  let result;
  try {
    result = await svc.listModels();
  } catch (err) {
    threw = err;
  } finally {
    globalThis.fetch = origFetch;
  }
  assert.ok(threw, "listModels must throw on a network failure");
  assert.ok(threw.message.includes("listModels"), `message names listModels: ${threw.message}`);
  assert.ok(threw.message.includes("ECONNREFUSED"), `message carries the upstream detail: ${threw.message}`);
  assert.strictEqual(result, undefined, "no fabricated list is returned on failure");
});

await checkAsync("A2: listModels throws on non-2xx with the upstream status + body", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 503,
    statusText: "Service Unavailable",
    text: async () => "engine down",
  });
  const svc = new VllmProviderService({ baseUrl: "http://127.0.0.1:18022/v1" });
  let threw = null;
  let result;
  try {
    result = await svc.listModels();
  } catch (err) {
    threw = err;
  } finally {
    globalThis.fetch = origFetch;
  }
  assert.ok(threw, "listModels must throw on a non-2xx response");
  assert.ok(threw.message.includes("503"), `message carries the HTTP status: ${threw.message}`);
  assert.ok(threw.message.includes("engine down"), `message carries the upstream body: ${threw.message}`);
  assert.strictEqual(result, undefined, "no fabricated list is returned on failure");
});

await checkAsync("A3: listModels returns the real parsed list on a genuine 200", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: [{ id: "qwen3.8-27b" }, { id: "other-model" }] }),
  });
  const svc = new VllmProviderService({ baseUrl: "http://127.0.0.1:18022/v1" });
  let result;
  try {
    result = await svc.listModels();
  } finally {
    globalThis.fetch = origFetch;
  }
  assert.deepStrictEqual(result, ["qwen3.8-27b", "other-model"], "returns the real parsed list");
});

await checkAsync("A4: listModels throws on a 200 with an unparseable body", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => {
      throw new Error("Unexpected token in JSON");
    },
  });
  const svc = new VllmProviderService({ baseUrl: "http://127.0.0.1:18022/v1" });
  let threw = null;
  let result;
  try {
    result = await svc.listModels();
  } catch (err) {
    threw = err;
  } finally {
    globalThis.fetch = origFetch;
  }
  assert.ok(threw, "listModels must throw on an unparseable 200 body");
  assert.ok(threw.message.includes("unparseable"), `message names the unparseable body: ${threw.message}`);
  assert.strictEqual(result, undefined, "no fabricated list is returned on failure");
});

await checkAsync("A5: listModels throws on a 200 with no 'data' array", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ foo: "bar" }),
  });
  const svc = new VllmProviderService({ baseUrl: "http://127.0.0.1:18022/v1" });
  let threw = null;
  let result;
  try {
    result = await svc.listModels();
  } catch (err) {
    threw = err;
  } finally {
    globalThis.fetch = origFetch;
  }
  assert.ok(threw, "listModels must throw when the 200 body has no data array");
  assert.ok(threw.message.includes("no 'data' array"), `message names the missing data array: ${threw.message}`);
  assert.strictEqual(result, undefined, "no fabricated list is returned on failure");
});

// ---------------------------------------------------------------------------
// B (D11): readTaskFromDisk — distinguish absent vs corrupt; quarantine.
// ---------------------------------------------------------------------------
check("B1: readTaskFromDisk returns null for an absent file (clean not-found)", () => {
  const r = readTaskFromDisk("fx6_nonexistent_task");
  assert.strictEqual(r, null, "absent file -> clean not-found (null)");
});

check("B2: readTaskFromDisk quarantines a corrupt file and returns a corruption signal", () => {
  const id = "fx6_corrupt_task";
  const filePath = path.join(TASK_DIR, `${id}.json`);
  fs.writeFileSync(filePath, "{ this is not valid json ]]", "utf8");
  const r = readTaskFromDisk(id);
  assert.ok(r, "result is not null");
  assert.strictEqual(r.corrupted, true, "corrupted flag is set");
  assert.strictEqual(r.id, id, "id is preserved");
  assert.ok(r.file && r.file.includes(`${id}.json`), `file is named: ${r.file}`);
  assert.ok(r.error && r.error.length > 0, `parse error message present: ${r.error}`);
  // The original corrupt file is gone (renamed into the quarantine name).
  assert.ok(!fs.existsSync(filePath), "original corrupt file removed (renamed)");
  // Exactly one quarantine file with the .corrupt- prefix exists.
  const entries = fs.readdirSync(TASK_DIR).filter((f) => f.startsWith(`${id}.json.corrupt-`));
  assert.strictEqual(entries.length, 1, `exactly one quarantine file (got ${entries.length})`);
  assert.ok(entries[0].includes(".corrupt-"), "quarantine file carries the .corrupt- prefix");
  // Cleanup.
  fs.unlinkSync(path.join(TASK_DIR, entries[0]));
});

check("B3: readTaskFromDisk parses a valid file exactly as before", () => {
  const id = "fx6_valid_task";
  const filePath = path.join(TASK_DIR, `${id}.json`);
  const payload = {
    id,
    done: true,
    status: "completed",
    isError: false,
    createdAt: Date.now(),
    finishedAt: Date.now(),
    result: { text: "ok" },
  };
  fs.writeFileSync(filePath, JSON.stringify(payload), "utf8");
  const r = readTaskFromDisk(id);
  assert.ok(r, "result is not null");
  assert.strictEqual(r.corrupted, undefined, "no corrupted flag for a valid file");
  assert.strictEqual(r.id, id, "id parsed");
  assert.strictEqual(r.done, true, "done parsed");
  assert.strictEqual(r.result.text, "ok", "result parsed");
  fs.unlinkSync(filePath);
});

check("B4: listTasksFromDisk quarantines a corrupt file but keeps the valid one", () => {
  const goodId = "fx6_list_good";
  const badId = "fx6_list_bad";
  fs.writeFileSync(path.join(TASK_DIR, `${goodId}.json`), JSON.stringify({ id: goodId, done: true }), "utf8");
  fs.writeFileSync(path.join(TASK_DIR, `${badId}.json`), "%%% not json %%%", "utf8");
  const list = listTasksFromDisk();
  const ids = list.map((t) => t.id);
  assert.ok(ids.includes(goodId), "valid task is present in the list");
  assert.ok(!ids.includes(badId), "corrupt task is NOT in the list");
  const q = fs.readdirSync(TASK_DIR).filter((f) => f.startsWith(`${badId}.json.corrupt-`));
  assert.strictEqual(q.length, 1, "corrupt file was quarantined");
  // Cleanup.
  fs.unlinkSync(path.join(TASK_DIR, `${goodId}.json`));
  if (q[0]) fs.unlinkSync(path.join(TASK_DIR, q[0]));
});

// ---------------------------------------------------------------------------
// C (D13): dead/dual-source config constants.
// ---------------------------------------------------------------------------
check("C1: PROXY_MAX_BODY_BYTES is the single source and stream_proxy imports it", () => {
  assert.strictEqual(PROXY_MAX_BODY_BYTES, 50 * 1024 * 1024, "config value is 50MB");
  const sp = fs.readFileSync(path.join(__dirname, "..", "stream_proxy.js"), "utf8");
  assert.ok(
    sp.includes('import { PROXY_MAX_BODY_BYTES } from "./src/config.js"'),
    "stream_proxy imports the constant from config.js"
  );
  assert.ok(!sp.includes("50 * 1024 * 1024"), "the inline 50MB literal is gone from stream_proxy");
  assert.ok(sp.includes("PROXY_MAX_BODY_BYTES"), "stream_proxy references the constant");
});

check("C2: the genuinely-dead constant SLOT_STALE_MS is deleted", () => {
  assert.strictEqual(SLOT_STALE_MS, undefined, "SLOT_STALE_MS is no longer exported");
  const cfg = fs.readFileSync(path.join(__dirname, "..", "src", "config.js"), "utf8");
  assert.ok(!cfg.includes("SLOT_STALE_MS"), "SLOT_STALE_MS is not in the config.js source");
});

check("C3: FIRST_TOKEN_TIMEOUT_MS is retained (documented near-term consumer)", () => {
  assert.strictEqual(typeof FIRST_TOKEN_TIMEOUT_MS, "number", "still a number");
  assert.ok(FIRST_TOKEN_TIMEOUT_MS > 0, "positive value");
});

check("C4: config.js imports cleanly with all live exports intact", () => {
  assert.strictEqual(typeof config.VLLM_PORT, "number");
  assert.strictEqual(typeof config.STATUS_PORT, "number");
  assert.strictEqual(typeof config.STREAM_PROXY_PORT, "number");
  assert.strictEqual(typeof config.MAX_TOKENS, "number");
  assert.strictEqual(typeof config.TASK_DIR, "string");
  assert.strictEqual(typeof config.getReasoningEffort, "function");
  assert.strictEqual(typeof config.PROXY_MAX_BODY_BYTES, "number");
});

// ---------------------------------------------------------------------------
// C5 (behavior): the stream proxy actually enforces the config body limit.
// The 413 fires BEFORE any upstream contact, so the upstream can be a dead
// port — no real vLLM is needed. The 413 body names the config value, which
// proves the proxy is using the imported constant (not a divergent literal).
// ---------------------------------------------------------------------------
await checkAsync("C5: stream_proxy returns 413 for a body over PROXY_MAX_BODY_BYTES", async () => {
  const proxyPort = await new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
  const child = spawn(
    process.execPath,
    [path.join(__dirname, "..", "stream_proxy.js")],
    {
      env: { ...process.env, VLLM_PORT: "1", VLLM_PROXY_PORT: String(proxyPort) },
      stdio: ["ignore", "ignore", "pipe"],
    }
  );
  try {
    let up = false;
    for (let i = 0; i < 50 && !up; i++) {
      up = await new Promise((resolve) => {
        const probe = http.get(`http://127.0.0.1:${proxyPort}/health`, (res) => {
          res.resume();
          resolve(res.statusCode === 200);
        });
        probe.on("error", () => resolve(false));
        probe.setTimeout(300, () => {
          probe.destroy();
          resolve(false);
        });
      });
      if (!up) await sleep(100);
    }
    assert.ok(up, "stream_proxy child bound to the ephemeral port");

    const over = PROXY_MAX_BODY_BYTES + 1;
    const body = Buffer.alloc(over, "a");
    const resp = await new Promise((resolve, reject) => {
      const req = http.request(
        `http://127.0.0.1:${proxyPort}/v1/chat/completions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": over },
        },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => resolve({ status: res.statusCode, body: data }));
        }
      );
      req.on("error", reject);
      req.end(body);
    });
    assert.strictEqual(resp.status, 413, `expected 413, got ${resp.status}`);
    assert.ok(
      resp.body.includes(String(PROXY_MAX_BODY_BYTES)),
      `413 body names the config limit (${PROXY_MAX_BODY_BYTES}): ${resp.body}`
    );
    assert.ok(
      resp.body.includes("payload_too_large") || resp.body.includes("Payload Too Large"),
      "413 body names the error type"
    );
  } finally {
    child.kill("SIGKILL");
  }
});

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
console.log("");
console.log("==========================================");
console.log(`Honesty Drift Tests: ${passed} PASSED, ${failed} FAILED`);
console.log("==========================================");
if (failed > 0) process.exit(1);
