import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BASE_URL,
  BOOT_TIMEOUT_MS,
  BOOT_POLL_MS,
  STREAM_PROXY_PORT,
  IS_WINDOWS,
  TASK_DIR,
  WEDGE_STATS_SILENCE_S,
  AUTO_HEAL,
  HEAL_LOCK_FILE,
  HEAL_LOCK_TTL_MS,
  ENGINE_LOG_PATH,
  WEDGE_COUNTER_FILE,
} from "./config.js";
import { getApiKeySync, runWslCommand } from "./wsl_bridge.js";
import { streamProxyPath } from "./platform.js";

// Indirection for the WSL command runner so tests can run fully offline
// (no real wsl.exe / bash subprocesses). Defaults to the real runner.
let wslRun = runWslCommand;
export function setWslRunner(fn) {
  wslRun = typeof fn === "function" ? fn : runWslCommand;
}

// HEAL GATEKEEPER (injection hook): a function that returns true when live
// work is in flight and the engine must NOT be stopped/rebooted. Wired at
// registration time (index.js / tools.js) to the task registry so this module
// stays free of a hard dependency on task_registry.js (which has side effects
// at import: it starts the status HTTP server + a retention interval).
// Default: no gate (heal allowed) — safe for the pure lifecycle module.
let healGatekeeper = null;
export function setHealGatekeeper(fn) {
  healGatekeeper = typeof fn === "function" ? fn : null;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let bootMutex = Promise.resolve();
export function withBootMutex(fn) {
  const result = bootMutex.then(fn, fn);
  bootMutex = result.then(
    () => {},
    () => {}
  );
  return result;
}

export async function serverInfo() {
  try {
    const key = getApiKeySync();
    const res = await fetch(`${BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const j = await res.json();
    const len = j?.data?.[0]?.max_model_len;
    return { maxModelLen: len ?? 0 };
  } catch {
    return null;
  }
}

export async function currentMode() {
  const info = await serverInfo();
  if (!info) return null;
  if (info.maxModelLen >= 200_000) return "huge";
  if (info.maxModelLen > 0) return "fast";
  return "unknown";
}

let canaryCache = { at: 0, result: null };
export async function canaryProbe(force = false) {
  if (!force && canaryCache.result && Date.now() - canaryCache.at < 60_000) {
    return canaryCache.result;
  }
  const t0 = Date.now();
  let result;
  try {
    const key = getApiKeySync();
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: "qwen3.8-27b",
        // Ceiling only: the canary prompt ("Reply with: ok") makes a healthy
        // engine stop after a few visible tokens, so latency stays sub-second.
        // 8 was too small: with --reasoning-parser qwen3, server-side thinking
        // streams into the reasoning field and can consume the entire budget,
        // leaving message.content empty on a perfectly healthy engine.
        max_tokens: 512,
        messages: [{ role: "user", content: "Reply with: ok" }],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const dt = Date.now() - t0;
    if (!res.ok) {
      result = { ok: false, latency_ms: dt, error: `HTTP ${res.status}` };
    } else {
      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content ?? "";
      const reasoning =
        data?.choices?.[0]?.message?.reasoning ??
        data?.choices?.[0]?.message?.reasoning_content ??
        "";
      const contentTrimmed = content.trim();
      const reasoningTrimmed = reasoning.toString().trim();
      const hasEvidence = contentTrimmed.length > 0 || reasoningTrimmed.length > 0;
      if (hasEvidence) {
        result = {
          ok: true,
          latency_ms: dt,
          reply: contentTrimmed,
          content_chars: contentTrimmed.length,
          has_reasoning: reasoningTrimmed.length > 0,
          finish_reason: data?.choices?.[0]?.finish_reason ?? null,
        };
      } else {
        // HTTP 200 with no visible content AND no reasoning: a generation-less
        // response — the exact failure shape that silently broke task runs
        // (commit 742e007). Do NOT treat this as a healthy engine.
        result = {
          ok: false,
          latency_ms: dt,
          reply: "",
          content_chars: 0,
          has_reasoning: false,
          finish_reason: data?.choices?.[0]?.finish_reason ?? null,
          error: "generation-less response (no content, no reasoning)",
        };
      }
    }
  } catch (err) {
    result = {
      ok: false,
      latency_ms: Date.now() - t0,
      error: err.name === "TimeoutError" ? "timeout (15s)" : err.message,
    };
  }
  canaryCache = { at: Date.now(), result };
  return result;
}

export async function readLastEngineStatsLine() {
  try {
    const { stdout } = await wslRun(
      `grep -a 'Engine 000:.*Running:' ${ENGINE_LOG_PATH} 2>/dev/null | tail -1`
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export function parseEngineStats(line) {
  if (!line) return null;
  const ts = line.match(/(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
  if (!ts) return null;
  const now = new Date();
  const stamp = new Date(
    now.getFullYear(),
    Number(ts[1]) - 1,
    Number(ts[2]),
    Number(ts[3]),
    Number(ts[4]),
    Number(ts[5])
  );
  return {
    ageSec: Math.max(0, Math.round((now.getTime() - stamp.getTime()) / 1000)),
    runningReqs: Number(line.match(/Running: (\d+) reqs/)?.[1] ?? -1),
    waitingReqs: Number(line.match(/Waiting: (\d+) reqs/)?.[1] ?? -1),
  };
}

export function readWedgeCounter() {
  try {
    return JSON.parse(fs.readFileSync(WEDGE_COUNTER_FILE, "utf8"));
  } catch {
    return { count: 0, lastAt: null, lastReason: null };
  }
}

export function bumpWedgeCounter(reason) {
  try {
    const cur = readWedgeCounter();
    cur.count = (cur.count ?? 0) + 1;
    cur.lastAt = Date.now();
    cur.lastReason = String(reason ?? "").slice(0, 200);
    fs.mkdirSync(path.dirname(WEDGE_COUNTER_FILE), { recursive: true });
    fs.writeFileSync(WEDGE_COUNTER_FILE, JSON.stringify(cur));
  } catch {}
}

export async function engineWedgeState() {
  // BUSY-GATE: read the engine gauges FIRST. The engine runs MAX_SEQS=1 (one
  // generation at a time), so while any coworker task is synthesizing (prefill
  // TTFTs of 100-286s are NORMAL) a canary generation would queue behind it and
  // time out at the abort deadline — measuring queue depth, NOT health. Firing
  // the canary unconditionally misfired twice in production (killed a 17-minute
  // task). So: when the engine is busy, do NOT fire the canary; the only wedge
  // signal is stats silence. When idle, the canary is authoritative.
  const metrics = await readEngineMetrics();
  const runningReqs = metrics?.["vllm:num_requests_running"] ?? 0;
  const waitingReqs = metrics?.["vllm:num_requests_waiting"] ?? 0;
  const engineBusy = runningReqs > 0 || waitingReqs > 0;

  const line = await readLastEngineStatsLine();
  const stats = line ? parseEngineStats(line) : null;

  // Stats silence while requests are supposedly running indicates a stalled engine core.
  const isSilenceWedged = Boolean(
    stats && stats.runningReqs > 0 && stats.ageSec > WEDGE_STATS_SILENCE_S
  );

  let canary;
  let isCanaryWedged;
  if (engineBusy) {
    // Neutral sentinel: a canary queued behind an active generation is meaningless.
    canary = { ok: true, skipped: "engine_busy", latency_ms: 0 };
    isCanaryWedged = false;
  } else {
    canary = await canaryProbe();
    isCanaryWedged = !canary.ok;
  }

  // When busy, the canary is ignored — only stats silence can declare a wedge.
  // When idle, the canary remains authoritative.
  const wedged = engineBusy
    ? isSilenceWedged
    : Boolean(isCanaryWedged || isSilenceWedged);

  return {
    wedged,
    canary,
    stats,
    isSilenceWedged,
    isCanaryWedged,
    engineBusy,
    gauges: metrics
      ? {
          running_requests: metrics["vllm:num_requests_running"] ?? null,
          waiting_requests: metrics["vllm:num_requests_waiting"] ?? null,
          kv_cache_pct: metrics["vllm:gpu_cache_usage_factor"]
            ? Math.round(metrics["vllm:gpu_cache_usage_factor"] * 1000) / 10
            : null,
          prefix_cache_hit_ratio: metrics["vllm:prefix_cache_hit_rate"] ?? null,
          spec_decode_acceptance: metrics["vllm:spec_decode_draft_acceptance_rate"] ?? null,
        }
      : null,
  };
}

export async function healWedgedEngine(statsAgeSec) {
  let lock = null;
  try {
    lock = JSON.parse(fs.readFileSync(HEAL_LOCK_FILE, "utf8"));
  } catch {}
  if (lock && Date.now() - lock.at < HEAL_LOCK_TTL_MS) {
    return {
      healed: false,
      note: `heal already started ${Math.round((Date.now() - lock.at) / 1000)}s ago by pid ${lock.pid}; boot in progress`,
    };
  }
  // HEAL BACKSTOP: refuse to stop/reboot the engine while live work is in
  // flight (in-memory running/queued tasks, or a disk task whose owner pid is
  // alive with a recent heartbeat). A reboot here would kill the in-flight
  // task's socket (undici "terminated"). Deliberately does NOT bump the wedge
  // counter — this is a healthy-but-busy engine, not a wedge.
  if (healGatekeeper) {
    try {
      if (healGatekeeper()) {
        return { healed: false, note: "tasks in flight; heal refused" };
      }
    } catch {
      // Gatekeeper error: fail safe — do not reboot a possibly-busy engine.
      return { healed: false, note: "tasks in flight; heal refused" };
    }
  }
  try {
    fs.mkdirSync(TASK_DIR, { recursive: true });
    fs.writeFileSync(HEAL_LOCK_FILE, JSON.stringify({ at: Date.now(), pid: process.pid, statsAgeSec }));
    bumpWedgeCounter(`stats_age=${statsAgeSec}s`);
  } catch {}
  await stopServer();
  const res = await ensureServerRunning();
  resetEngineHealthCache();
  return { healed: true, boot: res.status };
}

export async function warmEngine() {
  try {
    const key = getApiKeySync();
    await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: "qwen3.8-27b",
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
        temperature: 0.0,
      }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch {}
}

// ---------------------------------------------------------------------------
// P10 — Stream-proxy lifecycle hardening
// ---------------------------------------------------------------------------
//
// The legacy ensureStreamProxyRunning had three weaknesses, some observed
// live this week:
//   (a) its `catch {}` swallowed spawn failures silently, so a failed spawn
//       looked identical to a slow start;
//   (b) its pre-kill `pkill -9 -f 'stream_proxy.js'` was a broad pattern that
//       could match unrelated processes and left a zombie (observed: pid 242
//       defunct) when the parent did not reap;
//   (c) its 5s health window (25 x 200ms) was too tight for a cold WSL node
//       spawn (observed: two consecutive dispatch boots failed with "failed
//       to become healthy ... after 5s" while the proxy was actually coming
//       up at ~6-8s).
//
// The hardened path:
//   1. TARGETED pre-spawn cleanup: kill the CURRENT listener on the port by
//      its specific pid (probed from /health, or from `ss -ltnp`), never a
//      broad `pkill -f`. Best-effort, and it LOGS what it did.
//   2. HONEST spawn: the spawner is an injectable seam (setStreamProxySpawner)
//      so offline tests can simulate a slow or failed start. Spawn failures
//      are CAPTURED (not swallowed) and included in the final error.
//   3. WIDER health window: 15s (75 x 200ms) with early-exit success, so a
//      cold WSL node spawn (6-8s) is no longer misreported as a failure.

// Indirection for the stream-proxy spawner so tests can simulate a slow or
// failed start without a real node subprocess. Defaults to the real spawner.
let spawnStreamProxy = null;
export function setStreamProxySpawner(fn) {
  spawnStreamProxy = typeof fn === "function" ? fn : null;
}

/**
 * The real stream-proxy spawner. Windows: spawn inside WSL via setsid.
 * Linux: spawn a detached node child directly.
 */
async function realSpawnStreamProxy() {
  if (IS_WINDOWS) {
    await runWslCommand(
      `setsid node ${streamProxyPath()} < /dev/null > /tmp/stream_proxy.log 2>&1 &`
    );
  } else {
    const { spawn } = await import("child_process");
    const p = spawn("node", [path.join(__dirname, "..", "stream_proxy.js")], {
      stdio: "ignore",
      detached: true,
    });
    p.unref();
  }
}

/**
 * Find the pid of the process currently listening on the stream-proxy port,
 * if any. Probes /health first (the proxy may be alive but wedged), then
 * falls back to `ss -ltnp` on the port. Returns null when no listener is
 * found. Never throws.
 * @returns {Promise<number|null>}
 */
async function findStreamProxyListenerPid() {
  // 1. Probe /health for a pid (the proxy may be alive but not healthy).
  try {
    const res = await fetch(`http://127.0.0.1:${STREAM_PROXY_PORT}/health`, {
      signal: AbortSignal.timeout(1000),
    });
    const body = await res.text();
    const j = JSON.parse(body);
    if (j && Number.isFinite(j.pid) && j.pid > 0) return j.pid;
  } catch {}
  // 2. Fall back to `ss -ltnp` filtered to the port.
  try {
    const { stdout } = await runWslCommand(
      `ss -ltnp 'sport = :${STREAM_PROXY_PORT}' 2>/dev/null | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2 || true`
    );
    const pid = parseInt(stdout.trim(), 10);
    if (Number.isFinite(pid) && pid > 0) return pid;
  } catch {}
  return null;
}

