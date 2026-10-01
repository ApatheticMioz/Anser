/**
 * Slice 4A — castor config / castor status CLI tests.
 *
 * Verifies CLI invocations of:
 *   - `castor config path`  -> prints path to <QWEN_STATE_DIR>/config.json
 *   - `castor config set`   -> validates and writes keys to config.json
 *   - `castor config get`   -> prints a single key or full config JSON
 *   - `castor status`        -> prints a status summary (offline-safe)
 *
 * Fully offline: each CLI invocation runs in a child process with an
 * isolated QWEN_STATE_DIR temp directory. No engine required; the status
 * probe fails fast on ECONNREFUSED (or times out at 2s) and reports NO.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const BIN = path.join(REPO_ROOT, "bin", "castor.js");

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

function runCastor(args, env = {}) {
  return spawnSync(
    process.execPath,
    [BIN, ...args],
    {
      encoding: "utf8",
      timeout: 15000,
      env: {
        ...process.env,
        // Isolated state dir per test run; never touch the real ~/.castor.
        QWEN_STATE_DIR: env.QWEN_STATE_DIR || TMP_STATE,
        // Keep the status probe from ever touching a real engine.
        ALLOW_ENGINE_INTERRUPT: "0",
        ...env,
      },
    }
  );
}

const TMP_STATE = fs.mkdtempSync(path.join(os.tmpdir(), "castor_cli_cfg_"));
const CONFIG_FILE = path.join(TMP_STATE, "config.json");

try {
  // --- config path ---
  let res = runCastor(["config", "path"]);
  assert(res.status === 0, "config path exits 0");
  assert(
    res.stdout.trim() === CONFIG_FILE,
    `config path prints <QWEN_STATE_DIR>/config.json (got: ${res.stdout.trim()})`
  );

  // --- config get on empty config ---
  res = runCastor(["config", "get", "model"]);
  assert(res.status === 0, "config get (unset key) exits 0");
  assert(
    res.stdout.trim() === "(not set)",
    `config get unset key prints (not set) (got: ${res.stdout.trim()})`
  );

  // --- config set: string keys ---
  res = runCastor(["config", "set", "model", "Qwen3.8-27B"]);
  assert(res.status === 0, "config set model exits 0");
  assert(
    res.stdout.includes("Set model"),
    `config set model confirms write (got: ${res.stdout.trim()})`
  );

  res = runCastor(["config", "set", "baseURL", "http://127.0.0.1:18020/v1"]);
  assert(res.status === 0, "config set baseURL exits 0");

  res = runCastor(["config", "set", "tool_prefix", "qwen"]);
  assert(res.status === 0, "config set tool_prefix exits 0");

  res = runCastor(["config", "set", "launch_command", "vllm serve --port 18020"]);
  assert(res.status === 0, "config set launch_command exits 0");

  // --- config set: numeric key validation ---
  res = runCastor(["config", "set", "max_context", "245760"]);
  assert(res.status === 0, "config set max_context (valid) exits 0");

  res = runCastor(["config", "set", "max_context", "not-a-number"]);
  assert(res.status === 1, "config set max_context (invalid) exits 1");
  assert(
    res.stderr.includes("Invalid value for max_context"),
    "config set max_context (invalid) prints validation error"
  );

  res = runCastor(["config", "set", "max_context", "-5"]);
  assert(res.status === 1, "config set max_context (negative) exits 1");

  res = runCastor(["config", "set", "bogus_key", "x"]);
  assert(res.status === 1, "config set unknown key exits 1");
  assert(
    res.stderr.includes("Unknown config key"),
    "config set unknown key prints error"
  );

  // --- config get: values written to disk ---
  res = runCastor(["config", "get", "model"]);
  assert(
    res.stdout.trim() === "Qwen3.8-27B",
    `config get model round-trips (got: ${res.stdout.trim()})`
  );

  res = runCastor(["config", "get", "max_context"]);
  assert(
    res.stdout.trim() === "245760",
    `config get max_context round-trips as number (got: ${res.stdout.trim()})`
  );

  res = runCastor(["config", "get", "launch_command"]);
  assert(
    res.stdout.trim() === "vllm serve --port 18020",
    `config get launch_command round-trips (got: ${res.stdout.trim()})`
  );

  // --- config get: full JSON ---
  res = runCastor(["config", "get"]);
  assert(res.status === 0, "config get (no key) exits 0");
  let full;
  try {
    full = JSON.parse(res.stdout);
  } catch {
    full = null;
  }
  assert(full !== null, "config get (no key) prints valid JSON");
  assert(
    full && full.model === "Qwen3.8-27B" && full.max_context === 245760,
    "config get (no key) JSON contains written values"
  );

  // --- on-disk file is valid JSON with correct types ---
  const onDisk = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  assert(
    typeof onDisk.max_context === "number" && onDisk.max_context === 245760,
    "config.json max_context persisted as number"
  );
  assert(
    typeof onDisk.model === "string" && onDisk.baseURL === "http://127.0.0.1:18020/v1",
    "config.json model/baseURL persisted as strings"
  );

  // --- status: offline-safe summary ---
  res = runCastor(["status"]);
  assert(res.status === 0, "status exits 0 (offline)");
  assert(res.stdout.includes("Castor Status"), "status prints summary header");
  assert(
    res.stdout.includes("Qwen3.8-27B"),
    "status prints model name from config"
  );
  assert(
    res.stdout.includes("245760"),
    "status prints max context"
  );
  assert(
    res.stdout.includes(TMP_STATE),
    "status prints active state directory"
  );
  // With ALLOW_ENGINE_INTERRUPT=0 the probe is skipped (same discipline as
  // tests/helpers/engine_probe.js), so status must report UNKNOWN, not a
  // live reachability verdict.
  assert(
    /Engine Up:\s+UNKNOWN/.test(res.stdout),
    `status skips probe when ALLOW_ENGINE_INTERRUPT=0 (got: ${res.stdout
      .split("\n")
      .find((l) => l.startsWith("Engine Up"))})`
  );
  // Stdout purity: no stray stderr noise from the CLI itself.
  assert(
    !res.stderr.includes("Corrupt") && !res.stderr.includes("Fatal"),
    "status emits no fatal/corrupt diagnostics"
  );

  // --- status: probe enabled (ALLOW_ENGINE_INTERRUPT=1) against a closed
  // port -> deterministic NO (ECONNREFUSED fails fast, no 2s wait). ---
  const closedPortState = fs.mkdtempSync(path.join(os.tmpdir(), "castor_cli_st_"));
  fs.writeFileSync(
    path.join(closedPortState, "config.json"),
    JSON.stringify({
      model: "m",
      baseURL: "http://127.0.0.1:1/v1", // port 1: nothing listens
      max_context: 1000,
    })
  );
  res = runCastor(["status"], {
    QWEN_STATE_DIR: closedPortState,
    ALLOW_ENGINE_INTERRUPT: "1",
  });
  assert(res.status === 0, "status (probe enabled) exits 0");
  assert(
    /Engine Up:\s+NO/.test(res.stdout),
    `status probe enabled reports NO for closed port (got: ${res.stdout
      .split("\n")
      .find((l) => l.startsWith("Engine Up"))})`
  );
  fs.rmSync(closedPortState, { recursive: true, force: true });
} finally {
  fs.rmSync(TMP_STATE, { recursive: true, force: true });
}

console.log("\n==========================================");
console.log(`Castor CLI config/status: ${passed} PASSED, ${failed} FAILED`);
console.log("==========================================");
if (failed > 0) process.exit(1);
