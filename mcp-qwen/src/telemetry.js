import fs from "node:fs";
import path from "node:path";
import { QWEN_STATE_DIR, IS_WINDOWS, ENGINE_LOG_PATH } from "./config.js";

const TELEMETRY_DIR = path.join(QWEN_STATE_DIR, "telemetry");
const STATS_FILE = path.join(TELEMETRY_DIR, "stats.json");

// Frontier commercial baseline pricing (Claude Sonnet 5 tier: $2.00/M prompt, $10.00/M completion)
export const PROMPT_COST_PER_MILLION = 2.0;
export const COMPLETION_COST_PER_MILLION = 10.0;
export const BENCHMARK_MODEL = "Claude Sonnet 5";

export function calculateCostSaved(promptTokens, completionTokens) {
  const promptCost = (promptTokens / 1_000_000) * PROMPT_COST_PER_MILLION;
  const compCost = (completionTokens / 1_000_000) * COMPLETION_COST_PER_MILLION;
  return Number((promptCost + compCost).toFixed(2));
}

// Authoritative historical baseline aggregated across all 453 lifetime sessions since 2026-09-05
export const DEFAULT_STATS = {
  total_completion_tokens: 10_372_422,
  total_reasoning_tokens: 14_916_578,
  total_prompt_tokens_measured: 268_119_160,
  total_prompt_tokens_estimated: 694_147_295,
  total_prompt_tokens: 962_266_455,
  total_turns: 10_918,
  total_sessions: 453,
  total_tasks_completed: 118,
  total_tasks_failed: 35,
  total_tasks_cancelled: 4,
  avg_ttft_ms: 13206.3,
  avg_tokens_per_sec: 1.07,
  peak_tokens_per_sec: 52.63,
  reasoning_effort: {
    xhigh: 14,
    medium: 622,
    low: 2,
  },
  vllm_engine_metrics: {
    prefix_cache_hit_rate_pct: 68.2,
    peak_gpu_kv_cache_pct: 99.4,
    spec_mean_acceptance_length: 4.59,
    spec_draft_acceptance_rate_pct: 44.8,
    active_generation_throughput_tps: 44.54,
    active_prompt_throughput_tps: 1376.75,
  },
  total_tool_calls: 13_749,
  total_tool_errors: 257,
  tool_calls: {
    bash: 7840,
    read_file: 2626,
    edit_file: 1646,
    write_file: 494,
    list_dir: 331,
    search_code: 319,
    evo_propose_candidate: 135,
    evo_evaluate_candidate: 117,
    evo_select_candidate: 114,
    ext_context7_mcp_query_docs: 45,
    evo_status: 25,
    ext_context7_mcp_resolve_library_id: 18,
    avo_propose_candidate: 15,
    avo_select_candidate: 10,
    avo_evaluate_candidate: 5,
    ast_search: 5,
    exec_command: 1,
    avo_status: 1,
    evo_revert_candidate: 1,
    apply_patch: 1,
  },
  tool_errors: {
    read_file: 115,
    edit_file: 64,
    write_file: 41,
    bash: 15,
    list_dir: 9,
    search_code: 7,
    evo_evaluate_candidate: 3,
    ast_search: 2,
    apply_patch: 1,
  },
  benchmark_model: BENCHMARK_MODEL,
  estimated_cost_saved_usd: 2028.25,
  first_recorded_session: "2026-09-05T03:58:07.228Z",
  last_recorded_session: "2026-09-24T18:10:46.123Z",
  history_ingested: true,
  last_updated: new Date().toISOString(),
};

/**
 * Loads the current cumulative stats from disk or initializes defaults.
 */
export function getCumulativeTelemetry() {
  try {
    if (fs.existsSync(STATS_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATS_FILE, "utf8"));
      return {
        ...DEFAULT_STATS,
        ...data,
        reasoning_effort: {
          ...DEFAULT_STATS.reasoning_effort,
          ...(data.reasoning_effort || {}),
        },
        vllm_engine_metrics: {
          ...DEFAULT_STATS.vllm_engine_metrics,
          ...(data.vllm_engine_metrics || {}),
        },
        tool_calls: {
          ...DEFAULT_STATS.tool_calls,
          ...(data.tool_calls || {}),
        },
        tool_errors: {
          ...DEFAULT_STATS.tool_errors,
          ...(data.tool_errors || {}),
        },
      };
    }
  } catch {}
  return JSON.parse(JSON.stringify(DEFAULT_STATS));
}

/**
 * Persists updated cumulative stats atomically across Windows & WSL.
 */
