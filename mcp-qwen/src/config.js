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
 * - Override: STREAM_PROXY_PORT (preferred) or VLLM_PROXY_PORT (legacy)
 * - Config-file override: `stream_proxy_port` in ~/.anser/config.json
 *   (resolved in STREAM_PROXY_PORT_RESOLVED at the bottom of this file)
 * @type {number}
 */
export const STREAM_PROXY_PORT = parseInt(
  process.env.STREAM_PROXY_PORT || process.env.VLLM_PROXY_PORT || "18022",
  10
);

/**
 * Whether to use the stream proxy.
 * - Default: true
 * - Override: USE_STREAM_PROXY ("false" or "0" disables)
 * - Config-file override: `use_stream_proxy` in ~/.anser/config.json
 *   (resolved in USE_STREAM_PROXY_RESOLVED at the bottom of this file)
 * @type {boolean}
 */
export const USE_STREAM_PROXY =
  process.env.USE_STREAM_PROXY !== "false" && process.env.USE_STREAM_PROXY !== "0";

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
 * Maximum duration to wait for the vLLM engine to become healthy after boot.
 * - Unit: milliseconds
 * - Default: 480000 (8 minutes)
 * @type {number}
 */
export const BOOT_TIMEOUT_MS = 480_000;

/**
 * Polling cadence when checking vLLM health during startup.
 * - Unit: milliseconds
 * - Default: 3000 (3 seconds)
 * @type {number}
 */
export const BOOT_POLL_MS = 3000;

