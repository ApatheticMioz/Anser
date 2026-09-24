import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  calculateCostSaved,
  DEFAULT_STATS,
  getCumulativeTelemetry,
  saveCumulativeTelemetry,
  recordTurnTelemetry,
  recordToolExecution,
  recordTaskResult,
  sampleLiveVllmMetrics,
  formatTelemetrySummary,
} from "../src/telemetry.js";

test("Telemetry: calculateCostSaved pricing arithmetic", () => {
  // Claude Sonnet 5: 1,000,000 prompt tokens @ $2.00/M = $2.00
  // 1,000,000 completion tokens @ $10.00/M = $10.00
  const cost = calculateCostSaved(1_000_000, 1_000_000);
  assert.equal(cost, 12.0);

  // 10,000,000 prompt tokens + 2,000,000 completion tokens = $20.00 + $20.00 = $40.00
  const cost2 = calculateCostSaved(10_000_000, 2_000_000);
  assert.equal(cost2, 40.0);
});

test("Telemetry: historical baseline and cumulative retrieval", () => {
  const stats = getCumulativeTelemetry();
  assert.ok(stats.total_completion_tokens >= 10_000_000, "Completion tokens reflect lifetime history");
  assert.ok(stats.total_reasoning_tokens >= 14_000_000, "Reasoning tokens reflect lifetime history");
  assert.ok(stats.total_prompt_tokens >= 900_000_000, "Prompt tokens reflect lifetime history");
  assert.ok(stats.total_turns >= 10_000, "Total turns reflect lifetime history");
  assert.ok(stats.total_sessions >= 450, "Total sessions reflect lifetime history");
  assert.ok(stats.total_tool_calls >= 13_000, "Total tool calls reflect lifetime history");
  assert.ok(stats.estimated_cost_saved_usd >= 2_000.0, "Cost savings reflect lifetime calculation");
  assert.equal(stats.history_ingested, true);
  assert.equal(stats.benchmark_model, "Claude Sonnet 5", "Benchmark model is Claude Sonnet 5");
  assert.ok(stats.vllm_engine_metrics.prefix_cache_hit_rate_pct > 0, "Prefix cache metric present");
  assert.ok(stats.vllm_engine_metrics.peak_gpu_kv_cache_pct > 0, "KV cache metric present");
  assert.ok(stats.vllm_engine_metrics.spec_mean_acceptance_length > 0, "Speculative decoding metric present");
});

test("Telemetry: recordTurnTelemetry updates token counts and rolling velocity", () => {
  const initial = getCumulativeTelemetry();
  const initComp = initial.total_completion_tokens;
  const initPrompt = initial.total_prompt_tokens;
  const initReasoning = initial.total_reasoning_tokens;
  const initTurns = initial.total_turns;

  recordTurnTelemetry({
    completionTokens: 250,
    promptTokens: 4000,
    reasoningTokens: 1200,
    ttftMs: 1500,
    tokensPerSec: 48.5,
    effort: "xhigh",
  });

  const updated = getCumulativeTelemetry();
  assert.equal(updated.total_completion_tokens, initComp + 250);
  assert.equal(updated.total_prompt_tokens, initPrompt + 4000);
  assert.equal(updated.total_reasoning_tokens, initReasoning + 1200);
  assert.equal(updated.total_turns, initTurns + 1);
  assert.ok(updated.avg_ttft_ms > 0);
  assert.ok(updated.avg_tokens_per_sec > 0);

  // Restore baseline
  saveCumulativeTelemetry(initial);
});

test("Telemetry: recordToolExecution tracks tools and errors", () => {
  const initial = getCumulativeTelemetry();
  const initCalls = initial.total_tool_calls || 0;
  const initErrors = initial.total_tool_errors || 0;
  const initBash = initial.tool_calls.bash || 0;

  recordToolExecution({ toolName: "bash", isError: false });
  recordToolExecution({ toolName: "bash", isError: true });

  const updated = getCumulativeTelemetry();
  assert.equal(updated.total_tool_calls, initCalls + 2);
  assert.equal(updated.total_tool_errors, initErrors + 1);
  assert.equal(updated.tool_calls.bash, initBash + 2);
  assert.equal(updated.tool_errors.bash, (initial.tool_errors.bash || 0) + 1);

  // Restore baseline
  saveCumulativeTelemetry(initial);
});

test("Telemetry: recordTaskResult tracks completed, failed, and cancelled tasks", () => {
  const initial = getCumulativeTelemetry();
  const initCompleted = initial.total_tasks_completed;
  const initFailed = initial.total_tasks_failed;
  const initCancelled = initial.total_tasks_cancelled || 0;

  recordTaskResult({ isSuccess: true, effort: "medium" });
  recordTaskResult({ isSuccess: false, effort: "medium" });
  recordTaskResult({ isSuccess: false, isCancelled: true, effort: "medium" });

  const updated = getCumulativeTelemetry();
  assert.equal(updated.total_tasks_completed, initCompleted + 1);
  assert.equal(updated.total_tasks_failed, initFailed + 1);
  assert.equal(updated.total_tasks_cancelled, initCancelled + 1);

  // Restore baseline
  saveCumulativeTelemetry(initial);
});

test("Telemetry: formatTelemetrySummary produces structured markdown and stats", () => {
  const { summary, stats } = formatTelemetrySummary();
  assert.ok(summary.includes("Lifetime Qwen Usage"), "Summary header present");
  assert.ok(summary.includes("Completion Generated"), "Completion tokens in summary");
  assert.ok(summary.includes("Deliberative Reasoning"), "Reasoning tokens in summary");
  assert.ok(summary.includes("Prompt Prefill"), "Prompt tokens in summary");
  assert.ok(summary.includes("vLLM Acceleration"), "vLLM acceleration in summary");
  assert.ok(summary.includes("Financial Value"), "Financial value in summary");
  assert.ok(summary.includes("Claude Sonnet 5"), "Sonnet 5 benchmark model in summary");
  assert.ok(summary.includes("Prefix Cache hit rate"), "Prefix cache in summary");
  assert.ok(stats.total_turns > 0);
  assert.ok(stats.estimated_cost_saved_usd > 0);
});
