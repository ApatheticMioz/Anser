import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { winHomeWsl } from "./platform.js";

export const IS_WINDOWS = process.platform === "win32";

export const VLLM_PORT = parseInt(process.env.VLLM_PORT || "18020", 10);
export const STATUS_PORT = parseInt(process.env.STATUS_PORT || "18021", 10);
export const STREAM_PROXY_PORT = parseInt(process.env.STREAM_PROXY_PORT || "18022", 10);

export const BASE_URL = `http://localhost:${VLLM_PORT}/v1`;
export const MAX_LEN_HUGE = 245760;
export const BOOT_TIMEOUT_MS = 180_000;
export const BOOT_POLL_MS = 3000;

// Output budget: default max_tokens for a single generation turn. Raised from
// 16384 to 49152 so that server-side reasoning (thinking) tokens no longer
// consume the entire budget before any content / tool calls are emitted.
// Overridable per-dispatch via QWEN_MAX_TOKENS (the 245K context window easily
// fits ~100k prompt + 49k output).
export const DEFAULT_MAX_TOKENS = 49152;
export const MAX_TOKENS = (() => {
  const parsed = parseInt(process.env.QWEN_MAX_TOKENS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_TOKENS;
})();

// Reasoning-effort passthrough: read dynamically (at call time) so callers and
// tests can toggle it per-dispatch. Defaults to "xhigh" per SOTA reasoning
// test-time compute depth findings. Can be overridden via QWEN_REASONING_EFFORT.
export function getReasoningEffort() {
  const v = process.env.QWEN_REASONING_EFFORT;
  return v ? v : "xhigh";
}

export const DEFAULT_RACE_MS = 15_000;
export const RACE_MS = process.env.QWEN_RACE_MS
  ? parseInt(process.env.QWEN_RACE_MS, 10)
  : DEFAULT_RACE_MS;

export const DEFAULT_TIMEOUT_MS = 14_400_000; // 4 hours
export const DEFAULT_MIN_TIMEOUT_MS = 600_000;
export const MIN_TIMEOUT_MS = (() => {
  const parsed = parseInt(process.env.QWEN_MIN_TIMEOUT_MS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MIN_TIMEOUT_MS;
})();

export const INACTIVITY_TIMEOUT_MS = (() => {
  const parsed = parseInt(process.env.QWEN_INACTIVITY_TIMEOUT_MS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1_800_000; // 30 min
})();

export const FIRST_TOKEN_TIMEOUT_MS = (() => {
  const parsed = parseInt(process.env.QWEN_FIRST_TOKEN_TIMEOUT_MS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 240_000; // 4 min
})();

// P7b: streaming idle tolerance for a single generation turn. This is the
// first-byte AND inter-chunk idle watchdog on the provider's SSE read loop.
// A legitimate first token can take many minutes on a cold 200K prefill
// (prefix-cache miss) or behind a queued request on a MAX_SEQS=1 engine, so
// the default is 15 minutes (900000ms) — well above any realistic TTFT — and
// is overridable via QWEN_STREAM_IDLE_TIMEOUT_MS. This is a DIFFERENT axis
// from max_tokens (generation-length cap); it only bounds how long the stream
// may go SILENT before we declare the connection dead.
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 900_000; // 15 min
export const STREAM_IDLE_TIMEOUT_MS = (() => {
  const parsed = parseInt(process.env.QWEN_STREAM_IDLE_TIMEOUT_MS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_STREAM_IDLE_TIMEOUT_MS;
})();

// P7b: per-turn ceiling on reasoning (thinking) tokens, enforced CLIENT-side
// by the provider's SSE read loop. Ground truth (P7b forensics): a reasoning
// loop burned a single uninterrupted ~18-minute generation to the full 49152
// max_tokens ceiling (engine /metrics: one Running request, spec-decode
// acceptance pinned at the 8.0 maximum = literal repetition). The stream-proxy
// circuit breaker now catches LITERAL loops (it was blind to delta.reasoning
// — field-name mismatch, fixed same pass), but a SEMANTIC loop (re-phrasing
// without exact repetition) is only boundable by a token budget. When the
// ceiling is hit the provider ends the turn with finish_reason "length" +
// hadReasoning, so the runner's P2d reasoning-cutoff continuation directive
// lands ("stop deliberating, emit edits with tools now") and the agent
// CONTINUES instead of hogging the engine. Never suppresses thinking in
// prompts — bounds it mechanically and hands the turn back.
export const DEFAULT_MAX_REASONING_TOKENS = 32_768;
export const MAX_REASONING_TOKENS = (() => {
  const parsed = parseInt(process.env.QWEN_MAX_REASONING_TOKENS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_REASONING_TOKENS;
})();

export const EXTENSION_BONUS_TIMEOUT_MS = 600_000; // 10 min
// Invariant: retention must always outlive the longest legal task
// (DEFAULT_TIMEOUT_MS), or it can unlink a LIVE task's JSON mid-run.
export const TASK_RETENTION_MS = DEFAULT_TIMEOUT_MS + 1_800_000; // 4h + 30min

export const MAX_CONCURRENT_GOOSE = process.env.QWEN_MAX_CONCURRENT
  ? Math.max(1, parseInt(process.env.QWEN_MAX_CONCURRENT, 10))
  : 1;

export const SLOT_HEARTBEAT_MS = 15_000;
export const SLOT_WEDGED_MS = 300_000;
export const SLOT_POLL_MS = 1_000;

export const QWEN_STATE_DIR = process.env.QWEN_STATE_DIR || (() => {
  if (IS_WINDOWS) return path.join(os.homedir(), ".qwen");
  const winHomeWslPath = winHomeWsl();
  if (winHomeWslPath) {
    const winUserHomeQwen = path.join(winHomeWslPath, ".qwen");
    try {
      if (fs.existsSync(winUserHomeQwen)) return winUserHomeQwen;
    } catch {}
  }
  return path.join(os.homedir(), ".qwen");
})();

export const TASK_DIR = path.join(QWEN_STATE_DIR, "tasks");
export const SLOTS_DIR = path.join(TASK_DIR, "goose_slots");

// Wedge detection & Auto-Heal (Preserves GPU headroom against core deadlocks)
export const WEDGE_STATS_SILENCE_S = process.env.QWEN_WEDGE_SILENCE_S
  ? parseInt(process.env.QWEN_WEDGE_SILENCE_S, 10)
  : 120;
export const AUTO_HEAL = process.env.QWEN_AUTO_HEAL !== "0";
export const HEAL_LOCK_FILE = path.join(TASK_DIR, ".engine_heal.lock");
export const HEAL_LOCK_TTL_MS = 5 * 60_000;
export const ENGINE_BOOT_LOCK_FILE = path.join(TASK_DIR, ".engine_boot.lock");
export const ENGINE_BOOT_LOCK_TTL_MS = BOOT_TIMEOUT_MS;
export const ENGINE_LOG_PATH = process.env.QWEN_LOG_PATH || "/tmp/mcp_launch_huge.log";
export const WEDGE_COUNTER_FILE = path.join(TASK_DIR, ".wedge_counter.json");
export const PROXY_MAX_BODY_BYTES = 50 * 1024 * 1024; // 50MB

// Execution engine: the native Anser runner is hard-wired; there is no engine selection.

// Execution & Turn limits
export const MAX_TURNS = process.env.QWEN_MAX_TURNS
  ? parseInt(process.env.QWEN_MAX_TURNS, 10)
  : null; // null = unbounded, let orchestrator govern

// Continuation budget: max times we re-prompt the model after a
// finish_reason: "length" (token-ceiling) cutoff before giving up.
export const DEFAULT_MAX_CONTINUATION_TURNS = 8;
export const MAX_CONTINUATION_TURNS = (() => {
  const parsed = parseInt(process.env.QWEN_MAX_CONTINUATION_TURNS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_CONTINUATION_TURNS;
})();

// Empty-stream retry budget: max times we re-issue a turn when the engine
// returns an EMPTY generation (no content, no tool calls, and no real
// finish_reason — the signature of an aborted/zero-byte stream that the
// provider default-fills as "stop"). After this many empty turns we report
// the honest status "engine_empty_response" instead of a false "completed".
export const DEFAULT_EMPTY_STREAM_RETRIES = 2;
export const EMPTY_STREAM_RETRIES = (() => {
  const parsed = parseInt(process.env.QWEN_EMPTY_STREAM_RETRIES, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_EMPTY_STREAM_RETRIES;
})();