/**
 * Ensure the universal stream proxy is running and healthy on
 * STREAM_PROXY_PORT.
 *
 * @param {object} [opts]
 * @param {number} [opts.healthPolls=75] number of 200ms health polls before
 *   declaring failure (default 75 = 15s). Tests may pass a smaller value.
 * @returns {Promise<boolean>} true once the proxy is healthy.
 * @throws {Error} if the proxy does not become healthy within the window;
 *   the message includes the captured spawn failure when present.
 */
export async function ensureStreamProxyRunning({ healthPolls = 75 } = {}) {
  // 1. Is the proxy already healthy? (two quick probes)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`http://127.0.0.1:${STREAM_PROXY_PORT}/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (res.ok) return true;
    } catch {}
    if (attempt === 0) await new Promise((r) => setTimeout(r, 200));
  }

  // 2. TARGETED pre-spawn cleanup: kill the current listener on the port by
  //    its specific pid (never a broad `pkill -f 'stream_proxy.js'`).
  //    Best-effort; log what we did.
  const listenerPid = await findStreamProxyListenerPid();
  if (listenerPid) {
    try {
      if (IS_WINDOWS) {
        await runWslCommand(`kill -9 ${listenerPid} 2>/dev/null || true`);
      } else {
        try {
          process.kill(listenerPid, "SIGKILL");
        } catch {}
      }
      process.stderr.write(
        `[stream-proxy] pre-spawn cleanup: killed listener pid ${listenerPid} on port ${STREAM_PROXY_PORT}\n`
      );
      await new Promise((r) => setTimeout(r, 300));
    } catch (err) {
      process.stderr.write(
        `[stream-proxy] pre-spawn cleanup: failed to kill pid ${listenerPid}: ${err.message}\n`
      );
    }
  } else {
    process.stderr.write(
      `[stream-proxy] pre-spawn cleanup: no listener found on port ${STREAM_PROXY_PORT}\n`
    );
  }

  // 3. SPAWN the proxy (injected spawner for tests, real spawner otherwise).
  //    Do NOT swallow spawn errors: capture them for the final error message.
  let spawnFailure = null;
  try {
    if (spawnStreamProxy) {
      await spawnStreamProxy();
    } else {
      await realSpawnStreamProxy();
    }
  } catch (err) {
    spawnFailure = err;
    process.stderr.write(`[stream-proxy] spawn failed: ${err.message}\n`);
  }

  // 4. HEALTH window: 15s (75 x 200ms) with early-exit success. A cold WSL
  //    node spawn routinely needs 6-8s; the old 5s window misfired on live
  //    dispatches.
  for (let i = 0; i < healthPolls; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      const res = await fetch(`http://127.0.0.1:${STREAM_PROXY_PORT}/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (res.ok) return true;
    } catch {}
  }

  const seconds = Math.round((healthPolls * 200) / 1000);
  const spawnNote = spawnFailure ? ` (spawn failure: ${spawnFailure.message})` : "";
  throw new Error(
    `Stream proxy failed to become healthy on port ${STREAM_PROXY_PORT} after ${seconds}s${spawnNote}`
  );
}

export async function ensureServerRunning() {
  const current = await currentMode();
  if (current) {
    const wedge = await engineWedgeState();
    if (wedge.wedged && AUTO_HEAL) {
      const heal = await healWedgedEngine(wedge.stats?.ageSec ?? null);
      return { switched: true, status: "restarted_wedged_engine", heal };
    }
    return { switched: false, status: "already_running" };
  }
  await wslRun(
    `cd ~/qwen-serving && nohup bash launchers/start_huge.sh > ${ENGINE_LOG_PATH} 2>&1 < /dev/null & disown; sleep 1; true`
  );
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, BOOT_POLL_MS));
    const now = await currentMode();
    if (now) {
      await ensureStreamProxyRunning();
      await warmEngine();
      resetEngineHealthCache();
      return { switched: true, status: "started" };
    }
  }
  throw new Error(`Timed out waiting for vLLM server to boot (${BOOT_TIMEOUT_MS}ms)`);
}

export async function stopServer() {
  await wslRun(`cd ~/qwen-serving && bash launchers/stop_server.sh 2>/dev/null || true`);
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const mode = await currentMode();
    if (!mode) return { stopped: true };
  }
  return { stopped: true };
}

let metricsCache = { at: 0, data: null };
export async function readEngineMetrics(maxAgeMs = 5000) {
  if (metricsCache.data && Date.now() - metricsCache.at < maxAgeMs) return metricsCache.data;
  try {
    const res = await fetch(`${BASE_URL.replace(/\/v1$/, "")}/metrics`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const map = {};
    for (const line of (await res.text()).split("\n")) {
      if (!line.startsWith("vllm:")) continue;
      const name = line.match(/^(vllm:[^{ ]+)/)?.[1];
      const val = Number(line.slice(line.lastIndexOf(" ") + 1));
      if (!name || !Number.isFinite(val)) continue;
      map[name] = Math.max(map[name] ?? -Infinity, val);
    }
    metricsCache = { at: Date.now(), data: map };
    return map;
  } catch {
    metricsCache = { at: Date.now(), data: null };
    return null;
  }
}

export function resetEngineHealthCache() {
  canaryCache = { at: 0, result: null };
  metricsCache = { at: 0, data: null };
}