/**
 * Maximum completion tokens allowed for a single generation turn.
 * - Unit: tokens
 * - Default: 49152
 * - Override: QWEN_MAX_TOKENS
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
 * Maximum allowed idle duration between consecutive stream chunks before aborting.
 * - Unit: milliseconds
 * - Default: 1200000 (20 minutes)
 * - Override: QWEN_STREAM_IDLE_TIMEOUT_MS
 * @type {number}
 */
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 1_200_000; // 20 min
export const STREAM_IDLE_TIMEOUT_MS = (() => {
  const parsed = parseInt(process.env.QWEN_STREAM_IDLE_TIMEOUT_MS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_STREAM_IDLE_TIMEOUT_MS;
})();

/**
 * Streaming idle timeout applied when prompt tokens exceed STREAM_IDLE_DEPTH_TOKENS.
 * - Unit: milliseconds
 * - Default: 2400000 (40 minutes)
 * - Override: QWEN_STREAM_IDLE_TIMEOUT_DEEP_MS
 * @type {number}
 */
const DEFAULT_STREAM_IDLE_TIMEOUT_MS_DEEP = 2_400_000; // 40 min
export const STREAM_IDLE_TIMEOUT_MS_DEEP = (() => {
  const parsed = parseInt(process.env.QWEN_STREAM_IDLE_TIMEOUT_DEEP_MS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_STREAM_IDLE_TIMEOUT_MS_DEEP;
})();

/**
 * Prompt token depth threshold that activates STREAM_IDLE_TIMEOUT_MS_DEEP.
 * - Unit: tokens
 * - Default: 35000
 * - Override: QWEN_STREAM_IDLE_DEPTH_TOKENS
 * @type {number}
 */
const DEFAULT_STREAM_IDLE_DEPTH_TOKENS = 35_000;
export const STREAM_IDLE_DEPTH_TOKENS = (() => {
  const parsed = parseInt(process.env.QWEN_STREAM_IDLE_DEPTH_TOKENS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_STREAM_IDLE_DEPTH_TOKENS;
})();

/**
 * Maximum reasoning tokens allowed per generation turn before terminating thinking.
 * - Unit: tokens
 * - Default: 32768
 * - Override: QWEN_MAX_REASONING_TOKENS
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
 * Heartbeat staleness threshold for reaping orphaned tasks whose owner process is dead.
 * - Unit: milliseconds
 * - Default: 30000 (30 seconds)
 * - Override: QWEN_ORPHAN_REAP_STALE_MS
 * @type {number}
 */
const DEFAULT_ORPHAN_REAP_STALE_MS = 30_000;
export const ORPHAN_REAP_STALE_MS = (() => {
  const parsed = parseInt(process.env.QWEN_ORPHAN_REAP_STALE_MS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ORPHAN_REAP_STALE_MS;
})();

/**
 * Maximum number of concurrent tasks executed in parallel.
 * - Unit: count
 * - Default: 1
 * - Override: QWEN_MAX_CONCURRENT
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
 * One-time migration from the legacy ~/.qwen state directory to ~/.anser.
 * If the legacy directory exists and the new one does not, it is renamed
 * (or copied as a fallback) so existing task state, config.json, and
 * session ledgers carry over. Never throws; failures are logged to stderr.
 *
 * @param {string} legacyDir - legacy state dir (e.g. ~/.qwen)
 * @param {string} newDir - new state dir (e.g. ~/.anser)
 */
function migrateStateDir(legacyDir, newDir) {
  try {
    if (!fs.existsSync(legacyDir) || fs.existsSync(newDir)) return;
    try {
      fs.renameSync(legacyDir, newDir);
    } catch {
      // Cross-device or permission failure: fall back to a recursive copy.
      fs.cpSync(legacyDir, newDir, { recursive: true });
    }
    process.stderr.write(
      `[config] Migrated state directory ${legacyDir} -> ${newDir}\n`
    );
  } catch (err) {
    process.stderr.write(
      `[config] State dir migration failed (${err.message}); using ${newDir}\n`
    );
  }
}

/**
 * Root directory for task state, slot leases, and session ledgers.
 * In test environments, allocates an isolated temporary scratchpad.
 * In production environments, resolves to ~/.anser (or WSL host equivalent),
 * with a one-time migration from the legacy ~/.qwen directory.
 * - Override: QWEN_STATE_DIR
 * @type {string}
 */
export const QWEN_STATE_DIR = process.env.QWEN_STATE_DIR || (() => {
  if (IS_TEST_ENV) {
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "qwen_test_state_"));
    process.env.QWEN_STATE_DIR = testDir;
    return testDir;
  }
  if (IS_WINDOWS) {
    const newDir = path.join(os.homedir(), ".anser");
    migrateStateDir(path.join(os.homedir(), ".qwen"), newDir);
    return newDir;
  }
  const winHomeWslPath = winHomeWsl();
  if (winHomeWslPath) {
    const winUserHomeAnser = path.join(winHomeWslPath, ".anser");
    migrateStateDir(path.join(winHomeWslPath, ".qwen"), winUserHomeAnser);
    try {
      if (fs.existsSync(winUserHomeAnser)) return winUserHomeAnser;
    } catch {}
  }
  const newDir = path.join(os.homedir(), ".anser");
  migrateStateDir(path.join(os.homedir(), ".qwen"), newDir);
  return newDir;
})();

export const TASK_DIR = path.join(QWEN_STATE_DIR, "tasks");
export const SLOTS_DIR = path.join(TASK_DIR, "slots");

// Global Configuration (~/.anser/config.json and ~/.anser/.env)
const GLOBAL_CONFIG_FILE = path.join(QWEN_STATE_DIR, "config.json");
const GLOBAL_ENV_FILE = path.join(QWEN_STATE_DIR, ".env");

/**
 * Loads the machine-wide global configuration from ~/.anser/config.json or
 * ~/.anser/.env. Single source of truth across all MCP host sessions
 * (Claude Code, Antigravity, Cursor).
 *
 * Recognized top-level keys:
 *   - model: model name served by the engine (env: QWEN_MODEL)
 *   - baseURL: OpenAI-compatible endpoint (env: QWEN_BASE_URL)
 *   - max_context: nominal context window in tokens (env: QWEN_MAX_CONTEXT)
 *   - launch_command: shell command used to (re)start the engine (env: QWEN_LAUNCH_COMMAND)
 *   - tool_prefix: prefix applied to registered MCP tool names (env: MCP_TOOL_PREFIX)
 *   - api_key: engine API key (env: QWEN_API_KEY / OPENAI_API_KEY)
 *   - engine_type: engine type tag (env: QWEN_ENGINE_TYPE)
 *   - stop_command: shell command used to stop the engine (env: QWEN_STOP_COMMAND)
 *   - engine_log_path: path to the engine log (env: QWEN_LOG_PATH)
 *   - use_stream_proxy: enable/disable the stream proxy (env: USE_STREAM_PROXY)
 *   - stream_proxy_port: stream proxy port (env: STREAM_PROXY_PORT / VLLM_PROXY_PORT)
 *   - status_port: status server port (env: STATUS_PORT)
 *   - vllm_port: vLLM engine port (env: VLLM_PORT)
 *   - search: { provider, brave_api_key, tavily_api_key, context7_api_key, searxng_url }
 *
 * @returns {{
 *   model?: string,
 *   baseURL?: string,
 *   max_context?: number,
 *   launch_command?: string,
 *   tool_prefix?: string,
 *   api_key?: string,
 *   engine_type?: string,
 *   stop_command?: string,
 *   engine_log_path?: string,
 *   use_stream_proxy?: boolean,
 *   stream_proxy_port?: number,
 *   status_port?: number,
 *   vllm_port?: number,
 *   search: { provider?: string, brave_api_key?: string, tavily_api_key?: string, context7_api_key?: string, searxng_url?: string }
 * }}
 */
export function loadGlobalConfig() {
  const config = { search: {} };
  try {
    if (fs.existsSync(GLOBAL_CONFIG_FILE)) {
      const raw = fs.readFileSync(GLOBAL_CONFIG_FILE, "utf8").replace(/^\uFEFF/, "");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        if (typeof parsed.model === "string" && parsed.model) config.model = parsed.model;
        if (typeof parsed.baseURL === "string" && parsed.baseURL) config.baseURL = parsed.baseURL;
        if (typeof parsed.max_context === "number" && parsed.max_context > 0) {
          config.max_context = parsed.max_context;
        }
        if (typeof parsed.launch_command === "string" && parsed.launch_command) {
          config.launch_command = parsed.launch_command;
        }
        if (typeof parsed.tool_prefix === "string" && parsed.tool_prefix) {
          config.tool_prefix = parsed.tool_prefix;
        }
        if (typeof parsed.api_key === "string" && parsed.api_key) {
          config.api_key = parsed.api_key;
        }
        if (typeof parsed.engine_type === "string" && parsed.engine_type) {
          config.engine_type = parsed.engine_type;
        }
        if (typeof parsed.stop_command === "string" && parsed.stop_command) {
          config.stop_command = parsed.stop_command;
        }
        if (typeof parsed.engine_log_path === "string" && parsed.engine_log_path) {
          config.engine_log_path = parsed.engine_log_path;
        }
        if (typeof parsed.use_stream_proxy === "boolean") {
          config.use_stream_proxy = parsed.use_stream_proxy;
        }
        if (typeof parsed.stream_proxy_port === "number" && parsed.stream_proxy_port > 0) {
          config.stream_proxy_port = parsed.stream_proxy_port;
        }
        if (typeof parsed.status_port === "number" && parsed.status_port > 0) {
          config.status_port = parsed.status_port;
        }
        if (typeof parsed.vllm_port === "number" && parsed.vllm_port > 0) {
          config.vllm_port = parsed.vllm_port;
        }
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
          else if (k === "QWEN_API_KEY") config.api_key = config.api_key || v;
          else if (k === "QWEN_ENGINE_TYPE") config.engine_type = config.engine_type || v;
          else if (k === "QWEN_STOP_COMMAND") config.stop_command = config.stop_command || v;
          else if (k === "QWEN_LOG_PATH") config.engine_log_path = config.engine_log_path || v;
          else if (k === "USE_STREAM_PROXY") config.use_stream_proxy = config.use_stream_proxy ?? (v !== "false" && v !== "0");
          else if (k === "STREAM_PROXY_PORT" || k === "VLLM_PROXY_PORT") {
            const p = parseInt(v, 10);
            if (Number.isFinite(p) && p > 0) config.stream_proxy_port = config.stream_proxy_port ?? p;
          } else if (k === "STATUS_PORT") {
            const p = parseInt(v, 10);
            if (Number.isFinite(p) && p > 0) config.status_port = config.status_port ?? p;
          } else if (k === "VLLM_PORT") {
            const p = parseInt(v, 10);
            if (Number.isFinite(p) && p > 0) config.vllm_port = config.vllm_port ?? p;
          }
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
 * Maximum characters returned by web_fetch before boundary-aware truncation.
 * - Unit: characters
 * - Default: 60000
 * - Override: QWEN_MAX_FETCH_CHARS
 * @type {number}
 */
export const MAX_FETCH_CHARS = (() => {
  const parsed = parseInt(process.env.QWEN_MAX_FETCH_CHARS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60_000;
})();


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
export const ENGINE_LOG_PATH = (() => {
  const cfg = loadGlobalConfig();
  return process.env.QWEN_LOG_PATH || cfg.engine_log_path || "/tmp/mcp_launch_huge.log";
})();

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
 * Retry attempts for empty generation streams when prompt characters exceed EMPTY_STREAM_RETRY_DEPTH_CHARS.
 * - Unit: count
 * - Default: 4
 * - Override: QWEN_EMPTY_STREAM_RETRIES_DEEP
 * @type {number}
 */
const DEFAULT_EMPTY_STREAM_RETRIES_DEEP = 4;
export const EMPTY_STREAM_RETRIES_DEEP = (() => {
  const parsed = parseInt(process.env.QWEN_EMPTY_STREAM_RETRIES_DEEP, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_EMPTY_STREAM_RETRIES_DEEP;
})();

/**
 * Prompt character threshold that activates EMPTY_STREAM_RETRIES_DEEP.
 * - Unit: characters
 * - Default: 525000 (~150k tokens)
 * - Override: QWEN_EMPTY_STREAM_RETRY_DEPTH_CHARS
 * @type {number}
 */
const DEFAULT_EMPTY_STREAM_RETRY_DEPTH_CHARS = 525_000;
export const EMPTY_STREAM_RETRY_DEPTH_CHARS = (() => {
  const parsed = parseInt(process.env.QWEN_EMPTY_STREAM_RETRY_DEPTH_CHARS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_EMPTY_STREAM_RETRY_DEPTH_CHARS;
})();

/**
 * Base delay for exponential backoff between empty-stream retries.
 * - Unit: milliseconds
 * - Default: 2000
 * - Override: QWEN_EMPTY_STREAM_RETRY_BACKOFF_BASE_MS
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
 * Task prompt character threshold that emits advisory prompt_over_budget telemetry.
 * - Unit: characters
 * - Default: 1500
 * - Override: QWEN_PROMPT_BUDGET_CHARS
 * @type {number}
 */
export const DEFAULT_PROMPT_BUDGET_CHARS = 1500;
export const PROMPT_BUDGET_CHARS = (() => {
  const parsed = parseInt(process.env.QWEN_PROMPT_BUDGET_CHARS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PROMPT_BUDGET_CHARS;
})();

/**
 * Substantive text length required after stripping guard markers to avoid classification as degenerate.
 * - Unit: characters
 * - Default: 200
 * - Override: QWEN_DEGENERATE_FINAL_SUBSTANTIVE_CHARS
 * @type {number}
 */
const DEFAULT_DEGENERATE_FINAL_SUBSTANTIVE_CHARS = 200;
export const DEGENERATE_FINAL_SUBSTANTIVE_CHARS = (() => {
  const parsed = parseInt(process.env.QWEN_DEGENERATE_FINAL_SUBSTANTIVE_CHARS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DEGENERATE_FINAL_SUBSTANTIVE_CHARS;
})();

/**
 * Maximum turn count within which a truncated final response is evaluated for degeneracy.
 * - Unit: count
 * - Default: 3
 * - Override: QWEN_DEGENERATE_FINAL_MAX_TURNS
 * @type {number}
 */
const DEFAULT_DEGENERATE_FINAL_MAX_TURNS = 3;
export const DEGENERATE_FINAL_MAX_TURNS = (() => {
  const parsed = parseInt(process.env.QWEN_DEGENERATE_FINAL_MAX_TURNS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DEGENERATE_FINAL_MAX_TURNS;
})();

/**
 * Consecutive non-mutating shell execution threshold before emitting an advisory warning.
 * - Unit: count
 * - Default: 4
 * - Override: QWEN_PROBE_BUDGET
 * @type {number}
 */
const DEFAULT_PROBE_BUDGET = 4;
export const PROBE_BUDGET = (() => {
  const parsed = parseInt(process.env.QWEN_PROBE_BUDGET, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PROBE_BUDGET;
})();

/**
 * Cumulative turn threshold for emitting an advisory session_warning event.
 * - Unit: count
 * - Default: 60
 * - Override: QWEN_SESSION_WARN_TURNS
 * @type {number}
 */
const DEFAULT_SESSION_TURNS_WARN = 60;
export const SESSION_TURNS_WARN = (() => {
  const parsed = parseInt(process.env.QWEN_SESSION_WARN_TURNS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SESSION_TURNS_WARN;
})();

/**
 * Cumulative turn threshold for emitting a session_turn_limit_recommended advisory event.
 * - Unit: count
 * - Default: 80
 * - Override: QWEN_SESSION_RECOMMEND_TURNS
 * @type {number}
 */
const DEFAULT_SESSION_TURNS_RECOMMEND = 80;
export const SESSION_TURNS_RECOMMEND = (() => {
  const parsed = parseInt(process.env.QWEN_SESSION_RECOMMEND_TURNS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SESSION_TURNS_RECOMMEND;
})();

/**
 * Re-prefill prompt token threshold for emitting a context_depth_warning event.
 * - Unit: tokens
 * - Default: 65536
 * - Override: QWEN_CONTEXT_WARN_TOKENS
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
 * Maximum file read size enforced when context high-watermark is active.
 * - Unit: bytes
 * - Default: 16384 (16 KB)
 * - Override: QWEN_READ_GOVERNOR_MAX_BYTES
 * @type {number}
 */
const DEFAULT_READ_GOVERNOR_MAX_BYTES = 16 * 1024;
export const READ_GOVERNOR_MAX_BYTES = (() => {
  const parsed = parseInt(process.env.QWEN_READ_GOVERNOR_MAX_BYTES, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_READ_GOVERNOR_MAX_BYTES;
})();

/**
 * Tool result size threshold above which payload is spilled to disk.
 * - Unit: bytes
 * - Default: 16384 (16 KB)
 * - Override: QWEN_TOOL_SPILL_BYTES
 * @type {number}
 */
const DEFAULT_TOOL_SPILL_BYTES = 16384;
export const TOOL_SPILL_BYTES = (() => {
  const parsed = parseInt(process.env.QWEN_TOOL_SPILL_BYTES, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TOOL_SPILL_BYTES;
})();

/**
 * Generation token limit for bounded findings extraction on deliberation budget exhaustion.
 * - Unit: tokens
 * - Default: 4096
 * - Override: QWEN_SALVAGE_MAX_TOKENS
 * @type {number}
 */
const DEFAULT_SALVAGE_MAX_TOKENS = 4096;
export const SALVAGE_MAX_TOKENS = (() => {
  const parsed = parseInt(process.env.QWEN_SALVAGE_MAX_TOKENS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SALVAGE_MAX_TOKENS;
})();

// ---------------------------------------------------------------------------
// Engine configuration: model / baseURL / max_context / launch_command
// Precedence: environment variables > ~/.anser/config.json > built-in defaults.
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = "Qwen3.8-27B";
const DEFAULT_MAX_CONTEXT = MAX_LEN_HUGE;
const DEFAULT_LAUNCH_COMMAND = "";

/**
 * Resolves the engine configuration with precedence:
 *   1. Environment variables (QWEN_MODEL, QWEN_BASE_URL, QWEN_MAX_CONTEXT,
 *      QWEN_LAUNCH_COMMAND, MCP_TOOL_PREFIX)
 *   2. ~/.anser/config.json keys (model, baseURL, max_context, launch_command, tool_prefix)
 *   3. Built-in defaults
 *
 * @returns {{
 *   model: string,
 *   baseURL: string,
 *   max_context: number,
 *   launch_command: string,
 *   tool_prefix: string
 * }}
 */
export function getEngineConfig() {
  const cfg = loadGlobalConfig();
  return {
    model: process.env.QWEN_MODEL || cfg.model || DEFAULT_MODEL,
    baseURL: process.env.QWEN_BASE_URL || cfg.baseURL || BASE_URL,
    max_context:
      parseInt(process.env.QWEN_MAX_CONTEXT, 10) ||
      cfg.max_context ||
      DEFAULT_MAX_CONTEXT,
    launch_command: process.env.QWEN_LAUNCH_COMMAND || cfg.launch_command || DEFAULT_LAUNCH_COMMAND,
    tool_prefix: process.env.MCP_TOOL_PREFIX ?? cfg.tool_prefix ?? "qwen",
  };
}

/**
 * Model name served by the local engine.
 * - Default: "Qwen3.8-27B"
 * - Override: QWEN_MODEL (env) or `model` in ~/.anser/config.json
 * @type {string}
 */
export const MODEL = getEngineConfig().model;

/**
 * Nominal maximum context window for the served model, in tokens.
 * - Default: 245760
 * - Override: QWEN_MAX_CONTEXT (env) or `max_context` in ~/.anser/config.json
 * @type {number}
 */
export const MAX_CONTEXT = getEngineConfig().max_context;

/**
 * Shell command used to (re)start the inference engine.
 * - Default: "" (no managed launch)
 * - Override: QWEN_LAUNCH_COMMAND (env) or `launch_command` in ~/.anser/config.json
 * @type {string}
 */
export const LAUNCH_COMMAND = getEngineConfig().launch_command;

/**
 * Prefix applied to registered MCP tool names (e.g. "qwen" -> "qwen_coworker").
 * - Default: "qwen"
 * - Override: MCP_TOOL_PREFIX (env) or `tool_prefix` in ~/.anser/config.json
 * @type {string}
 */
export const TOOL_PREFIX = getEngineConfig().tool_prefix;

// ---------------------------------------------------------------------------
// Config-file-aware resolved values.
//
// These are the "effective" values that honor ~/.anser/config.json in addition
// to environment variables. They are defined at the bottom of the file (after
// GLOBAL_CONFIG_FILE / GLOBAL_ENV_FILE are initialized) so that calling
// loadGlobalConfig() here is safe (no TDZ).
//
// Precedence: environment variable > config.json > built-in default.
// ---------------------------------------------------------------------------

/**
 * Effective stream proxy port (env > config.json > default 18022).
 * @type {number}
 */
export const STREAM_PROXY_PORT_RESOLVED = (() => {
  const envPort = process.env.STREAM_PROXY_PORT || process.env.VLLM_PROXY_PORT;
  if (envPort) {
    const p = parseInt(envPort, 10);
    if (Number.isFinite(p) && p > 0) return p;
  }
  const cfg = loadGlobalConfig();
  if (typeof cfg.stream_proxy_port === "number" && cfg.stream_proxy_port > 0) {
    return cfg.stream_proxy_port;
  }
  return 18022;
})();

/**
 * Effective use-stream-proxy flag (env > config.json > default true).
 * @type {boolean}
 */
export const USE_STREAM_PROXY_RESOLVED = (() => {
  if (process.env.USE_STREAM_PROXY !== undefined) {
    return process.env.USE_STREAM_PROXY !== "false" && process.env.USE_STREAM_PROXY !== "0";
  }
  const cfg = loadGlobalConfig();
  if (typeof cfg.use_stream_proxy === "boolean") return cfg.use_stream_proxy;
  return true;
})();

/**
 * Effective status port (env > config.json > default 18021).
 * @type {number}
 */
export const STATUS_PORT_RESOLVED = (() => {
  const envPort = process.env.STATUS_PORT;
  if (envPort) {
    const p = parseInt(envPort, 10);
    if (Number.isFinite(p) && p > 0) return p;
  }
  const cfg = loadGlobalConfig();
  if (typeof cfg.status_port === "number" && cfg.status_port > 0) return cfg.status_port;
  return 18021;
})();

/**
 * Effective vLLM port (env > config.json > default 18020).
 * @type {number}
 */
export const VLLM_PORT_RESOLVED = (() => {
  const envPort = process.env.VLLM_PORT;
  if (envPort) {
    const p = parseInt(envPort, 10);
    if (Number.isFinite(p) && p > 0) return p;
  }
  const cfg = loadGlobalConfig();
  if (typeof cfg.vllm_port === "number" && cfg.vllm_port > 0) return cfg.vllm_port;
  return 18020;
})();

/**
 * Engine API key (env > config.json > empty string).
 * @type {string}
 */
export const API_KEY = (() => {
  const cfg = loadGlobalConfig();
  return process.env.QWEN_API_KEY || cfg.api_key || "";
})();

/**
 * Engine type tag (env > config.json > "vllm").
 * @type {string}
 */
export const ENGINE_TYPE = (() => {
  const cfg = loadGlobalConfig();
  return process.env.QWEN_ENGINE_TYPE || cfg.engine_type || "vllm";
})();

/**
 * Shell command used to stop the inference engine (env > config.json > "").
 * @type {string}
 */
export const STOP_COMMAND = (() => {
  const cfg = loadGlobalConfig();
  return process.env.QWEN_STOP_COMMAND || cfg.stop_command || "";
})();





