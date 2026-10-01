import fs from "node:fs";
import path from "node:path";
import { QWEN_STATE_DIR, IS_WINDOWS, ENGINE_LOG_PATH } from "./config.js";

const TELEMETRY_DIR = path.join(QWEN_STATE_DIR, "telemetry");
const STATS_FILE = path.join(TELEMETRY_DIR, "stats.json");

// Frontier commercial baseline pricing (Claude Sonnet 5 tier: $2.00/M prompt, $10.00/M completion)
const PROMPT_COST_PER_MILLION = 2.0;
const COMPLETION_COST_PER_MILLION = 10.0;
const BENCHMARK_MODEL = "Claude Sonnet 5";

// Authoritative September 2026 frontier model reference rates
const FRONTIER_BENCHMARKS = {
  "Claude Sonnet 5": { promptPerM: 2.0, compPerM: 10.0, context: "500K" },
  "Claude Opus 5.5": { promptPerM: 4.0, compPerM: 20.0, context: "1,000K" },
  "Claude Fable 5.1": { promptPerM: 10.0, compPerM: 50.0, context: "1,000K" },
  "GPT-6 Astra": { promptPerM: 10.0, compPerM: 50.0, context: "1,050K" },
  "GLM-5.3": { promptPerM: 1.4, compPerM: 4.4, context: "200K" },
};

export function calculateCostSaved(promptTokens, completionTokens, promptRate = PROMPT_COST_PER_MILLION, compRate = COMPLETION_COST_PER_MILLION) {
  const promptCost = (promptTokens / 1_000_000) * promptRate;
  const compCost = (completionTokens / 1_000_000) * compRate;
  return Number((promptCost + compCost).toFixed(2));
}

/** Baseline aggregated statistics across historical sessions. */
export const DEFAULT_STATS = {
  total_completion_tokens: 22_045_497,
  total_reasoning_tokens: 23_832_473,
  total_prompt_tokens_measured: 615_423_782,
  total_prompt_tokens_estimated: 694_147_295,
  total_prompt_tokens: 1_309_571_077,
  total_turns: 17_616,
  total_sessions: 453,
  total_tasks_completed: 377,
  total_tasks_failed: 82,
  total_tasks_cancelled: 15,
  avg_ttft_ms: 20613.7,
  avg_prefill_ms: 20613.7,
  avg_generation_ms: 13995.3,
  avg_decode_tps: 61.14,
  avg_prefill_tps: 15032.79,
  avg_tpot_ms: 18.16,
  reasoning_effort: {
    xhigh: 116,
    medium: 6838,
    low: 699,
  },
  vllm_engine_metrics: {
    prefix_cache_hit_rate_pct: 92.6,
    peak_gpu_kv_cache_pct: 99.4,
    spec_mean_acceptance_length: 5.33,
    spec_draft_acceptance_rate_pct: 61.9,
    active_generation_throughput_tps: 44.54,
    active_prompt_throughput_tps: 1376.75,
  },
  total_tool_calls: 23_965,
  total_tool_errors: 937,
  tool_calls: {
    bash: 11809,
    read_file: 5173,
    edit_file: 2898,
    write_file: 1161,
    list_dir: 601,
    search_code: 1266,
    evo_propose_candidate: 135,
    evo_evaluate_candidate: 117,
    evo_select_candidate: 114,
    ext_context7_mcp_query_docs: 45,
    evo_status: 25,
    ext_context7_mcp_resolve_library_id: 18,
    avo_propose_candidate: 15,
    avo_select_candidate: 10,
    avo_evaluate_candidate: 5,
    ast_search: 9,
    exec_command: 1,
    avo_status: 1,
    evo_revert_candidate: 1,
    apply_patch: 4,
    web_search: 328,
    web_fetch: 229,
  },
  tool_errors: {
    read_file: 598,
    edit_file: 139,
    write_file: 49,
    bash: 17,
    list_dir: 14,
    search_code: 27,
    evo_evaluate_candidate: 3,
    ast_search: 2,
    apply_patch: 4,
    web_fetch: 22,
    web_search: 62,
  },
  benchmark_model: BENCHMARK_MODEL,
  estimated_cost_saved_usd: 2839.6,
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
  } catch (err) {
    // C1: corrupt stats file → quarantine, never silent-zero.
    const quarantineName = `stats.json.corrupt-${Date.now()}`;
    try {
      fs.renameSync(STATS_FILE, path.join(TELEMETRY_DIR, quarantineName));
    } catch {}
    process.stderr.write(`[Telemetry] Corrupt stats file quarantined to ${quarantineName}: ${err.message}\n`);
  }
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
 * @param {object} params
 * @param {number} [params.completionTokens=0] - Tokens generated during the completion phase.
 * @param {number} [params.promptTokens=0] - Tokens processed during the prefill phase.
 * @param {number} [params.reasoningTokens=0] - Deliberative reasoning tokens.
 * @param {number} [params.ttftMs=null] - Time to first token in milliseconds.
 * @param {number} [params.prefillMs=null] - Duration of the prefill phase in milliseconds.
 * @param {number} [params.generationMs=null] - Duration of the generation phase in milliseconds.
 * @param {number} [params.totalMs=null] - Total turn duration in milliseconds.
 * @param {string} [params.effort="medium"] - Reasoning effort tier.
 */
