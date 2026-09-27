import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { winHomeWsl } from "./wsl_env.js";
import { IS_WINDOWS } from "./env.js";

/**
 * Platform detection flag for Windows environments.
 * Re-exported from leaf env.js for backward compatibility.
 * @type {boolean}
 */
export { IS_WINDOWS };

/**
 * Port for the vLLM OpenAI-compatible server.
 * - Unit: port number
 * - Default: 18020
 * - Override: VLLM_PORT
 * @type {number}
 */
export const VLLM_PORT = parseInt(process.env.VLLM_PORT || "18020", 10);

/**
 * Port for the zero-turn status and long-poll wait HTTP server.
 * - Unit: port number
 * - Default: 18021
 * - Override: STATUS_PORT
 * @type {number}
 */
export const STATUS_PORT = parseInt(process.env.STATUS_PORT || "18021", 10);

/**
 * Port for the local SSE stream sanitizer proxy.
 * - Unit: port number
 * - Default: 18022
 * - Override: STREAM_PROXY_PORT
 * @type {number}
 */
export const STREAM_PROXY_PORT = parseInt(process.env.STREAM_PROXY_PORT || "18022", 10);

/**
 * Base URL for vLLM API completions.
 * @type {string}
 */
export const BASE_URL = `http://localhost:${VLLM_PORT}/v1`;

/**
 * Nominal maximum context length for the Qwen model architecture.
 * - Unit: tokens
 * - Value: 245760
 * @type {number}
 */
export const MAX_LEN_HUGE = 245760;
/**
 * Maximum time (ms) to wait for the vLLM engine to become ready after a cold boot.
 * Covers model load, torch.compile, profiling/warmup, and CUDA graph capture.
 * Default: 480000 ms (8 minutes).
 * @type {number}
 */
export const BOOT_TIMEOUT_MS = 480_000;
export const BOOT_POLL_MS = 3000;

/**
 * Default max_tokens for a single generation turn. Sized so that server-side
 * reasoning (thinking) tokens do not consume the entire budget before any
 * content or tool calls are emitted. The 245K context window easily fits
 * ~100k prompt + 49k output.
 *
 * - Unit: tokens
 * - Default: 49152
 * - Override: QWEN_MAX_TOKENS
 *
 * @type {number}
 */
