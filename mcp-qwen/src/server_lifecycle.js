import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BASE_URL,
  BOOT_TIMEOUT_MS,
  BOOT_POLL_MS,
  STREAM_PROXY_PORT,
  IS_WINDOWS,
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
  // 1. Fast check if already healthy
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`http://127.0.0.1:${STREAM_PROXY_PORT}/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (res.ok) return true;
    } catch {}
    if (attempt === 0) await new Promise((r) => setTimeout(r, 200));
  }

  // 2. Launch or restart proxy
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

  // 3. Reliable readiness probe with retries (up to 5 seconds)
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
    return { switched: false, status: "already_running" };
  }
  await runWslCommand(
    `cd ~/qwen-serving && nohup bash launchers/start_huge.sh > /tmp/mcp_launch_huge.log 2>&1 < /dev/null & disown; sleep 1; true`
  );
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, BOOT_POLL_MS));
    const now = await currentMode();
    if (now) {
      await ensureStreamProxyRunning();
      await warmEngine();
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
  metricsCache = { at: 0, data: null };
}
