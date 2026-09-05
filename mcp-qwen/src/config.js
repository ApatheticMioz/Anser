import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const IS_WINDOWS = process.platform === "win32";

export const VLLM_PORT = parseInt(process.env.VLLM_PORT || "18020", 10);
export const STATUS_PORT = parseInt(process.env.STATUS_PORT || "18021", 10);
export const STREAM_PROXY_PORT = parseInt(process.env.STREAM_PROXY_PORT || "18022", 10);

export const BASE_URL = `http://localhost:${VLLM_PORT}/v1`;
export const MAX_LEN_HUGE = 245760;
export const BOOT_TIMEOUT_MS = 180_000;
export const BOOT_POLL_MS = 3000;

export const DEFAULT_RACE_MS = 45_000;
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

export const EXTENSION_BONUS_TIMEOUT_MS = 600_000; // 10 min
export const TASK_RETENTION_MS = 10_800_000; // 3 hours

export const MAX_CONCURRENT_GOOSE = process.env.QWEN_MAX_CONCURRENT
  ? Math.max(1, parseInt(process.env.QWEN_MAX_CONCURRENT, 10))
  : 1;

export const SLOT_HEARTBEAT_MS = 15_000;
export const SLOT_STALE_MS = 90_000;
export const SLOT_WEDGED_MS = 300_000;
export const SLOT_POLL_MS = 1_000;

export const QWEN_STATE_DIR = process.env.QWEN_STATE_DIR || (() => {
  if (IS_WINDOWS) return path.join(os.homedir(), ".qwen");
  const winUserHomeQwen = "/mnt/c/Users/Apath/.qwen";
  try {
    if (fs.existsSync(winUserHomeQwen)) return winUserHomeQwen;
  } catch {}
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
export const ENGINE_LOG_PATH = process.env.QWEN_ENGINE_LOG || "/tmp/mcp_launch_huge.log";
export const WEDGE_COUNTER_FILE = path.join(TASK_DIR, ".wedge_counter.json");

// Execution Engine: 'deepseek_avo' (Cordis microkernel + NVIDIA AVO) or 'legacy_goose' (CLI wrapper)
export const QWEN_ENGINE = process.env.QWEN_ENGINE || "deepseek_avo";

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

