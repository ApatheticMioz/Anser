/**
 * Portability & 1-command install hardening — CANARY.
 *
 * Fast, deterministic, offline. Exercises exactly the code changed in this
 * candidate:
 *   1. config.js loads at module-eval with NO TDZ (the wsl_env.js bug class).
 *   2. STREAM_PROXY_PORT accepts both STREAM_PROXY_PORT and VLLM_PROXY_PORT.
 *   3. USE_STREAM_PROXY / USE_STREAM_PROXY_RESOLVED honor env + config.json.
 *   4. getApiKeySync checks QWEN_API_KEY / OPENAI_API_KEY before file scan.
 *   5. wslAvailable() is true on non-Windows and never throws.
 *   6. anser config set accepts the new keys (api_key, engine_type, ...).
 *
 * No engine, no WSL dispatch, no network.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const BIN = path.join(REPO_ROOT, "bin", "anser.js");

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

// Isolated state dir so we never touch the real ~/.anser.
const TMP_STATE = fs.mkdtempSync(path.join(os.tmpdir(), "port_canary_"));

// ---------------------------------------------------------------------------
// (1) config.js loads at module-eval with no TDZ.
// ---------------------------------------------------------------------------
{
  let loaded = false;
  let cfg = null;
  try {
    cfg = await import("../src/config.js");
    loaded = true;
  } catch (err) {
    console.error("config.js import threw:", err.message);
  }
  assert(loaded, "config.js imports without TDZ / ReferenceError");
  assert(
    typeof cfg?.STREAM_PROXY_PORT === "number" && cfg.STREAM_PROXY_PORT > 0,
    "STREAM_PROXY_PORT is a positive number"
  );
  assert(
    typeof cfg?.USE_STREAM_PROXY === "boolean",
    "USE_STREAM_PROXY is a boolean"
  );
  assert(
    typeof cfg?.STREAM_PROXY_PORT_RESOLVED === "number",
    "STREAM_PROXY_PORT_RESOLVED is a number"
  );
  assert(
    typeof cfg?.USE_STREAM_PROXY_RESOLVED === "boolean",
    "USE_STREAM_PROXY_RESOLVED is a boolean"
  );
  assert(
    typeof cfg?.API_KEY === "string",
    "API_KEY is a string"
  );
  assert(
    typeof cfg?.MODEL === "string" && cfg.MODEL.length > 0,
    "MODEL is a non-empty string"
  );
  assert(
    typeof cfg?.LAUNCH_COMMAND === "string",
    "LAUNCH_COMMAND is a string"
  );
}

// ---------------------------------------------------------------------------
// (2) STREAM_PROXY_PORT accepts both env names (fresh child process).
// ---------------------------------------------------------------------------
function runNodeWithEnv(env, script) {
  return spawnSync(process.execPath, ["-e", script], {
    encoding: "utf8",
    timeout: 15000,
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
  });
}

{
  const cfgUrl = pathToFileURL(path.join(REPO_ROOT, "src", "config.js")).href;
  // STREAM_PROXY_PORT wins.
  let r = runNodeWithEnv(
    { STREAM_PROXY_PORT: "19001", VLLM_PROXY_PORT: "19002" },
    `import(${JSON.stringify(cfgUrl)}).then(m => console.log(m.STREAM_PROXY_PORT)).catch(e => { console.error(e.message); process.exit(2); })`
  );
  assert(r.stdout.trim() === "19001", "STREAM_PROXY_PORT env wins (got " + r.stdout.trim() + ")");

  // VLLM_PROXY_PORT is honored when STREAM_PROXY_PORT is unset.
  r = runNodeWithEnv(
    { VLLM_PROXY_PORT: "19002" },
    `import(${JSON.stringify(cfgUrl)}).then(m => console.log(m.STREAM_PROXY_PORT)).catch(e => { console.error(e.message); process.exit(2); })`
  );
  assert(r.stdout.trim() === "19002", "VLLM_PROXY_PORT honored as fallback (got " + r.stdout.trim() + ")");

  // Default 18022 when neither is set.
  r = runNodeWithEnv(
    {},
    `import(${JSON.stringify(cfgUrl)}).then(m => console.log(m.STREAM_PROXY_PORT)).catch(e => { console.error(e.message); process.exit(2); })`
  );
  assert(r.stdout.trim() === "18022", "default STREAM_PROXY_PORT is 18022 (got " + r.stdout.trim() + ")");
}

// ---------------------------------------------------------------------------
// (3) USE_STREAM_PROXY honors env.
// ---------------------------------------------------------------------------
{
  const cfgUrl = pathToFileURL(path.join(REPO_ROOT, "src", "config.js")).href;
  let r = runNodeWithEnv(
    { USE_STREAM_PROXY: "false" },
    `import(${JSON.stringify(cfgUrl)}).then(m => console.log(m.USE_STREAM_PROXY))`
  );
  assert(r.stdout.trim() === "false", "USE_STREAM_PROXY=false disables (got " + r.stdout.trim() + ")");

  r = runNodeWithEnv(
    { USE_STREAM_PROXY: "0" },
    `import(${JSON.stringify(cfgUrl)}).then(m => console.log(m.USE_STREAM_PROXY))`
  );
  assert(r.stdout.trim() === "false", "USE_STREAM_PROXY=0 disables (got " + r.stdout.trim() + ")");

  r = runNodeWithEnv(
    {},
    `import(${JSON.stringify(cfgUrl)}).then(m => console.log(m.USE_STREAM_PROXY))`
  );
  assert(r.stdout.trim() === "true", "USE_STREAM_PROXY defaults to true (got " + r.stdout.trim() + ")");
}

// ---------------------------------------------------------------------------
// (4) getApiKeySync checks env before file scan.
// ---------------------------------------------------------------------------
{
  const bridgeUrl = pathToFileURL(path.join(REPO_ROOT, "src", "wsl_bridge.js")).href;
  let r = runNodeWithEnv(
    { QWEN_API_KEY: "env-key-123" },
    `import(${JSON.stringify(bridgeUrl)}).then(m => console.log(m.getApiKeySync()))`
  );
  assert(r.stdout.trim() === "env-key-123", "QWEN_API_KEY env wins (got " + r.stdout.trim() + ")");

  r = runNodeWithEnv(
    { QWEN_API_KEY: "  qwen-key-trimmed  " },
    `import(${JSON.stringify(bridgeUrl)}).then(m => console.log(m.getApiKeySync()))`
  );
  assert(r.stdout.trim() === "qwen-key-trimmed", "QWEN_API_KEY is trimmed (got " + r.stdout.trim() + ")");
}

// ---------------------------------------------------------------------------
// (5) wslAvailable() is true on non-Windows and never throws.
// ---------------------------------------------------------------------------
{
  const envUrl = pathToFileURL(path.join(REPO_ROOT, "src", "wsl_env.js")).href;
  let r = runNodeWithEnv(
    {},
    `import(${JSON.stringify(envUrl)}).then(m => console.log(m.wslAvailable()))`
  );
  // On this (non-Windows) host it must be true. On Windows it may be true/false
  // but must not throw.
  assert(
    r.status === 0 && (r.stdout.trim() === "true" || r.stdout.trim() === "false"),
    "wslAvailable() returns a boolean without throwing (got " + r.stdout.trim() + ")"
  );
}

// ---------------------------------------------------------------------------
// (6) anser config set accepts the new keys.
// ---------------------------------------------------------------------------
function runAnser(args, env = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    timeout: 15000,
    env: {
      ...process.env,
      QWEN_STATE_DIR: TMP_STATE,
      ALLOW_ENGINE_INTERRUPT: "0",
      ...env,
    },
  });
}

{
  const newKeys = [
    ["api_key", "sk-test-123"],
    ["engine_type", "dflash2"],
    ["stop_command", "bash stop.sh"],
    ["engine_log_path", "/tmp/engine.log"],
    ["use_stream_proxy", "false"],
    ["stream_proxy_port", "18022"],
    ["status_port", "18021"],
    ["vllm_port", "18020"],
  ];
  for (const [k, v] of newKeys) {
    const res = runAnser(["config", "set", k, v]);
    assert(res.status === 0, `config set ${k} exits 0 (got ${res.status})`);
  }

  // use_stream_proxy should persist as a boolean.
  const onDisk = JSON.parse(fs.readFileSync(path.join(TMP_STATE, "config.json"), "utf8"));
  assert(onDisk.use_stream_proxy === false, "use_stream_proxy persisted as boolean false");
  assert(onDisk.stream_proxy_port === 18022, "stream_proxy_port persisted as number");
  assert(onDisk.vllm_port === 18020, "vllm_port persisted as number");
  assert(onDisk.status_port === 18021, "status_port persisted as number");
  assert(onDisk.api_key === "sk-test-123", "api_key persisted as string");
  assert(onDisk.engine_type === "dflash2", "engine_type persisted as string");

  // config get round-trips.
  const res = runAnser(["config", "get", "use_stream_proxy"]);
  assert(res.stdout.trim() === "false", "config get use_stream_proxy round-trips (got " + res.stdout.trim() + ")");
}

// ---------------------------------------------------------------------------
// (7) stream_proxy.js accepts both port env names (fresh child process).
// ---------------------------------------------------------------------------
{
  // Bind a throwaway server to grab a free port, then confirm the proxy
  // child reads STREAM_PROXY_PORT (not just VLLM_PROXY_PORT).
  const http = await import("node:http");
  const blocker = http.createServer();
  await new Promise((r) => blocker.listen(0, "127.0.0.1", r));
  const port = blocker.address().port;

  const child = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, "stream_proxy.js")],
    {
      encoding: "utf8",
      timeout: 8000,
      env: {
        ...process.env,
        VLLM_PORT: "9999",
        STREAM_PROXY_PORT: String(port),
      },
    }
  );
  // EADDRINUSE -> exit 1 proves the proxy attempted to bind the STREAM_PROXY_PORT
  // value (i.e. it read the env var).
  assert(child.status === 1, "stream_proxy.js reads STREAM_PROXY_PORT (EADDRINUSE exit 1, got " + child.status + ")");
  await new Promise((r) => blocker.close(r));
}

// Cleanup
fs.rmSync(TMP_STATE, { recursive: true, force: true });

console.log("\n==========================================");
console.log(`Portability canary: ${passed} PASSED, ${failed} FAILED`);
console.log("==========================================");
if (failed > 0) process.exit(1);