export function recordTurnTelemetry({
  completionTokens = 0,
  promptTokens = 0,
  reasoningTokens = 0,
  ttftMs = null,
  prefillMs = null,
  generationMs = null,
  totalMs = null,
  effort = "medium",
  decodeTps = null,
  prefillTps = null,
  tpotMs = null,
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

  const effectivePrefillMs = prefillMs ?? ttftMs;
  if (typeof effectivePrefillMs === "number" && effectivePrefillMs > 0) {
    stats.avg_ttft_ms = Number(
      (((stats.avg_ttft_ms || effectivePrefillMs) * 0.95) + (effectivePrefillMs * 0.05)).toFixed(1)
    );
    stats.avg_prefill_ms = stats.avg_ttft_ms;
  }

  const effectiveGenMs =
    typeof generationMs === "number" && generationMs >= 0
      ? generationMs
      : (typeof totalMs === "number" && typeof effectivePrefillMs === "number"
          ? Math.max(0, totalMs - effectivePrefillMs)
          : null);

  if (typeof effectiveGenMs === "number" && effectiveGenMs >= 0) {
    stats.avg_generation_ms = Number(
      (((stats.avg_generation_ms || effectiveGenMs) * 0.95) + (effectiveGenMs * 0.05)).toFixed(1)
    );
  }

  // Running averages for the standard throughput / per-token-latency rates.
  // Same 0.95/0.05 EMA convention as the latency averages above; only updated
  // when the provider actually produced a finite, non-negative value (null
  // rates from degenerate turns are ignored, never averaged in).
  if (typeof decodeTps === "number" && decodeTps >= 0) {
    stats.avg_decode_tps = Number(
      (((stats.avg_decode_tps || decodeTps) * 0.95) + (decodeTps * 0.05)).toFixed(2)
    );
  }
  if (typeof prefillTps === "number" && prefillTps >= 0) {
    stats.avg_prefill_tps = Number(
      (((stats.avg_prefill_tps || prefillTps) * 0.95) + (prefillTps * 0.05)).toFixed(2)
    );
  }
  if (typeof tpotMs === "number" && tpotMs >= 0) {
    stats.avg_tpot_ms = Number(
      (((stats.avg_tpot_ms || tpotMs) * 0.95) + (tpotMs * 0.05)).toFixed(2)
    );
  }

  saveCumulativeTelemetry(stats);

  // Append a per-turn record to the rolling turns.jsonl ledger so that
  // time-sliced queries (queryTelemetry) can reconstruct distributions and
  // rates over arbitrary windows. Capped at MAX_TURNS_LEDGER lines; when the
  // cap is exceeded the oldest lines are dropped (FIFO) to bound disk growth.
  appendTurnRecord({
    ts: Date.now(),
    prompt: promptTokens,
    comp: completionTokens,
    reasoning: reasoningTokens,
    ttft: effectivePrefillMs,
    gen: effectiveGenMs,
    total: totalMs,
    decodeTps,
    prefillTps,
    tpotMs,
    effort,
  });
}

const TURNS_LEDGER_FILE = () => path.join(TELEMETRY_DIR, "turns.jsonl");
const MAX_TURNS_LEDGER = 20000;

/**
 * Appends a single per-turn record to the rolling turns.jsonl ledger,
 * trimming the oldest lines when the cap is exceeded. Never throws: a
 * telemetry-write failure must not break the inference path.
 */
function appendTurnRecord(record) {
  try {
    if (!fs.existsSync(TELEMETRY_DIR)) {
      fs.mkdirSync(TELEMETRY_DIR, { recursive: true });
    }
    const file = TURNS_LEDGER_FILE();
    if (fs.existsSync(file)) {
      const existing = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== "");
      if (existing.length >= MAX_TURNS_LEDGER) {
        const trimmed = existing.slice(existing.length - (MAX_TURNS_LEDGER - 1));
        fs.writeFileSync(file, trimmed.join("\n") + "\n", "utf8");
      }
    }
    fs.appendFileSync(file, JSON.stringify(record) + "\n", "utf8");
  } catch (err) {
    console.error("[Telemetry] Failed to append turn record:", err.message);
  }
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
 * Reads the rolling per-turn ledger (turns.jsonl) into an array of records.
 * Returns [] when the file is absent or unreadable — a missing ledger is a
 * valid state (fresh install / pre-Slice-2 history) and must not throw.
 */
function readTurnsLedger() {
  try {
    const file = TURNS_LEDGER_FILE();
    if (!fs.existsSync(file)) return [];
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter((r) => r && typeof r === "object");
  } catch {
    return [];
  }
}

/**
 * Resolves a time-slice filter into a [startMs, endMs) window.
 *
 * Supported keys (first match wins, in this precedence order):
 *   - since / until : ISO-8601 strings (or ms numbers) bounding the window.
 *   - window        : "1h" | "24h" | "today" | "yesterday" (relative to now).
 *   - date          : "YYYY-MM-DD" → that calendar day (local time).
 *   - hour          : 0-23, combined with `date` (defaults to today).
 *   - minute        : 0-59, combined with `date`+`hour` (defaults to today).
 *
 * Returns { startMs, endMs } where the window is inclusive [startMs, endMs].
 */
function resolveTimeWindow({ since, until, date, hour, minute, window } = {}) {
  const now = Date.now();

  // Explicit ISO / numeric bounds take precedence.
  if (since !== undefined || until !== undefined) {
    const startMs = since === undefined ? 0 : (typeof since === "number" ? since : Date.parse(since));
    const endMs = until === undefined ? now : (typeof until === "number" ? until : Date.parse(until));
    return {
      startMs: Number.isFinite(startMs) ? startMs : 0,
      endMs: Number.isFinite(endMs) ? endMs : now,
    };
  }

  // Relative windows.
  if (window === "1h") return { startMs: now - 3600_000, endMs: now };
  if (window === "24h") return { startMs: now - 86400_000, endMs: now };
  if (window === "today") {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return { startMs: d.getTime(), endMs: now };
  }
  if (window === "yesterday") {
    const end = new Date();
    end.setHours(0, 0, 0, 0);
    const start = new Date(end);
    start.setDate(start.getDate() - 1);
    return { startMs: start.getTime(), endMs: end.getTime() };
  }

  // Calendar-date windows (optionally narrowed to an hour or minute).
  if (date !== undefined || hour !== undefined || minute !== undefined) {
    const base = date !== undefined ? new Date(`${date}T00:00:00`) : new Date();
    if (Number.isNaN(base.getTime())) base.setHours(0, 0, 0, 0);
    if (hour !== undefined) base.setHours(hour, 0, 0, 0);
    if (minute !== undefined) base.setMinutes(minute, 0, 0);
    const spanMs = minute !== undefined ? 60_000 : hour !== undefined ? 3600_000 : 86400_000;
    return { startMs: base.getTime(), endMs: base.getTime() + spanMs };
  }

  // No filter → full lifetime (bounded by the ledger's own extent).
  return { startMs: 0, endMs: now };
}

/**
 * Time-sliced telemetry query.
 *
 * Filters the per-turn ledger to a window (see resolveTimeWindow) and returns
 * aggregate statistics for that slice:
 *   {
 *     startMs, endMs,
 *     turns,
 *     promptTokens, completionTokens, reasoningTokens,
 *     avg_ttft_ms, avg_generation_ms,
 *     avg_decode_tps, avg_prefill_tps, avg_tpot_ms,
 *     costSavedUsd,
 *   }
 *
 * Averages are computed over the turns that actually reported a finite value
 * for that field (nulls are excluded, not zero-filled). Returns a zeroed
 * aggregate (turns: 0) when no turns match the slice.
 */
export function queryTelemetry({ since, until, date, hour, minute, window } = {}) {
  const { startMs, endMs } = resolveTimeWindow({ since, until, date, hour, minute, window });
  const all = readTurnsLedger();
  const turns = all.filter((r) => {
    const t = typeof r.ts === "number" ? r.ts : Date.parse(r.ts);
    // Inclusive [startMs, endMs] window: a turn recorded at exactly the
    // window's end boundary (e.g. "now") is part of the slice, not excluded.
    return Number.isFinite(t) && t >= startMs && t <= endMs;
  });

  const sum = (key) => turns.reduce((acc, r) => acc + (typeof r[key] === "number" ? r[key] : 0), 0);
  const avg = (key) => {
    const vals = turns.map((r) => r[key]).filter((v) => typeof v === "number" && Number.isFinite(v));
    if (vals.length === 0) return null;
    return Number((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2));
  };

  const promptTokens = sum("prompt");
  const completionTokens = sum("comp");

  return {
    startMs,
    endMs,
    turns: turns.length,
    promptTokens,
    completionTokens,
    reasoningTokens: sum("reasoning"),
    avg_ttft_ms: avg("ttft"),
    avg_generation_ms: avg("gen"),
    avg_decode_tps: avg("decodeTps"),
    avg_prefill_tps: avg("prefillTps"),
    avg_tpot_ms: avg("tpotMs"),
    costSavedUsd: calculateCostSaved(promptTokens, completionTokens),
  };
}

/**
 * Formats a user-friendly statistics string with rich telemetry.
 *
 * Accepts an optional time-slice filter (same keys as queryTelemetry). When the
 * filter carries at least one defined key, the summary is computed over that
 * slice of the per-turn ledger; otherwise it renders the lifetime cumulative
 * stats.
 */
export function formatTelemetrySummary(filter = {}) {
  const hasFilter = Object.keys(filter).some((k) => filter[k] !== undefined);

  if (hasFilter) {
    let label = filter.window || filter.since || filter.date || "slice";
    if (filter.date && filter.hour !== undefined) {
      label = `${filter.date} ${String(filter.hour).padStart(2, "0")}:00`;
      if (filter.minute !== undefined) {
        label = `${filter.date} ${String(filter.hour).padStart(2, "0")}:${String(filter.minute).padStart(2, "0")}`;
      }
    } else if (filter.hour !== undefined) {
      label = `hour ${filter.hour}`;
      if (filter.minute !== undefined) {
        label = `hour ${filter.hour}:${String(filter.minute).padStart(2, "0")}`;
      }
    }
    const slice = queryTelemetry(filter);
    const fmt = (v, unit, digits = 1) =>
      v === null || v === undefined ? "n/a" : `${Number(v).toFixed(digits)}${unit ? " " + unit : ""}`;
    const lines = [
      `### 📊 Qwen Telemetry — ${label}`,
      `- **Turns in slice**: **${slice.turns.toLocaleString()}**`,
      `- **Tokens**: **${slice.promptTokens.toLocaleString()}** prompt | **${slice.completionTokens.toLocaleString()}** completion | **${slice.reasoningTokens.toLocaleString()}** reasoning`,
      `- **Decode Speed**: **${fmt(slice.avg_decode_tps, "tok/s", 2)}**`,
      `- **Prefill Speed**: **${fmt(slice.avg_prefill_tps, "tok/s", 2)}**`,
      `- **TTFT**: **${slice.avg_ttft_ms != null ? fmt(slice.avg_ttft_ms / 1000, "s", 1) : "n/a"}**`,
      `- **TPOT**: **${fmt(slice.avg_tpot_ms, "ms/tok", 2)}**`,
      `- **Cost Saved (slice)**: **$${slice.costSavedUsd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD**`,
    ];
    return { summary: lines.join("\n"), stats: slice };
  }

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

  const opusSaved = calculateCostSaved(stats.total_prompt_tokens, stats.total_completion_tokens, 4.0, 20.0);
  const frontierSaved = calculateCostSaved(stats.total_prompt_tokens, stats.total_completion_tokens, 10.0, 50.0);
  const glmSaved = calculateCostSaved(stats.total_prompt_tokens, stats.total_completion_tokens, 1.4, 4.4);

  const prefillSec = stats.avg_prefill_ms || stats.avg_ttft_ms
    ? ((stats.avg_prefill_ms || stats.avg_ttft_ms) / 1000).toFixed(1)
    : null;
  const genSec = stats.avg_generation_ms
    ? (stats.avg_generation_ms / 1000).toFixed(1)
    : null;
  const timingItems = [];
  if (prefillSec) timingItems.push(`**${prefillSec}s** avg prefill (TTFT)`);
  if (genSec) timingItems.push(`**${genSec}s** avg generation`);
  const timingLine = timingItems.length > 0
    ? `- **Turn Latency**: ${timingItems.join(" | ")}`
    : null;

  const decodeTps = stats.avg_decode_tps != null ? `**${stats.avg_decode_tps}** tok/s decode` : null;
  const prefillTps = stats.avg_prefill_tps != null ? `**${stats.avg_prefill_tps}** tok/s prefill` : null;
  const tpot = stats.avg_tpot_ms != null ? `**${stats.avg_tpot_ms}** ms/tok TPOT` : null;
  const rateItems = [decodeTps, prefillTps, tpot].filter(Boolean);
  const rateLine = rateItems.length > 0
    ? `- **Throughput**: ${rateItems.join(" | ")}`
    : null;

  const summary = [
    `### 🚀 Lifetime Qwen Usage & Castor Telemetry`,
    `- **Completion Generated**: **${compM}M** tokens (${stats.total_completion_tokens.toLocaleString()} tok)`,
    `- **Deliberative Reasoning**: **${reasoningM}M** thinking tokens (${stats.total_reasoning_tokens.toLocaleString()} tok)`,
    `- **Prompt Prefill**: **${promptM}M** tokens (${measuredPromptM}M exact measured + ${((stats.total_prompt_tokens_estimated || 0) / 1_000_000).toFixed(2)}M estimated)`,
    ...(timingLine ? [timingLine] : []),
    ...(rateLine ? [rateLine] : []),
    `- **Total Turns & Sessions**: **${stats.total_turns.toLocaleString()}** turns across **${stats.total_sessions}** sessions`,
    `- **Task Lifecycle**: **${stats.total_tasks_completed}** completed, **${stats.total_tasks_failed}** failed, **${stats.total_tasks_cancelled || 0}** cancelled`,
    `- **Tool Execution**: **${stats.total_tool_calls.toLocaleString()}** calls with only **${stats.total_tool_errors}** errors (${toolErrorRate}% error rate)`,
    `- **Top Tools**: ${topTools}`,
    `- **vLLM Acceleration**: **${stats.vllm_engine_metrics.prefix_cache_hit_rate_pct}%** Prefix Cache hit rate | **${stats.vllm_engine_metrics.spec_mean_acceptance_length}** tok/step DFlash2 mean acceptance | **${stats.vllm_engine_metrics.peak_gpu_kv_cache_pct}%** peak GPU KV cache`,
    `- **Financial Value**: **${stats.estimated_cost_saved_usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD** in API cost saved vs **${stats.benchmark_model || BENCHMARK_MODEL}** (${PROMPT_COST_PER_MILLION.toFixed(2)}/M prompt, ${COMPLETION_COST_PER_MILLION.toFixed(2)}/M completion) at **$0 local token cost**`,
    `  - *Vs Claude Opus 5.5 ($4/$20)*: **${opusSaved.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD** saved`,
    `  - *Vs GPT-6 Astra / Claude Fable 5.1 ($10/$50)*: **${frontierSaved.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD** saved`,
    `  - *Vs GLM-5.3 ($1.40/$4.40)*: **${glmSaved.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD** saved`,
  ].join("\n");

  return {
    summary,
    stats,
  };
}
