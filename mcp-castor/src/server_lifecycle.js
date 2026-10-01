import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BASE_URL,
  BOOT_TIMEOUT_MS,
  BOOT_POLL_MS,
  STREAM_PROXY_PORT,
  STREAM_PROXY_PORT_RESOLVED,
  USE_STREAM_PROXY,
  USE_STREAM_PROXY_RESOLVED,
  IS_WINDOWS,
  TASK_DIR,
  WEDGE_STATS_SILENCE_S,
  AUTO_HEAL,
  HEAL_LOCK_FILE,
  HEAL_LOCK_TTL_MS,
  ENGINE_BOOT_LOCK_FILE,
  ENGINE_BOOT_LOCK_TTL_MS,
  ENGINE_LOG_PATH,
  WEDGE_COUNTER_FILE,
  ALLOW_ENGINE_INTERRUPT,
  IS_TEST_ENV,
  MODEL,
  LAUNCH_COMMAND,
} from "./config.js";
import { getApiKeySync, runWslCommand } from "./wsl_bridge.js";
import { streamProxyPath, launcherScriptPath } from "./platform.js";
import { wslAvailable } from "./wsl_env.js";

// Indirection for the WSL command runner; tests inject a stub to run offline.
let wslRun = runWslCommand;
export function setWslRunner(fn) {
  wslRun = typeof fn === "function" ? fn : runWslCommand;
}

// Heal gatekeeper: returns true when live work is in flight and the engine
// must not be stopped/rebooted. Wired at registration time (index.js /
// tools.js) to the task registry so this module avoids a hard dependency on
// task_registry.js (which starts the status HTTP server and a retention
// interval at import). Default: no gate (heal allowed).
let healGatekeeper = null;
export function setHealGatekeeper(fn) {
  healGatekeeper = typeof fn === "function" ? fn : null;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let bootMutex = Promise.resolve();

/**
 * Serializes a function against a module-level mutex so only one invocation
 * runs at a time; each call waits for the previous one to settle (resolve or
 * reject) before starting.
 * @param {() => any} fn - The function to run under the mutex.
 * @returns {Promise<any>} The promise returned by `fn`.
 */
export function withBootMutex(fn) {
  const result = bootMutex.then(fn, fn);
  bootMutex = result.then(
    () => {},
    () => {}
  );
  return result;
}

/**
 * Atomically acquires an exclusive lockfile using O_EXCL (openSync 'wx').
 * If the lockfile exists:
 *   - Reads existing metadata.
 *   - If active (age < ttlMs), returns { acquired: false, heldBy: cur }.
 *   - If stale (age >= ttlMs), atomically renames to a PID-tagged tombstone,
 *     unlinks the tombstone, and retries openSync("wx") once.
 *
 * @param {string} lockPath
 * @param {number} ttlMs
 * @param {object} payload
 * @returns {{ acquired: boolean, heldBy?: object }}
 */
export function tryAcquireExclusiveLock(lockPath, ttlMs, payload) {
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  } catch {}

  const writePayload = (fd) => {
    fs.writeSync(fd, JSON.stringify({ ...payload, at: Date.now(), pid: process.pid }));
    fs.closeSync(fd);
  };

  try {
    const fd = fs.openSync(lockPath, "wx");
    writePayload(fd);
    return { acquired: true };
  } catch (err) {
    if (err.code !== "EEXIST") {
      return { acquired: false, error: err.message };
    }
  }

  let cur = null;
  try {
    cur = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  } catch {}

  const age = cur?.at ? Date.now() - cur.at : Infinity;
  if (cur && age < ttlMs) {
    return { acquired: false, heldBy: cur };
  }

  // Stale recovery: Atomic Rename-to-Tombstone
  const tombstone = `${lockPath}.stale_${Date.now()}_${process.pid}`;
  try {
    fs.renameSync(lockPath, tombstone);
    fs.rmSync(tombstone, { force: true });
  } catch {}

  try {
    const fd = fs.openSync(lockPath, "wx");
    writePayload(fd);
    return { acquired: true };
  } catch {
    return { acquired: false, heldBy: cur };
  }
}

/**
 * Releases an exclusive lockfile only if owned by this process.
 * @param {string} lockPath
 */
export function releaseExclusiveLock(lockPath) {
  try {
    const cur = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    if (!cur || cur.pid === process.pid) {
      fs.rmSync(lockPath, { force: true });
    }
  } catch {
    try {
      fs.rmSync(lockPath, { force: true });
    } catch {}
  }
}