export function saveCumulativeTelemetry(stats) {
  try {
    if (!fs.existsSync(TELEMETRY_DIR)) {
      fs.mkdirSync(TELEMETRY_DIR, { recursive: true });
    }
    stats.estimated_cost_saved_usd = calculateCostSaved(
      stats.total_prompt_tokens,
      stats.total_completion_tokens
    );
    stats.last_updated = new Date().toISOString();
    const tmp = `${STATS_FILE}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(stats, null, 2), "utf8");
    fs.renameSync(tmp, STATS_FILE);
  } catch (err) {
    console.error("[Telemetry] Failed to persist stats:", err.message);
  }
}

/**
 * Records telemetry from an executed turn.
 */
export function recordTurnTelemetry({
  completionTokens = 0,
  promptTokens = 0,
  reasoningTokens = 0,
  ttftMs = null,
  tokensPerSec = null,
  effort = "medium",
} = {}) {
  const stats = getCumulativeTelemetry();
  stats.total_completion_tokens += completionTokens;
  stats.total_reasoning_tokens += reasoningTokens;
  stats.total_prompt_tokens_measured += promptTokens;
  stats.total_prompt_tokens += promptTokens;
  stats.total_turns += 1;

  if (stats.reasoning_effort[effort] !== undefined) {
    stats.reasoning_effort[effort] += 1;
  }

  if (typeof ttftMs === "number" && ttftMs > 0) {
    stats.avg_ttft_ms = Number(
      ((stats.avg_ttft_ms * 0.95) + (ttftMs * 0.05)).toFixed(1)
    );
  }

  if (typeof tokensPerSec === "number" && tokensPerSec > 0) {
    stats.avg_tokens_per_sec = Number(
      ((stats.avg_tokens_per_sec * 0.95) + (tokensPerSec * 0.05)).toFixed(2)
    );
    if (tokensPerSec > stats.peak_tokens_per_sec) {
      stats.peak_tokens_per_sec = Number(tokensPerSec.toFixed(2));
    }
  }

  saveCumulativeTelemetry(stats);
}

/**
 * Records an individual tool execution.
 */
export function recordToolExecution({ toolName = "unknown", isError = false } = {}) {
  const stats = getCumulativeTelemetry();
  stats.total_tool_calls = (stats.total_tool_calls || 0) + 1;
  stats.tool_calls[toolName] = (stats.tool_calls[toolName] || 0) + 1;

  if (isError) {
    stats.total_tool_errors = (stats.total_tool_errors || 0) + 1;
    stats.tool_errors[toolName] = (stats.tool_errors[toolName] || 0) + 1;
  }

  saveCumulativeTelemetry(stats);
}

/**
 * Records task completion, failure, or cancellation.
 */
export function recordTaskResult({
  isSuccess = true,
  isCancelled = false,
  effort = null,
} = {}) {
  const stats = getCumulativeTelemetry();
  if (isCancelled) {
    stats.total_tasks_cancelled = (stats.total_tasks_cancelled || 0) + 1;
  } else if (isSuccess) {
    stats.total_tasks_completed = (stats.total_tasks_completed || 0) + 1;
  } else {
    stats.total_tasks_failed = (stats.total_tasks_failed || 0) + 1;
  }

  if (effort && stats.reasoning_effort[effort] !== undefined) {
    stats.reasoning_effort[effort] += 1;
  }

  saveCumulativeTelemetry(stats);
}

/**
 * Samples live vLLM engine log metrics (prefix cache hit rate, KV usage, DFlash acceptance)
 * without blocking or failing if the engine is stopped or unreachable.
 */
export function sampleLiveVllmMetrics() {
  try {
    let logPath = ENGINE_LOG_PATH;
    if (IS_WINDOWS && logPath.startsWith("/")) {
      logPath = `\\\\wsl.localhost\\Ubuntu${logPath.replace(/\//g, "\\")}`;
    }

    if (!fs.existsSync(logPath)) return;

    const stats = fs.statSync(logPath);
    const readSize = Math.min(stats.size, 32768);
    const buffer = Buffer.alloc(readSize);
    const fd = fs.openSync(logPath, "r");
    fs.readSync(fd, buffer, 0, readSize, stats.size - readSize);
    fs.closeSync(fd);

    const tailText = buffer.toString("utf8");
    const telemetry = getCumulativeTelemetry();
    let updated = false;

    const prefixMatch = tailText.match(/Prefix cache hit rate:\s*([\d\.]+)%/g);
    if (prefixMatch && prefixMatch.length > 0) {
      const last = prefixMatch[prefixMatch.length - 1];
      const val = parseFloat(last.replace(/[^0-9.]/g, ""));
      if (Number.isFinite(val)) {
        telemetry.vllm_engine_metrics.prefix_cache_hit_rate_pct = val;
        updated = true;
      }
    }

    const kvMatch = tailText.match(/GPU KV cache usage:\s*([\d\.]+)%/g);
    if (kvMatch && kvMatch.length > 0) {
      const last = kvMatch[kvMatch.length - 1];
      const val = parseFloat(last.replace(/[^0-9.]/g, ""));
      if (Number.isFinite(val) && val > telemetry.vllm_engine_metrics.peak_gpu_kv_cache_pct) {
        telemetry.vllm_engine_metrics.peak_gpu_kv_cache_pct = val;
        updated = true;
      }
    }

    const specMatch = tailText.match(/Mean acceptance length:\s*([\d\.]+)/g);
    if (specMatch && specMatch.length > 0) {
      const last = specMatch[specMatch.length - 1];
      const val = parseFloat(last.replace(/[^0-9.]/g, ""));
      if (Number.isFinite(val)) {
        telemetry.vllm_engine_metrics.spec_mean_acceptance_length = val;
        updated = true;
      }
    }

    const draftMatch = tailText.match(/Avg Draft acceptance rate:\s*([\d\.]+)%/g);
    if (draftMatch && draftMatch.length > 0) {
      const last = draftMatch[draftMatch.length - 1];
      const val = parseFloat(last.replace(/[^0-9.]/g, ""));
      if (Number.isFinite(val)) {
        telemetry.vllm_engine_metrics.spec_draft_acceptance_rate_pct = val;
        updated = true;
      }
    }

    if (updated) {
      saveCumulativeTelemetry(telemetry);
    }
  } catch {}
}

/**
 * Formats a user-friendly statistics string with rich telemetry.
 */
export function formatTelemetrySummary() {
  const stats = getCumulativeTelemetry();
  const compM = (stats.total_completion_tokens / 1_000_000).toFixed(2);
  const reasoningM = (stats.total_reasoning_tokens / 1_000_000).toFixed(2);
  const promptM = (stats.total_prompt_tokens / 1_000_000).toFixed(2);
  const measuredPromptM = (stats.total_prompt_tokens_measured / 1_000_000).toFixed(2);
  const toolErrorRate = stats.total_tool_calls > 0
    ? ((stats.total_tool_errors / stats.total_tool_calls) * 100).toFixed(2)
    : "0.00";

  const topTools = Object.entries(stats.tool_calls || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([tool, count]) => `${tool}: ${count.toLocaleString()}`)
    .join(", ");

  const summary = [
    `### 🚀 Lifetime Qwen Usage & Anser Telemetry`,
    `- **Completion Generated**: **${compM}M** tokens (${stats.total_completion_tokens.toLocaleString()} tok)`,
    `- **Deliberative Reasoning**: **${reasoningM}M** thinking tokens (${stats.total_reasoning_tokens.toLocaleString()} tok)`,
    `- **Prompt Prefill**: **${promptM}M** tokens (${measuredPromptM}M exact measured + ${((stats.total_prompt_tokens_estimated || 0) / 1_000_000).toFixed(2)}M estimated)`,
    `- **Total Turns & Sessions**: **${stats.total_turns.toLocaleString()}** turns across **${stats.total_sessions}** sessions`,
    `- **Task Lifecycle**: **${stats.total_tasks_completed}** completed, **${stats.total_tasks_failed}** failed, **${stats.total_tasks_cancelled || 0}** cancelled`,
    `- **Tool Execution**: **${stats.total_tool_calls.toLocaleString()}** calls with only **${stats.total_tool_errors}** errors (${toolErrorRate}% error rate)`,
    `- **Top Tools**: ${topTools}`,
    `- **vLLM Acceleration**: **${stats.vllm_engine_metrics.prefix_cache_hit_rate_pct}%** Prefix Cache hit rate | **${stats.vllm_engine_metrics.spec_mean_acceptance_length}** tok/step DFlash2 mean acceptance | **${stats.vllm_engine_metrics.peak_gpu_kv_cache_pct}%** peak GPU KV cache`,
    `- **Financial Value**: **$${stats.estimated_cost_saved_usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD** in API cost saved vs **${stats.benchmark_model || BENCHMARK_MODEL}** ($${PROMPT_COST_PER_MILLION.toFixed(2)}/M prompt, $${COMPLETION_COST_PER_MILLION.toFixed(2)}/M completion) at **$0 local token cost**`,
  ].join("\n");

  return {
    summary,
    stats,
  };
}
