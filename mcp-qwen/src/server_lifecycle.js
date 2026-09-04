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
        max_tokens: 8,
        messages: [{ role: "user", content: "Reply with: ok" }],
      }),
      signal: AbortSignal.timeout(45_000),
    });
    const dt = Date.now() - t0;
    if (!res.ok) {
      result = { ok: false, latency_ms: dt, error: `HTTP ${res.status}` };
    } else {
      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content ?? "";
      result = { ok: true, latency_ms: dt, reply: text.trim() };
    }
  } catch (err) {
    result = {
      ok: false,
      latency_ms: Date.now() - t0,
      error: err.name === "TimeoutError" ? "timeout (45s)" : err.message,
    };
  }
  canaryCache = { at: Date.now(), result };
  return result;
}

export async function readLastEngineStatsLine() {
  try {
    const { stdout } = await runWslCommand(
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
  const canary = await canaryProbe();
  const line = await readLastEngineStatsLine();
  const stats = line ? parseEngineStats(line) : null;
  const metrics = await readEngineMetrics();

  // Stats silence while requests are supposedly running indicates a stalled engine core.
  // When idle, the canary probe is the authoritative health decider.
  const isSilenceWedged = stats && stats.runningReqs > 0 && stats.ageSec > WEDGE_STATS_SILENCE_S;
  const isCanaryWedged = !canary.ok;
  const wedged = isCanaryWedged || isSilenceWedged;

  return {
    wedged,
    canary,
    stats,
    isSilenceWedged,
    isCanaryWedged,
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

export async function ensureStreamProxyRunning() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`http://127.0.0.1:${STREAM_PROXY_PORT}/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (res.ok) return true;
    } catch {}
    if (attempt === 0) await new Promise((r) => setTimeout(r, 200));
  }

  if (IS_WINDOWS) {
    try {
      await runWslCommand(`pkill -9 -f 'stream_proxy.js' 2>/dev/null || true`);
      await new Promise((r) => setTimeout(r, 300));
      await runWslCommand(
        `setsid node /mnt/d/LLM_Ecosystem/mcp-qwen/stream_proxy.js < /dev/null > /tmp/stream_proxy.log 2>&1 &`
      );
    } catch {}
  } else {
    try {
      const { spawn } = await import("child_process");
      const p = spawn("node", [path.join(__dirname, "..", "stream_proxy.js")], {
        stdio: "ignore",
        detached: true,
      });
      p.unref();
    } catch {}
  }

  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      const res = await fetch(`http://127.0.0.1:${STREAM_PROXY_PORT}/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (res.ok) return true;
    } catch {}
  }
  throw new Error(`Stream proxy failed to become healthy on port ${STREAM_PROXY_PORT} after 5s`);
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
  await runWslCommand(
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
  await runWslCommand(`cd ~/qwen-serving && bash launchers/stop_server.sh 2>/dev/null || true`);
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