/**
 * Queries the vLLM engine's /models endpoint and reports the maximum model
 * length of the first served model.
 * @returns {Promise<{maxModelLen: number}|null>} The max model length, or
 *   null when the engine is unreachable or returns a non-OK status.
 */
export async function serverInfo() {
  try {
    const key = getApiKeySync();
    // Omit the Authorization header when no key file is present.
    const headers = {};
    if (key) headers.Authorization = `Bearer ${key}`;
    const res = await fetch(`${BASE_URL}/models`, {
      headers,
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

/**
 * Classifies the engine by its max model length.
 * @returns {Promise<"huge"|"fast"|"unknown"|null>} "huge" for >= 200000,
 *   "fast" for > 0, "unknown" for 0, or null when the engine is unreachable.
 */
async function currentMode() {
  const info = await serverInfo();
  if (!info) return null;
  if (info.maxModelLen >= 200_000) return "huge";
  if (info.maxModelLen > 0) return "fast";
  return "unknown";
}

let canaryCache = { at: 0, result: null };

/**
 * Probes engine health by issuing a minimal chat completion and inspecting the
 * response for visible content or reasoning. Results are cached for 60s.
 * @param {boolean} [force=false] - Bypass the 60s cache and re-probe.
 * @returns {Promise<object>} A result object with `ok` (boolean),
 *   `latency_ms`, and either `skipped` (when the probe was not run) or
 *   `reply`/`content_chars`/`has_reasoning`/`finish_reason`/`error`.
 */
export async function canaryProbe(force = false) {
  if (wslRun === runWslCommand && (process.env.TEST_OFFLINE === "1" || (IS_TEST_ENV && !ALLOW_ENGINE_INTERRUPT))) {
    return { ok: true, skipped: "engine_protected_offline", latency_ms: 0 };
  }
  if (!force && canaryCache.result && Date.now() - canaryCache.at < 60_000) {
    return canaryCache.result;
  }
  const t0 = Date.now();
  let result;
  try {
    const key = getApiKeySync();
    // Omit the Authorization header when no key file is present.
    const headers = { "Content-Type": "application/json" };
    if (key) headers.Authorization = `Bearer ${key}`;
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: MODEL,
        // Cap on total generated tokens (content + reasoning).
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
        // HTTP 200 with neither content nor reasoning is a generation-less
        // response and is not treated as a healthy engine.
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

async function readLastEngineStatsLine() {
  try {
    const { stdout } = await wslRun(
      `grep -a 'Engine 000:.*Running:' ${ENGINE_LOG_PATH} 2>/dev/null | tail -1`
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

function parseEngineStats(line) {
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
    const tmp = `${WEDGE_COUNTER_FILE}.tmp_${Date.now()}_${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(cur), "utf8");
    fs.renameSync(tmp, WEDGE_COUNTER_FILE);
  } catch (err) {
    process.stderr.write(`[server_lifecycle] Failed to bump wedge counter: ${err.message}\n`);
  }
}

/**
 * Determines whether the engine is wedged. The engine runs a single
 * concurrent generation (MAX_SEQS=1), so a canary probe is only meaningful
 * when the engine is idle; while busy, a canary would queue behind the active
 * generation and time out, so only stats silence is used as a wedge signal.
 * @returns {Promise<object>} A state object with `wedged`, `canary`, `stats`,
 *   `isSilenceWedged`, `isCanaryWedged`, `engineBusy`, and `gauges`.
 */
export async function engineWedgeState() {
  // Read the engine gauges first to determine busy state.
  const metrics = await readEngineMetrics();
  // /metrics unavailable is treated as busy (fail-closed).
  const metricsUnavailable = metrics === null;
  const runningReqs = metrics?.["vllm:num_requests_running"] ?? 0;
  const waitingReqs = metrics?.["vllm:num_requests_waiting"] ?? 0;
  const engineBusy = metricsUnavailable || runningReqs > 0 || waitingReqs > 0;

  const line = await readLastEngineStatsLine();
  const stats = line ? parseEngineStats(line) : null;

  // Stats silence while requests are running indicates a stalled engine core.
  const isSilenceWedged = Boolean(
    runningReqs > 0 && stats && stats.runningReqs > 0 && stats.ageSec > WEDGE_STATS_SILENCE_S
  );

  let canary;
  let isCanaryWedged;
  if (engineBusy) {
    // When busy due to a metrics fetch failure, the canary is refused with an
    // explicit error (fail-closed) rather than a neutral sentinel.
    canary = metricsUnavailable
      ? { ok: false, skipped: "metrics_unavailable", error: "/metrics fetch failed; busy-gate fail-closed" }
      : { ok: true, skipped: "engine_busy", latency_ms: 0 };
    isCanaryWedged = false;
  } else {
    canary = await canaryProbe();
    isCanaryWedged = !canary.ok;
  }

  // When busy, the canary is ignored — only stats silence can declare a wedge.
  // When idle, the canary probe is authoritative.
  const wedged = engineBusy
    ? isSilenceWedged
    : Boolean(isCanaryWedged);

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

/**
 * Stops and restarts a wedged engine. Refuses to run when engine interruption
 * is disabled, when the heal gatekeeper reports live work in flight, or when
 * another process already holds the heal lock.
 * @param {number|null} statsAgeSec - Age of the last engine stats line, in
 *   seconds; recorded in the heal lock payload.
 * @returns {Promise<object>} A result object with `healed` (boolean) and a
 *   `note` (when refused) or `boot` status (when healed).
 */
export async function healWedgedEngine(statsAgeSec) {
  if (wslRun === runWslCommand && (process.env.TEST_OFFLINE === "1" || (IS_TEST_ENV && !ALLOW_ENGINE_INTERRUPT))) {
    return { healed: false, note: "heal refused: engine interruption disabled by default (ALLOW_ENGINE_INTERRUPT unset)" };
  }
  // Refuse to stop/reboot the engine while live work is in flight.
  if (healGatekeeper) {
    try {
      if (healGatekeeper()) {
        return { healed: false, note: "tasks in flight; heal refused" };
      }
    } catch {
      return { healed: false, note: "tasks in flight; heal refused" };
    }
  }

  const lockResult = tryAcquireExclusiveLock(HEAL_LOCK_FILE, HEAL_LOCK_TTL_MS, {
    pid: process.pid,
    statsAgeSec,
  });

  if (!lockResult.acquired) {
    const lock = lockResult.heldBy;
    const ago = lock?.at ? Math.round((Date.now() - lock.at) / 1000) : "unknown";
    const pid = lock?.pid ?? "unknown";
    return {
      healed: false,
      note: `heal already started ${ago}s ago by pid ${pid}; boot in progress`,
    };
  }

  bumpWedgeCounter(`stats_age=${statsAgeSec}s`);
  await stopServer();
  const res = await ensureServerRunning();
  resetEngineHealthCache();
  return { healed: true, boot: res.status };
}

async function warmEngine() {
  try {
    const key = getApiKeySync();
    // Omit Authorization header when no key file is present.
    const headers = { "Content-Type": "application/json" };
    if (key) headers.Authorization = `Bearer ${key}`;
    await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
        temperature: 0.0,
      }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch {}
}

// ---------------------------------------------------------------------------
// Stream-proxy lifecycle
// ---------------------------------------------------------------------------
// Pre-spawn cleanup is targeted: it kills the current listener on the port by
// its specific pid (probed from /health or `ss -ltnp`), never a broad `pkill -f`.

// Indirection for the stream-proxy spawner; tests inject a stub to simulate a
// slow or failed start.
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
    // WSL tears the session down when the `bash -c` leader exits, which can
    // kill a freshly-forked background child before it execs; the 1s linger
    // keeps the session alive long enough for the child to detach.
    await runWslCommand(
      `setsid node ${streamProxyPath()} < /dev/null > /tmp/stream_proxy.log 2>&1 & sleep 1`
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
 * Finds the pid of the process currently listening on the stream-proxy port,
 * if any. Probes /health first, then falls back to `ss -ltnp` on the port.
 * @returns {Promise<{pid: number, verified: boolean}|null>} The listener pid
 *   and whether it was verified as the stream proxy, or null when no listener
 *   is found. Never throws.
 */
async function findStreamProxyListenerPid() {
  const port = STREAM_PROXY_PORT_RESOLVED;
  // 1. Probe /health for a verified pid.
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(1000),
    });
    if (res.ok) {
      const j = await res.json();
      if (j && (j.service === "mcp-castor-stream-proxy" || j.service === "mcp-qwen-stream-proxy") && Number.isFinite(j.pid) && j.pid > 0) {
        return { pid: j.pid, verified: true };
      }
    }
  } catch {}
  // 2. Fall back to `ss -ltnp` filtered to the port.
  try {
    const { stdout } = await runWslCommand(
      `ss -ltnp 'sport = :${port}' 2>/dev/null | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2 || true`
    );
    const pid = parseInt(stdout.trim(), 10);
    if (Number.isFinite(pid) && pid > 0) {
      try {
        const { stdout: cmdline } = await runWslCommand(
          `tr '\\0' ' ' < /proc/${pid}/cmdline 2>/dev/null || true`
        );
        if (cmdline.includes("stream_proxy.js")) {
          return { pid, verified: true };
        }
      } catch {}
      return { pid, verified: false };
    }
  } catch {}
  return null;
}

/**
 * Ensures the universal stream proxy is running and healthy on
 * STREAM_PROXY_PORT.
 * @param {object} [opts]
 * @param {number} [opts.healthPolls=75] Number of 200ms health polls before
 *   declaring failure (default 75 = 15s). Tests may pass a smaller value.
 * @returns {Promise<boolean>} true once the proxy is healthy.
 * @throws {Error} If the proxy does not become healthy within the window;
 *   the message includes the captured spawn failure when present.
 */
export async function ensureStreamProxyRunning({ healthPolls = 75 } = {}) {
  // 0a. If the stream proxy is disabled by configuration, skip cleanly.
  //     The engine is reached directly (no proxy hop).
  if (!USE_STREAM_PROXY_RESOLVED) {
    process.stderr.write(
      `[stream-proxy] disabled by configuration (USE_STREAM_PROXY=false); using direct engine connection\n`
    );
    return true;
  }

  // 0b. On Windows without WSL, the proxy (which runs inside WSL) cannot be
  //     spawned. Do NOT crash the whole task: warn and allow a direct engine
  //     connection so the task can still proceed.
  if (!spawnStreamProxy && IS_WINDOWS && !wslAvailable()) {
    process.stderr.write(
      `[stream-proxy] WSL is not available on this Windows host; skipping proxy and using direct engine connection\n`
    );
    return true;
  }

  const port = STREAM_PROXY_PORT_RESOLVED;

  // 1. Is the proxy already healthy? (two quick probes)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (res.ok) return true;
    } catch {}
    if (attempt === 0) await new Promise((r) => setTimeout(r, 200));
  }

  // 2. TARGETED pre-spawn cleanup: kill the current listener on the port ONLY if verified.
  const listenerInfo = await findStreamProxyListenerPid();
  if (listenerInfo) {
    if (!listenerInfo.verified) {
      throw new Error(
        `PortConflictError: Port ${port} is occupied by unverified process pid ${listenerInfo.pid}. Refusing to kill non-proxy process.`
      );
    }
    const listenerPid = listenerInfo.pid;
    try {
      if (IS_WINDOWS) {
        await runWslCommand(`kill -9 ${listenerPid} 2>/dev/null || true`);
      } else {
        try {
          process.kill(listenerPid, "SIGKILL");
        } catch {}
      }
      process.stderr.write(
        `[stream-proxy] pre-spawn cleanup: killed verified listener pid ${listenerPid} on port ${port}\n`
      );
      await new Promise((r) => setTimeout(r, 300));
    } catch (err) {
      process.stderr.write(
        `[stream-proxy] pre-spawn cleanup: failed to kill pid ${listenerPid}: ${err.message}\n`
      );
    }
  } else {
    process.stderr.write(
      `[stream-proxy] pre-spawn cleanup: no listener found on port ${port}\n`
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

  // 4. Health window: poll until the proxy reports healthy, with early exit.
  for (let i = 0; i < healthPolls; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (res.ok) return true;
    } catch {}
  }

  const seconds = Math.round((healthPolls * 200) / 1000);
  const spawnNote = spawnFailure ? ` (spawn failure: ${spawnFailure.message})` : "";
  throw new Error(
    `Stream proxy failed to become healthy on port ${port} after ${seconds}s${spawnNote}`
  );
}

/**
 * Ensures the vLLM engine is running. If the engine is already up it checks
 * for a wedge (healing one when AUTO_HEAL is enabled); otherwise it boots the
 * engine, coordinating across processes via an atomic boot lock.
 * @returns {Promise<object>} A result object with `switched` (boolean) and a
 *   `status` string; when a wedged engine was healed, a `heal` object is
 *   included.
 */
export async function ensureServerRunning() {
  if (wslRun === runWslCommand && (process.env.TEST_OFFLINE === "1" || (IS_TEST_ENV && !ALLOW_ENGINE_INTERRUPT))) {
    return { switched: false, status: "boot_refused_offline_protected" };
  }
  const current = await currentMode();
  if (current) {
    const wedge = await engineWedgeState();
    if (wedge.wedged && AUTO_HEAL) {
      const heal = await healWedgedEngine(wedge.stats?.ageSec ?? null);
      return { switched: true, status: "restarted_wedged_engine", heal };
    }
    return { switched: false, status: "already_running" };
  }

  // Cross-process atomic boot lock: only ONE instance executes the launcher script.
  const lock = tryAcquireExclusiveLock(ENGINE_BOOT_LOCK_FILE, ENGINE_BOOT_LOCK_TTL_MS, {
    pid: process.pid,
    action: "booting_huge",
  });

  if (!lock.acquired) {
    // Secondary instance: wait for primary instance to finish booting.
    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, BOOT_POLL_MS));
      const now = await currentMode();
      if (now) {
        await ensureStreamProxyRunning();
        resetEngineHealthCache();
        return { switched: true, status: "started_by_peer" };
      }
    }
    throw new Error(`Timed out waiting for peer vLLM server to boot (${BOOT_TIMEOUT_MS}ms)`);
  }

  try {
    if (LAUNCH_COMMAND) {
      // Use the configured launch command (from QWEN_LAUNCH_COMMAND or
      // ~/.castor/config.json `launch_command`). This is the portable path:
      // the user controls exactly how the engine is started.
      await wslRun(
        `nohup bash -c '${LAUNCH_COMMAND.replace(/'/g, "'\\''")}' > ${ENGINE_LOG_PATH} 2>&1 < /dev/null & disown; sleep 1; true`
      );
    } else {
      // Fall back to the repo's launcher script.
      const launcher = launcherScriptPath();
      await wslRun(
        `cd ~/qwen-serving && if [ -f "${launcher}" ]; then nohup bash "${launcher}"; elif [ -f launchers/start_huge.sh ]; then nohup bash launchers/start_huge.sh; else nohup bash single-user/start_qwen.sh; fi > ${ENGINE_LOG_PATH} 2>&1 < /dev/null & disown; sleep 1; true`
      );
    }
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
  } finally {
    releaseExclusiveLock(ENGINE_BOOT_LOCK_FILE);
  }
}

/**
 * Stops the vLLM engine and waits up to 5s for it to stop responding.
 * @returns {Promise<object>} A result object with `stopped` (boolean) and a
 *   `reason` string; when the engine still responds after the grace window,
 *   `stopped` is false and `mode` reports the detected engine mode.
 */
export async function stopServer() {
  if (wslRun === runWslCommand && (process.env.TEST_OFFLINE === "1" || (IS_TEST_ENV && !ALLOW_ENGINE_INTERRUPT))) {
    return {
      stopped: false,
      reason: "stop_refused_offline_protected",
      note: "stopServer refused: engine interruption disabled by default (ALLOW_ENGINE_INTERRUPT unset)",
    };
  }
  await wslRun(`cd ~/qwen-serving && bash launchers/stop_server.sh 2>/dev/null || true`);
  let mode = null;
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 500));
    mode = await currentMode();
    if (!mode) return { stopped: true };
  }
  // The grace window elapsed but the engine still responds: report a failure
  // rather than a success.
  return {
    stopped: false,
    reason: "engine_still_responding",
    mode,
  };
}

let metricsCache = { at: 0, data: null };

/**
 * Fetches and parses the vLLM /metrics endpoint, returning a map of metric
 * name to value. Results are cached for `maxAgeMs`.
 * @param {number} [maxAgeMs=5000] Maximum age of a cached result, in
 *   milliseconds.
 * @returns {Promise<Record<string, number>|null>} The parsed metrics, or null
 *   when the fetch fails.
 */
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
  } catch (err) {
    // A /metrics fetch failure is logged to stderr and reported as null; the
    // caller (engineWedgeState) treats it as busy (fail-closed).
    process.stderr.write(`[server_lifecycle] /metrics fetch failed: ${err.message}\n`);
    metricsCache = { at: Date.now(), data: null };
    return null;
  }
}

/**
 * Clears the canary and metrics caches so the next probe re-fetches.
 */
export function resetEngineHealthCache() {
  canaryCache = { at: 0, result: null };
  metricsCache = { at: 0, data: null };
}