const DEFAULT_MAX_TOKENS = 49152;
export const MAX_TOKENS = (() => {
  const parsed = parseInt(process.env.QWEN_MAX_TOKENS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_TOKENS;
})();

/**
 * Retrieves the current default reasoning effort for generation dispatches.
 * - Override: QWEN_REASONING_EFFORT
 * - Default: "medium"
 * @returns {"xhigh"|"medium"|"low"}
 */
export function getReasoningEffort() {
  const v = process.env.QWEN_REASONING_EFFORT;
  return v ? v : "medium";
}

/**
 * Supported reasoning-effort tiers accepted by the engine's chat template.
 * Canonical enum for tool schemas and dispatch validation.
 * @type {readonly string[]}
 */
export const REASONING_EFFORT_TIERS = ["xhigh", "medium", "low"];

/**
 * Synchronous race window before yielding to asynchronous zero-turn HTTP wait.
 * - Unit: milliseconds
 * - Default: 15000 (15 seconds)
 * - Override: QWEN_RACE_MS
 * @type {number}
 */
const DEFAULT_RACE_MS = 15_000;
export const RACE_MS = process.env.QWEN_RACE_MS
  ? parseInt(process.env.QWEN_RACE_MS, 10)
  : DEFAULT_RACE_MS;

/**
 * Default maximum execution timeout for an Anser background task.
 * - Unit: milliseconds
 * - Default: 14400000 (4 hours)
 * @type {number}
 */
export const DEFAULT_TIMEOUT_MS = 14_400_000;

/**
 * Enforced lower bound for task timeout configuration.
 * - Unit: milliseconds
 * - Default: 600000 (10 minutes)
 * - Override: QWEN_MIN_TIMEOUT_MS
 * @type {number}
 */
const DEFAULT_MIN_TIMEOUT_MS = 600_000;
export const MIN_TIMEOUT_MS = (() => {
  const parsed = parseInt(process.env.QWEN_MIN_TIMEOUT_MS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MIN_TIMEOUT_MS;
})();

/**
 * Inactivity watchdog timeout for stream stalls or unhandled process locks.
 * - Unit: milliseconds
 * - Default: 1800000 (30 minutes)
 * - Override: QWEN_INACTIVITY_TIMEOUT_MS
 * @type {number}
 */
export const INACTIVITY_TIMEOUT_MS = (() => {
  const parsed = parseInt(process.env.QWEN_INACTIVITY_TIMEOUT_MS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1_800_000;
})();

/**
 * Timeout allowed before the initial streaming token is emitted by the engine.
 * - Unit: milliseconds
 * - Default: 240000 (4 minutes)
 * - Override: QWEN_FIRST_TOKEN_TIMEOUT_MS
 * @type {number}
 */
export const FIRST_TOKEN_TIMEOUT_MS = (() => {
  const parsed = parseInt(process.env.QWEN_FIRST_TOKEN_TIMEOUT_MS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 240_000;
})();

/**
 * Streaming idle timeout (ms) for a single generation turn. Acts as both the
 * first-byte and inter-chunk idle watchdog on the provider's SSE read loop.
 * A legitimate first token can take many minutes on a cold 200K prefill
 * (prefix-cache miss) or behind a queued request on a MAX_SEQS=1 engine, so
 * the default is well above any realistic TTFT. This is a different axis from
 * max_tokens (generation-length cap); it only bounds how long the stream may
 * go silent before the connection is declared dead.
 *
 * - Unit: milliseconds
 * - Default: 1200000 ms (20 minutes)
 * - Override: QWEN_STREAM_IDLE_TIMEOUT_MS
 *
 * @type {number}
 */
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 1_200_000; // 20 min
export const STREAM_IDLE_TIMEOUT_MS = (() => {
  const parsed = parseInt(process.env.QWEN_STREAM_IDLE_TIMEOUT_MS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_STREAM_IDLE_TIMEOUT_MS;
})();

/**
 * Depth-aware streaming idle timeout (ms). Applied when the estimated prompt
 * token count exceeds {@link STREAM_IDLE_DEPTH_TOKENS}. A deep-context prompt
 * can legitimately spend >20 min in a single healthy thinking turn before any
 * content is emitted; this longer window prevents a healthy long-thinking turn
 * from being killed. The shallow tier ({@link STREAM_IDLE_TIMEOUT_MS}) still
 * bounds normal turns.
 *
 * - Unit: milliseconds
 * - Default: 2400000 ms (40 minutes)
 * - Override: QWEN_STREAM_IDLE_TIMEOUT_DEEP_MS
 *
 * @type {number}
 */
const DEFAULT_STREAM_IDLE_TIMEOUT_MS_DEEP = 2_400_000; // 40 min
export const STREAM_IDLE_TIMEOUT_MS_DEEP = (() => {
  const parsed = parseInt(process.env.QWEN_STREAM_IDLE_TIMEOUT_DEEP_MS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_STREAM_IDLE_TIMEOUT_MS_DEEP;
})();

/**
 * Prompt-token depth threshold. A turn whose estimated prompt tokens reach this
 * value is treated as "deep" and receives the DEEP idle timeout tier
 * ({@link STREAM_IDLE_TIMEOUT_MS_DEEP}) instead of the shallow tier.
 *
 * - Unit: tokens
 * - Default: 35000
 * - Override: QWEN_STREAM_IDLE_DEPTH_TOKENS
 *
 * @type {number}
 */
const DEFAULT_STREAM_IDLE_DEPTH_TOKENS = 35_000;
export const STREAM_IDLE_DEPTH_TOKENS = (() => {
  const parsed = parseInt(process.env.QWEN_STREAM_IDLE_DEPTH_TOKENS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_STREAM_IDLE_DEPTH_TOKENS;
})();

/**
 * Per-turn ceiling on reasoning (thinking) tokens, enforced client-side by the
 * provider's SSE read loop. The stream-proxy circuit breaker catches literal
 * repetition loops, but a semantic loop (re-phrasing without exact repetition)
 * is only boundable by a token budget. When the ceiling is hit the provider
 * ends the turn with finish_reason "length" + hadReasoning, so the runner's
 * reasoning-cutoff continuation directive lands and the agent continues
 * instead of hogging the engine. Never suppresses thinking in prompts — bounds
 * it mechanically and hands the turn back.
 *
 * - Unit: tokens
 * - Default: 32768
 * - Override: QWEN_MAX_REASONING_TOKENS
 *
 * @type {number}
 */
const DEFAULT_MAX_REASONING_TOKENS = 32_768;
export const MAX_REASONING_TOKENS = (() => {
  const parsed = parseInt(process.env.QWEN_MAX_REASONING_TOKENS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_REASONING_TOKENS;
})();

/**
 * Additional execution time granted per supervisor lease extension.
 * - Unit: milliseconds
 * - Default: 600000 (10 minutes)
 * @type {number}
 */
export const EXTENSION_BONUS_TIMEOUT_MS = 600_000;

/**
 * Minimum allowable task retention period (ms). Enforces that task JSON files
 * outlive the maximum legal execution timeout plus inactivity watchdog margin.
 * - Unit: milliseconds
 * - Default: 16200000 (4h 30m)
 * @type {number}
 */
export const TASK_RETENTION_FLOOR_MS = DEFAULT_TIMEOUT_MS + 1_800_000;

/**
 * Task artifact retention period on disk before automated pruning. Clamped to
 * {@link TASK_RETENTION_FLOOR_MS} to prevent premature deletion of active tasks.
 * - Unit: milliseconds
 * - Default: 604800000 (7 days)
 * - Override: QWEN_TASK_RETENTION_MS
 * @type {number}
 */
const DEFAULT_TASK_RETENTION_MS = 604_800_000;
export const TASK_RETENTION_MS = (() => {
  const parsed = parseInt(process.env.QWEN_TASK_RETENTION_MS, 10);
  const requested =
    Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TASK_RETENTION_MS;
  return Math.max(requested, TASK_RETENTION_FLOOR_MS);
})();

/**
 * Mid-session orphan-reaper heartbeat-staleness window (ms). The boot-only
 * orphan sweep runs only at process start, so a task whose owner process dies
 * mid-session (status "running", dead owner pid, no terminal event) would
 * otherwise stay "running" forever and mislead later probes. The liveness
 * reaper reaps a not-done task only when BOTH its heartbeat is older than this
 * window AND its owner pid is dead. The default protects against long
 * reasoning turns, web fetches, or heavy compiler runs.
 *
 * - Unit: milliseconds
 * - Default: 600000 ms (10 minutes)
 * - Override: QWEN_ORPHAN_REAP_STALE_MS
 *
 * @type {number}
 */
const DEFAULT_ORPHAN_REAP_STALE_MS = 600_000; // 10m
export const ORPHAN_REAP_STALE_MS = (() => {
  const parsed = parseInt(process.env.QWEN_ORPHAN_REAP_STALE_MS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ORPHAN_REAP_STALE_MS;
})();

/**
 * Maximum number of concurrent tasks the runner will execute in parallel.
 * Default is 1 (single-user pair programming); this eliminates multi-stream
 * prefill queueing and reclaims non-KV VRAM headroom. Keep in sync with
 * scripts/wsl/start_huge.sh.
 *
 * - Unit: count
 * - Default: 1
 * - Override: QWEN_MAX_CONCURRENT
 *
 * @type {number}
 */
export const MAX_CONCURRENT_TASKS = process.env.QWEN_MAX_CONCURRENT
  ? Math.max(1, parseInt(process.env.QWEN_MAX_CONCURRENT, 10))
  : 1;

/**
 * Heartbeat refresh interval for active task slot leases.
 * - Unit: milliseconds
 * - Default: 15000 (15 seconds)
 * @type {number}
 */
export const SLOT_HEARTBEAT_MS = 15_000;

/**
 * Inactivity duration before an unrefreshed slot lease is declared wedged.
 * - Unit: milliseconds
 * - Default: 300000 (5 minutes)
 * @type {number}
 */
export const SLOT_WEDGED_MS = 300_000;

/**
 * Polling cadence when waiting to acquire an exclusive slot lease.
 * - Unit: milliseconds
 * - Default: 1000 (1 second)
 * @type {number}
 */
export const SLOT_POLL_MS = 1_000;

/**
 * Identifies whether execution is occurring within an automated test suite.
 * @type {boolean}
 */
export const IS_TEST_ENV = Boolean(
  process.env.NODE_ENV === "test" ||
  process.env.TEST_OFFLINE === "1" ||
  (process.env.npm_lifecycle_event && process.env.npm_lifecycle_event.includes("test")) ||
  process.argv.some((arg) => typeof arg === "string" && (arg.endsWith(".test.js") || arg.includes(".test.") || arg === "--test"))
);

if (IS_TEST_ENV && process.env.NODE_ENV !== "test") {
  process.env.NODE_ENV = "test";
}

/**
 * Root directory for task state, slot leases, and session ledgers.
 * In test environments, allocates an isolated temporary scratchpad.
 * In production environments, resolves to ~/.qwen or WSL host equivalent.
 * - Override: QWEN_STATE_DIR
 * @type {string}
 */
export const QWEN_STATE_DIR = process.env.QWEN_STATE_DIR || (() => {
  if (IS_TEST_ENV) {
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "qwen_test_state_"));
    process.env.QWEN_STATE_DIR = testDir;
    return testDir;
  }
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
export const SLOTS_DIR = path.join(TASK_DIR, "slots");

// Global Configuration (~/.qwen/config.json and ~/.qwen/.env)
const GLOBAL_CONFIG_FILE = path.join(QWEN_STATE_DIR, "config.json");
const GLOBAL_ENV_FILE = path.join(QWEN_STATE_DIR, ".env");

/**
 * Loads the machine-wide global configuration from ~/.qwen/config.json or ~/.qwen/.env.
 * Single source of truth across all MCP host sessions (Claude Code, Antigravity, Cursor).
 *
 * @returns {{ search: { provider?: string, brave_api_key?: string, tavily_api_key?: string, context7_api_key?: string, searxng_url?: string } }}
 */
export function loadGlobalConfig() {
  const config = { search: {} };
  try {
    if (fs.existsSync(GLOBAL_CONFIG_FILE)) {
      const raw = fs.readFileSync(GLOBAL_CONFIG_FILE, "utf8").replace(/^\uFEFF/, "");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        if (parsed.search && typeof parsed.search === "object") {
          Object.assign(config.search, parsed.search);
        }
      }
    }
  } catch (err) {
    process.stderr.write(`[config] Corrupt ${GLOBAL_CONFIG_FILE}: ${err.message}; defaults apply.\n`);
  }

  try {
    if (fs.existsSync(GLOBAL_ENV_FILE)) {
      const raw = fs.readFileSync(GLOBAL_ENV_FILE, "utf8").replace(/^\uFEFF/, "");
      const lines = raw.split("\n");
      for (const line of lines) {
        const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*["']?([^"']+)["']?\s*(#.*)?$/);
        if (match) {
          const k = match[1];
          const v = match[2].trim();
          if (k === "BRAVE_API_KEY") config.search.brave_api_key = config.search.brave_api_key || v;
          else if (k === "TAVILY_API_KEY") config.search.tavily_api_key = config.search.tavily_api_key || v;
          else if (k === "CONTEXT7_API_KEY") config.search.context7_api_key = config.search.context7_api_key || v;
          else if (k === "SEARXNG_URL") config.search.searxng_url = config.search.searxng_url || v;
          else if (k === "SEARCH_PROVIDER") config.search.provider = config.search.provider || v;
        }
      }
    }
  } catch (err) {
    process.stderr.write(`[config] Corrupt ${GLOBAL_ENV_FILE}: ${err.message}; defaults apply.\n`);
  }

  return config;
}

/**
 * Applies global configuration credentials to process.env if not already present.
 */
export function applyGlobalConfigToEnv() {
  const cfg = loadGlobalConfig();
  if (cfg.search?.brave_api_key && !process.env.BRAVE_API_KEY) {
    process.env.BRAVE_API_KEY = cfg.search.brave_api_key;
  }
  if (cfg.search?.tavily_api_key && !process.env.TAVILY_API_KEY) {
    process.env.TAVILY_API_KEY = cfg.search.tavily_api_key;
  }
  if (cfg.search?.context7_api_key && !process.env.CONTEXT7_API_KEY) {
    process.env.CONTEXT7_API_KEY = cfg.search.context7_api_key;
  }
  if (cfg.search?.searxng_url && !process.env.SEARXNG_URL) {
    process.env.SEARXNG_URL = cfg.search.searxng_url;
  }
  if (cfg.search?.provider && !process.env.SEARCH_PROVIDER) {
    process.env.SEARCH_PROVIDER = cfg.search.provider;
  }
}
applyGlobalConfigToEnv();

export function getSearchConfig() {
  const cfg = loadGlobalConfig();
  return {
    provider: process.env.SEARCH_PROVIDER || cfg.search?.provider || "auto",
    brave_api_key: process.env.BRAVE_API_KEY || cfg.search?.brave_api_key || "",
    tavily_api_key: process.env.TAVILY_API_KEY || cfg.search?.tavily_api_key || "",
    context7_api_key: process.env.CONTEXT7_API_KEY || cfg.search?.context7_api_key || "",
    searxng_url: process.env.SEARXNG_URL || cfg.search?.searxng_url || "",
  };
}

const _initSearchConfig = getSearchConfig();
const SEARCH_PROVIDER = _initSearchConfig.provider;
export const BRAVE_API_KEY = _initSearchConfig.brave_api_key;
export const TAVILY_API_KEY = _initSearchConfig.tavily_api_key;
const CONTEXT7_API_KEY = _initSearchConfig.context7_api_key;
const SEARXNG_URL = _initSearchConfig.searxng_url;


/**
 * Inactivity threshold for engine telemetry before declaring an engine wedge.
 * - Unit: seconds
 * - Default: 120
 * - Override: QWEN_WEDGE_SILENCE_S
 * @type {number}
 */
export const WEDGE_STATS_SILENCE_S = process.env.QWEN_WEDGE_SILENCE_S
  ? parseInt(process.env.QWEN_WEDGE_SILENCE_S, 10)
  : 120;

/**
 * Flag enabling automated restart and recovery of a wedged inference engine.
 * - Default: true
 * - Override: QWEN_AUTO_HEAL ("0" disables)
 * @type {boolean}
 */
export const AUTO_HEAL = process.env.QWEN_AUTO_HEAL !== "0";

/**
 * Lockfile path for engine auto-heal serialization.
 * @type {string}
 */
export const HEAL_LOCK_FILE = path.join(TASK_DIR, ".engine_heal.lock");

/**
 * Time-to-live for engine heal lock acquisition.
 * - Unit: milliseconds
 * - Default: 300000 (5 minutes)
 * @type {number}
 */
export const HEAL_LOCK_TTL_MS = 5 * 60_000;

/**
 * Lockfile path for exclusive engine boot coordination across processes.
 * @type {string}
 */
export const ENGINE_BOOT_LOCK_FILE = path.join(TASK_DIR, ".engine_boot.lock");

/**
 * Time-to-live for engine boot lock acquisition.
 * - Unit: milliseconds
 * - Default: 480000 (8 minutes)
 * @type {number}
 */
export const ENGINE_BOOT_LOCK_TTL_MS = BOOT_TIMEOUT_MS;

/**
 * Destination path for background engine startup logs.
 * - Default: "/tmp/mcp_launch_huge.log"
 * - Override: QWEN_LOG_PATH
 * @type {string}
 */
export const ENGINE_LOG_PATH = process.env.QWEN_LOG_PATH || "/tmp/mcp_launch_huge.log";

/**
 * Counter ledger tracking cumulative engine wedge and restart events.
 * @type {string}
 */
export const WEDGE_COUNTER_FILE = path.join(TASK_DIR, ".wedge_counter.json");

/**
 * Maximum allowable payload size accepted by the stream proxy.
 * - Unit: bytes
 * - Value: 52428800 (50 MB)
 * @type {number}
 */
export const PROXY_MAX_BODY_BYTES = 50 * 1024 * 1024;

/**
 * Guard flag permitting tests or management commands to interrupt, probe, or reboot
 * the live vLLM inference engine. Disabled by default to protect running workloads.
 * - Default: false
 * - Override: ALLOW_ENGINE_INTERRUPT ("1" enables)
 * @type {boolean}
 */
export const ALLOW_ENGINE_INTERRUPT = process.env.ALLOW_ENGINE_INTERRUPT === "1";

/**
 * Base turn ceiling before requiring supervisor lease extension or cooperative landing.
 * - Unit: count
 * - Default: 80
 * - Override: QWEN_BASE_TURN_BUDGET
 * @type {number}
 */
const DEFAULT_BASE_TURN_BUDGET = 80;
export const BASE_TURN_BUDGET = (() => {
  const parsed = parseInt(process.env.QWEN_BASE_TURN_BUDGET, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_BASE_TURN_BUDGET;
})();

/**
 * Maximum elastic turn ceiling reachable through supervisor lease extensions.
 * - Unit: count
 * - Default: 200
 * - Override: QWEN_MAX_ELASTIC_TURNS
 * @type {number}
 */
const DEFAULT_MAX_ELASTIC_TURNS = 200;
export const MAX_ELASTIC_TURNS = (() => {
  const parsed = parseInt(process.env.QWEN_MAX_ELASTIC_TURNS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_ELASTIC_TURNS;
})();

/**
 * Maximum allowable GPU KV cache utilization percentage before disallowing lease extension.
 * - Unit: percentage (0-100)
 * - Default: 85.0
 * - Override: QWEN_KV_CACHE_HEADROOM_CEILING
 * @type {number}
 */
const DEFAULT_KV_CACHE_HEADROOM_CEILING = 85.0;
export const KV_CACHE_HEADROOM_CEILING = (() => {
  const parsed = parseFloat(process.env.QWEN_KV_CACHE_HEADROOM_CEILING);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_KV_CACHE_HEADROOM_CEILING;
})();

/**
 * Minimum average speculative decoding acceptance length required for lease extension.
 * - Unit: tokens per draft step
 * - Default: 2.5
 * - Override: QWEN_SPEC_ACCEPTANCE_FLOOR
 * @type {number}
 */
const DEFAULT_SPEC_ACCEPTANCE_FLOOR = 2.5;
export const SPEC_ACCEPTANCE_FLOOR = (() => {
  const parsed = parseFloat(process.env.QWEN_SPEC_ACCEPTANCE_FLOOR);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SPEC_ACCEPTANCE_FLOOR;
})();

/**
 * Sliding window size for action-hash stagnation and loop detection.
 * - Unit: count
 * - Default: 6
 * - Override: QWEN_LOOP_DETECTION_WINDOW
 * @type {number}
 */
export const DEFAULT_LOOP_DETECTION_WINDOW = 6;
export const LOOP_DETECTION_WINDOW = (() => {
  const parsed = parseInt(process.env.QWEN_LOOP_DETECTION_WINDOW, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_LOOP_DETECTION_WINDOW;
})();

/**
 * Threshold of repeated identical non-mutating actions within the detection window
 * required to trigger loop detection circuit-breaking.
 * - Unit: count
 * - Default: 3
 * - Override: QWEN_LOOP_DETECTION_REPETITIONS
 * @type {number}
 */
export const DEFAULT_LOOP_DETECTION_REPETITIONS = 3;
export const LOOP_DETECTION_REPETITIONS = (() => {
  const parsed = parseInt(process.env.QWEN_LOOP_DETECTION_REPETITIONS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_LOOP_DETECTION_REPETITIONS;
})();

/**
 * Character length of recent activity summaries returned in status and wait telemetry endpoints.
 * - Unit: characters
 * - Default: 300
 * - Override: QWEN_SUPERVISOR_PREVIEW_CHARS
 * @type {number}
 */
const DEFAULT_SUPERVISOR_PREVIEW_CHARS = 300;
export const SUPERVISOR_PREVIEW_CHARS = (() => {
  const parsed = parseInt(process.env.QWEN_SUPERVISOR_PREVIEW_CHARS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SUPERVISOR_PREVIEW_CHARS;
})();

/**
 * Optional hard upper bound on session turn count; null allows unbounded orchestrator steering.
 * - Unit: count
 * - Default: null
 * - Override: QWEN_MAX_TURNS
 * @type {number|null}
 */
export const MAX_TURNS = process.env.QWEN_MAX_TURNS
  ? parseInt(process.env.QWEN_MAX_TURNS, 10)
  : null;

/**
 * Maximum re-prompt attempts following a token-ceiling (finish_reason: "length") cutoff.
 * - Unit: count
 * - Default: 8
 * - Override: QWEN_MAX_CONTINUATION_TURNS
 * @type {number}
 */
const DEFAULT_MAX_CONTINUATION_TURNS = 8;
export const MAX_CONTINUATION_TURNS = (() => {
  const parsed = parseInt(process.env.QWEN_MAX_CONTINUATION_TURNS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_CONTINUATION_TURNS;
})();

/**
 * Maximum retry attempts when the inference engine returns an empty generation stream.
 * - Unit: count
 * - Default: 2
 * - Override: QWEN_EMPTY_STREAM_RETRIES
 * @type {number}
 */
const DEFAULT_EMPTY_STREAM_RETRIES = 2;
export const EMPTY_STREAM_RETRIES = (() => {
  const parsed = parseInt(process.env.QWEN_EMPTY_STREAM_RETRIES, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_EMPTY_STREAM_RETRIES;
})();

/**
 * Depth-aware empty-stream retry budget. The flat {@link EMPTY_STREAM_RETRIES}
 * (default 2) is correct for normal turns, but a deep-context prompt
 * (estimated prompt chars >= {@link EMPTY_STREAM_RETRY_DEPTH_CHARS}) has a much
 * longer recovery latency on retry: re-prefilling 100k+ tokens takes minutes,
 * so a transient empty-stream cluster can exhaust the flat budget before it
 * clears. When the prompt is deep, the runner arms this longer DEEP budget
 * instead so a transient cluster has room to clear; the base budget still
 * bounds normal (shallow) turns.
 *
 * - Unit: count
 * - Default: 4
 * - Override: QWEN_EMPTY_STREAM_RETRIES_DEEP
 *
 * @type {number}
 */
const DEFAULT_EMPTY_STREAM_RETRIES_DEEP = 4;
export const EMPTY_STREAM_RETRIES_DEEP = (() => {
  const parsed = parseInt(process.env.QWEN_EMPTY_STREAM_RETRIES_DEEP, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_EMPTY_STREAM_RETRIES_DEEP;
})();

/**
 * Prompt-character depth threshold for the empty-stream retry budget. A turn
 * whose re-prefill size (JSON.stringify(messages).length, the same measure the
 * runner already records as deathContext.promptChars) reaches this value is
 * treated as "deep" and receives the DEEP retry budget
 * ({@link EMPTY_STREAM_RETRIES_DEEP}).
 *
 * - Unit: characters
 * - Default: 525000 (~150k tokens at ~3.5 chars/token)
 * - Override: QWEN_EMPTY_STREAM_RETRY_DEPTH_CHARS
 *
 * @type {number}
 */
const DEFAULT_EMPTY_STREAM_RETRY_DEPTH_CHARS = 525_000;
export const EMPTY_STREAM_RETRY_DEPTH_CHARS = (() => {
  const parsed = parseInt(process.env.QWEN_EMPTY_STREAM_RETRY_DEPTH_CHARS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_EMPTY_STREAM_RETRY_DEPTH_CHARS;
})();

/**
 * Base delay (ms) for exponential backoff between empty-stream retries. Before
 * each retry the runner sleeps base * 2^(retryNumber-1) ms, capped at
 * {@link EMPTY_STREAM_RETRY_BACKOFF_CAP_MS}. With the defaults (base 2000ms,
 * cap 30000ms) this is "2^retryNumber seconds capped at 30s": retry 1 waits
 * 2s, retry 2 waits 4s, retry 3 waits 8s, retry 4 waits 16s, retry 5+ waits
 * 30s (capped). The backoff gives a transient empty-stream cluster time to
 * clear before the next (expensive, deep) re-prefill.
 *
 * - Unit: milliseconds
 * - Default: 2000
 * - Override: QWEN_EMPTY_STREAM_RETRY_BACKOFF_BASE_MS
 *
 * @type {number}
 */
const DEFAULT_EMPTY_STREAM_RETRY_BACKOFF_BASE_MS = 2000;
export const EMPTY_STREAM_RETRY_BACKOFF_BASE_MS = (() => {
  const parsed = parseInt(process.env.QWEN_EMPTY_STREAM_RETRY_BACKOFF_BASE_MS, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_EMPTY_STREAM_RETRY_BACKOFF_BASE_MS;
})();

const DEFAULT_EMPTY_STREAM_RETRY_BACKOFF_CAP_MS = 30_000;
export const EMPTY_STREAM_RETRY_BACKOFF_CAP_MS = (() => {
  const parsed = parseInt(process.env.QWEN_EMPTY_STREAM_RETRY_BACKOFF_CAP_MS, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_EMPTY_STREAM_RETRY_BACKOFF_CAP_MS;
})();

/**
 * Dispatch prompt-budget telemetry threshold (chars). When the final task
 * prompt (the `prompt` that arrives as run({prompt})) exceeds this budget, the
 * runner emits one advisory `prompt_over_budget` event (fields: promptChars,
 * budget) at the start of run(). This is advisory telemetry only — it never
 * alters flow, never cancels or errors the session, and never truncates the
 * prompt. It exists so the over-budget failure cluster is observable in the
 * session event ledger (the same sink that carries session_warning /
 * context_depth_warning / probe_budget_warning).
 *
 * - Unit: characters
 * - Default: 1500
 * - Override: QWEN_PROMPT_BUDGET_CHARS
 *
 * @type {number}
 */
export const DEFAULT_PROMPT_BUDGET_CHARS = 1500;
export const PROMPT_BUDGET_CHARS = (() => {
  const parsed = parseInt(process.env.QWEN_PROMPT_BUDGET_CHARS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PROMPT_BUDGET_CHARS;
})();

/**
 * Degenerate-final guard threshold (chars). When the stream proxy
 * circuit-breaks a runaway repetition loop it appends a GUARD_MARKER sentinel
 * and ends the stream with finish_reason "stop". The provider accumulates that
 * marker into the turn's content, so a turn whose entire message is just the
 * marker (or a tiny sliver of text plus the marker) lands in the runner as a
 * "stop" turn with content.
 *
 * The runner strips the marker and measures the substantive remainder:
 *   - remainder < this threshold AND no tool calls this turn AND the session
 *     is still short (turnsTaken <= DEGENERATE_FINAL_MAX_TURNS)
 *       -> DEGENERATE: retry via the empty-stream path (reason
 *          "degenerate_final"); on budget exhaustion report the honest status
 *          "degenerate_response_truncated" (isError) with the original
 *          partial+marker preserved for honesty.
 *   - remainder >= this threshold -> keep "completed" (the marker stays
 *     visible in the result; the deliverable is real).
 *
 * The default (200) is well below any legitimate final answer but far above
 * the marker's own length (~110 chars), so a marker-only or near-marker final
 * is always caught while a real (even short) answer is never misclassified.
 *
 * - Unit: characters
 * - Default: 200
 * - Override: QWEN_DEGENERATE_FINAL_SUBSTANTIVE_CHARS
 *
 * @type {number}
 */
const DEFAULT_DEGENERATE_FINAL_SUBSTANTIVE_CHARS = 200;
export const DEGENERATE_FINAL_SUBSTANTIVE_CHARS = (() => {
  const parsed = parseInt(process.env.QWEN_DEGENERATE_FINAL_SUBSTANTIVE_CHARS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DEGENERATE_FINAL_SUBSTANTIVE_CHARS;
})();

/**
 * Maximum turn count for a session to be considered "short" by the
 * degenerate-final guard. A degenerate final is only classified as such if
 * the session has not already run many turns. A long session that ends with a
 * marker-truncated final has clearly done real work (many tool calls / turns)
 * and is NOT degenerate — it is a normal (if truncated) completion. The
 * default (3) keeps the guard scoped to the early-dead-session signature.
 *
 * - Unit: count
 * - Default: 3
 * - Override: QWEN_DEGENERATE_FINAL_MAX_TURNS
 *
 * @type {number}
 */
const DEFAULT_DEGENERATE_FINAL_MAX_TURNS = 3;
export const DEGENERATE_FINAL_MAX_TURNS = (() => {
  const parsed = parseInt(process.env.QWEN_DEGENERATE_FINAL_MAX_TURNS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DEGENERATE_FINAL_MAX_TURNS;
})();

/**
 * Probe-budget watchdog threshold (count). The runner counts consecutive
 * non-mutating bash calls (bash/exec_command with no file-mutating tool call
 * in between); when the count exceeds this budget it injects an advisory (not
 * an error, not a cancellation) reminding the model that mutation dispatches
 * are single-pass, and re-arms the counter for the next run of N. The default
 * (4) means the warning fires on the 5th consecutive non-mutating bash call.
 *
 * - Unit: count
 * - Default: 4
 * - Override: QWEN_PROBE_BUDGET
 *
 * @type {number}
 */
const DEFAULT_PROBE_BUDGET = 4;
export const PROBE_BUDGET = (() => {
  const parsed = parseInt(process.env.QWEN_PROBE_BUDGET, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PROBE_BUDGET;
})();

/**
 * Session-cumulative turn warning threshold (count). The session's total turn
 * count spans tasks: the prior assistant_message events (from
 * logger.readAll(), the same source getConversationHistory() reads) plus this
 * run's turnsTaken. The runner's run loop checks the cumulative count each
 * turn. At this threshold it emits a one-shot `session_warning` event.
 *
 * - Unit: count
 * - Default: 60
 * - Override: QWEN_SESSION_WARN_TURNS
 *
 * @type {number}
 */
const DEFAULT_SESSION_TURNS_WARN = 60;
export const SESSION_TURNS_WARN = (() => {
  const parsed = parseInt(process.env.QWEN_SESSION_WARN_TURNS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SESSION_TURNS_WARN;
})();

/**
 * Session-cumulative turn recommendation threshold (count). At this threshold
 * the runner emits a one-shot `session_turn_limit_recommended` event AND pushes
 * a single in-band user-role advisory telling the model to complete the task
 * and roll to a fresh session next dispatch. Advisory only — never cancels or
 * errors the session; the hard MAX_TURNS cap (anser_runner) is untouched.
 *
 * - Unit: count
 * - Default: 80
 * - Override: QWEN_SESSION_RECOMMEND_TURNS
 *
 * @type {number}
 */
const DEFAULT_SESSION_TURNS_RECOMMEND = 80;
export const SESSION_TURNS_RECOMMEND = (() => {
  const parsed = parseInt(process.env.QWEN_SESSION_RECOMMEND_TURNS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SESSION_TURNS_RECOMMEND;
})();

/**
 * Context-depth warning threshold (tokens). When a turn's promptTokens (the
 * re-prefill size) reaches this value the runner emits a one-shot
 * `context_depth_warning` event. If the probe-streak counter is active at that
 * moment the event gains `probeStreakActive: true` — a signal for the
 * anti-rabbit-hole system (a deep context AND a live probe streak means the
 * model is stuck in a long, deep, non-mutating loop).
 *
 * - Unit: tokens
 * - Default: 65536
 * - Override: QWEN_CONTEXT_WARN_TOKENS
 *
 * @type {number}
 */
const DEFAULT_CONTEXT_WARN_TOKENS = 65536;
export const CONTEXT_WARN_TOKENS = (() => {
  const parsed = parseInt(process.env.QWEN_CONTEXT_WARN_TOKENS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CONTEXT_WARN_TOKENS;
})();

/**
 * High-watermark context threshold for proactive session rollover recommendations.
 * Emits an advisory recommendation when prompt tokens exceed this threshold.
 * - Unit: tokens
 * - Default: 180000
 * - Override: QWEN_CONTEXT_HIGH_WATERMARK_TOKENS
 * @type {number}
 */
const DEFAULT_CONTEXT_HIGH_WATERMARK_TOKENS = 180_000;
export const CONTEXT_HIGH_WATERMARK_TOKENS = (() => {
  const parsed = parseInt(process.env.QWEN_CONTEXT_HIGH_WATERMARK_TOKENS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CONTEXT_HIGH_WATERMARK_TOKENS;
})();

/**
 * Hard emergency ceiling for context tokens before halting further accumulation.
 * - Unit: tokens
 * - Default: 215000
 * - Override: QWEN_CONTEXT_EMERGENCY_CEILING_TOKENS
 * @type {number}
 */
const DEFAULT_CONTEXT_EMERGENCY_CEILING_TOKENS = 215_000;
export const CONTEXT_EMERGENCY_CEILING_TOKENS = (() => {
  const parsed = parseInt(process.env.QWEN_CONTEXT_EMERGENCY_CEILING_TOKENS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CONTEXT_EMERGENCY_CEILING_TOKENS;
})();

/**
 * Adaptive read-size governor cap (bytes). When the context high-watermark
 * fires, the runner arms this governor on the session's sandboxed FS service.
 * Subsequent read_file calls are then capped at this size (16KB, down from the
 * 64KB default) instead of pulling a whole file into an already-pressured
 * context. The governor only LOWERS the cap — it never raises it above the
 * caller's max_bytes. A read that exceeds the governed cap is truncated to the
 * cap and a suffix-scoped notice is appended (KV-prefix-stable: the notice is
 * part of the tool *result*, never the prompt prefix).
 *
 * - Unit: bytes
 * - Default: 16384 (16 KB)
 * - Override: QWEN_READ_GOVERNOR_MAX_BYTES
 *
 * @type {number}
 */
const DEFAULT_READ_GOVERNOR_MAX_BYTES = 16 * 1024;
export const READ_GOVERNOR_MAX_BYTES = (() => {
  const parsed = parseInt(process.env.QWEN_READ_GOVERNOR_MAX_BYTES, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_READ_GOVERNOR_MAX_BYTES;
})();

/**
 * Tool-output spillover threshold (bytes). When a tool result exceeds this
 * size, the full payload is written to <workspace>/.scratch/tool_out_<id>.txt
 * and the in-band observation is replaced with a pointer block (head + tail
 * preview + re-read hint) instead of being hard-truncated. This prevents a
 * single large read/bash result from either blowing the context ceiling or
 * amputating the payload past a hard cut.
 *
 * - Unit: bytes
 * - Default: 8192
 * - Override: QWEN_TOOL_SPILL_BYTES
 *
 * @type {number}
 */
const DEFAULT_TOOL_SPILL_BYTES = 8192;
export const TOOL_SPILL_BYTES = (() => {
  const parsed = parseInt(process.env.QWEN_TOOL_SPILL_BYTES, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TOOL_SPILL_BYTES;
})();

/**
 * Bounded salvage extraction max_tokens (tokens). When the reasoning budget is
 * exhausted, the runner fires one bounded extraction turn (tools disabled, low
 * reasoning effort) to salvage the model's accumulated partial findings. This
 * short max_tokens bounds the extraction so it cannot re-trigger the
 * deliberation loop.
 *
 * - Unit: tokens
 * - Default: 4096
 * - Override: QWEN_SALVAGE_MAX_TOKENS
 *
 * @type {number}
 */
const DEFAULT_SALVAGE_MAX_TOKENS = 4096;
export const SALVAGE_MAX_TOKENS = (() => {
  const parsed = parseInt(process.env.QWEN_SALVAGE_MAX_TOKENS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SALVAGE_MAX_TOKENS;
})();



