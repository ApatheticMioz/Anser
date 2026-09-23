import fs from "node:fs";
import path from "node:path";
import { QWEN_STATE_DIR } from "./config.js";

const TELEMETRY_DIR = path.join(QWEN_STATE_DIR, "telemetry");
const STATS_FILE = path.join(TELEMETRY_DIR, "stats.json");

// Commercial baseline pricing (Claude 3.5 Sonnet / GPT-4o tier: $3.00/M prompt, $15.00/M completion)
const PROMPT_COST_PER_MILLION = 3.0;
const COMPLETION_COST_PER_MILLION = 15.0;

function calculateCostSaved(promptTokens, completionTokens) {
  const promptCost = (promptTokens / 1_000_000) * PROMPT_COST_PER_MILLION;
  const compCost = (completionTokens / 1_000_000) * COMPLETION_COST_PER_MILLION;
  return Number((promptCost + compCost).toFixed(2));
}

// Initial seed baseline from the 105.5-hour empirical campaign audit
const DEFAULT_STATS = {
  total_completion_tokens: 3_159_834,
  total_prompt_tokens: 65_195_969,
  total_turns: 1_456,
  total_tasks_completed: 79,
  total_tasks_failed: 14,
  reasoning_effort: {
    xhigh: 14,
    medium: 40,
    low: 2,
  },
  estimated_cost_saved_usd: 243.0,
  last_updated: new Date().toISOString(),
};

/**
 * Loads the current cumulative stats from disk or initializes defaults.
 */
export function getCumulativeTelemetry() {
  try {
    if (fs.existsSync(STATS_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATS_FILE, "utf8"));
      return { ...DEFAULT_STATS, ...data };
    }
  } catch {}
  return { ...DEFAULT_STATS };
}

/**
 * Persists updated cumulative stats atomically.
 */
function saveCumulativeTelemetry(stats) {
  try {
    if (!fs.existsSync(TELEMETRY_DIR)) {
      fs.mkdirSync(TELEMETRY_DIR, { recursive: true });
    }
    stats.estimated_cost_saved_usd = calculateCostSaved(
      stats.total_prompt_tokens,
      stats.total_completion_tokens
    );
    stats.last_updated = new Date().toISOString();
    const tmp = `${STATS_FILE}.tmp.${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(stats, null, 2), "utf8");
    fs.renameSync(tmp, STATS_FILE);
  } catch (err) {
    console.error("[Telemetry] Failed to persist stats:", err.message);
  }
}

/**
 * Records telemetry from an executed turn.
 */
export function recordTurnTelemetry({ completionTokens = 0, promptTokens = 0, effort = "medium" } = {}) {
  const stats = getCumulativeTelemetry();
  stats.total_completion_tokens += completionTokens;
  stats.total_prompt_tokens += promptTokens;
  stats.total_turns += 1;
  if (stats.reasoning_effort[effort] !== undefined) {
    stats.reasoning_effort[effort] += 1;
  }
  saveCumulativeTelemetry(stats);
}

/**
 * Records task completion or failure.
 */
export function recordTaskResult({ isSuccess = true, effort } = {}) {
  const stats = getCumulativeTelemetry();
  if (isSuccess) {
    stats.total_tasks_completed += 1;
  } else {
    stats.total_tasks_failed += 1;
  }
  if (effort && stats.reasoning_effort[effort] !== undefined) {
    stats.reasoning_effort[effort] += 1;
  }
  saveCumulativeTelemetry(stats);
}

/**
 * Formats a user-friendly statistics string.
 */
export function formatTelemetrySummary() {
  const stats = getCumulativeTelemetry();
  const compMillions = (stats.total_completion_tokens / 1_000_000).toFixed(2);
  const promptMillions = (stats.total_prompt_tokens / 1_000_000).toFixed(2);
  return {
    summary: `Lifetime Qwen Usage: ${compMillions}M completion tokens generated, ${promptMillions}M prompt tokens prefilled across ${stats.total_turns} turns. Estimated API savings: $${stats.estimated_cost_saved_usd.toFixed(2)} USD at $0 local token cost.`,
    stats,
  };
}
