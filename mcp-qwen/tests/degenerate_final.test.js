#!/usr/bin/env node
/**
 * M3b — Degenerate-Final Guard Verification (fully OFFLINE).
 *
 * The stream proxy circuit-breaks a runaway repetition loop by appending a
 * GUARD_MARKER sentinel and ending the stream with finish_reason "stop". The
 * provider accumulates that marker into the turn's content, so a turn whose
 * ENTIRE message is just the marker (or a tiny sliver of text + marker) lands
 * in the runner as a "stop" turn WITH content. The old code reported a false
 * "completed" (the M3a defect: 7 false-success sessions, e.g.
 * task_mitig-m3a-s3 with 0 tool calls and a marker-only result).
 *
 * This suite proves the runner is now honest about guard-truncated degenerate
 * finals:
 *   (a) marker-only final, ALWAYS degenerate -> retries via the empty-stream
 *       path (reason "degenerate_final"), then the honest status
 *       "degenerate_response_truncated" with the original partial+marker
 *       preserved in finalText (the marker stays visible for honesty).
 *   (b) marker-only final, then a clean recovery turn -> "completed" (the
 *       degenerate turn is retried, not recorded; the recovery is the result).
 *   (c) substantive truncated final (real text >= 200 chars + marker) ->
 *       "completed" (a real, if truncated, deliverable; the marker stays
 *       visible in the result).
 *   (d) clean final (no marker) -> "completed", unaffected (no false positive).
 *   (e) marker + small text BUT a tool call this turn -> NOT degenerate (a
 *       tool call is real output); the turn is recorded and the session
 *       completes.
 *   (f) marker + small text in a LONG session (turnsTaken > max) -> NOT
 *       degenerate (the session did real work); "completed".
 *
 * No vLLM, no network. The LLM provider and event logger are injected via the
 * runner's constructor seams (this._llm / this._logger).
 *
 * Run: node tests/degenerate_final.test.js
 */

import assert from "node:assert";

// Set the budgets BEFORE importing the runner so the config module picks them
// up at load time.
process.env.QWEN_EMPTY_STREAM_RETRIES = "2";
process.env.QWEN_DEGENERATE_FINAL_SUBSTANTIVE_CHARS = "200";
process.env.QWEN_DEGENERATE_FINAL_MAX_TURNS = "3";

const { AnserRunner } = await import("../src/harness/runner.js");
const {
  EMPTY_STREAM_RETRIES,
  DEGENERATE_FINAL_SUBSTANTIVE_CHARS,
  DEGENERATE_FINAL_MAX_TURNS,
} = await import("../src/config.js");
const { GUARD_MARKER_TEMPLATE } = await import("../src/repetition_detector.js");

// ---------------------------------------------------------------------------
// Build the exact guard marker the stream proxy emits (single source of
// truth). The breaker interpolates the detected repetition type + pattern.
// ---------------------------------------------------------------------------
function buildMarker(type = "character", pattern = "a") {
  return GUARD_MARKER_TEMPLATE
    .replaceAll("${type}", type)
    .replaceAll("${pattern}", JSON.stringify(pattern));
}

// A marker-only final: the ENTIRE message is just the guard marker.
const MARKER_ONLY = buildMarker("character", "a");

// A substantive truncated final: real text (>= 200 chars) followed by the
// guard marker. The substantive remainder is well above the threshold.
const SUBSTANTIVE_TEXT =
  "Here is the complete analysis of the codebase. The module structure is " +
  "sound, the error handling is robust, and the test coverage is comprehensive. " +
  "All edge cases are handled correctly, and the performance characteristics " +
  "meet the requirements for production deployment at scale.";
const SUBSTANTIVE_TRUNCATED = SUBSTANTIVE_TEXT + buildMarker("pattern", "the the ");

// A clean final: no marker at all.
const CLEAN_FINAL =
  "All done. The task is complete and the deliverable is ready for review.";

// ---------------------------------------------------------------------------
// Mock LLM: returns a scripted sequence of turn results.
// ---------------------------------------------------------------------------
function makeMockLlm(script) {
  let call = 0;
  return {
    _calls: 0,
    _lastMessages: null,
    async streamChat({ messages } = {}) {
      this._calls++;
      this._lastMessages = messages ? [...messages] : null;
      const step = script[Math.min(call, script.length - 1)];
      call++;
      const metrics = {
        promptTokens: 0,
        completionTokens: (step.content || "").length,
        ttftMs: 1,
        totalMs: 1,
        tokensPerSec: 0,
        hadReasoning: step.hadReasoning ?? false,
      };
      const hasFinishReason = Object.prototype.hasOwnProperty.call(
        step,
        "finishReason"
      );
      return {
        content: step.content ?? "",
        toolCalls: step.toolCalls ?? [],
        finishReason: hasFinishReason ? step.finishReason : "stop",
        hadReasoning: step.hadReasoning ?? false,
        metrics,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// In-memory mock logger (same surface the runner uses).
// ---------------------------------------------------------------------------
function makeMockLogger() {
  const events = [];
  return {
    events,
    append(event) {
      const entry = { timestamp: new Date().toISOString(), ...event };
      events.push(entry);
      return entry;
    },
    readAll() {
      return events;
    },
    getConversationHistory() {
      return [];
    },
  };
}

function countType(logger, type) {
  return logger.events.filter((e) => e.type === type).length;
}

function degenerateRetries(logger) {
  return logger.events.filter(
    (e) => e.type === "empty_stream_retry" && e.reason === "degenerate_final"
  );
}

// A tool call to a REAL registered tool (read_file) with a non-existent path.
// executeTool's try/catch converts the ENOENT throw into an {isError:true}
// result (never propagates), so the turn cleanly "has tool calls" and the
// session continues. This is enough to make a turn non-degenerate (a tool
// call is real output).
function makeToolCall(id) {
  return {
    id,
    type: "function",
    function: {
      name: "read_file",
      arguments: JSON.stringify({ path: "__degenerate_final_test_nonexistent__" }),
    },
  };
}

// ---------------------------------------------------------------------------
// Vector (a): marker-only final, ALWAYS degenerate -> retries then the honest
// status "degenerate_response_truncated" with the original partial+marker
// preserved in finalText.
// ---------------------------------------------------------------------------
async function vectorA() {
  const llm = makeMockLlm([
    // Always the same marker-only "stop" turn (the M3a false-success shape).
    { content: MARKER_ONLY, toolCalls: [], finishReason: "stop" },
  ]);
  const logger = makeMockLogger();
  const runner = new AnserRunner({ llm, logger });

  const res = await runner.run({
    prompt: "Do the thing.",
    sessionId: "test_a",
    maxTurns: 1000, // high so the retry bound, not maxTurns, governs
  });

  assert.strictEqual(
    res.status,
    "degenerate_response_truncated",
    "a: status must be degenerate_response_truncated (honest failure), NOT a false 'completed'"
  );
  // The retry budget was consumed: exactly EMPTY_STREAM_RETRIES degenerate
  // retries (the empty-stream path, reason "degenerate_final").
  assert.strictEqual(
    degenerateRetries(logger).length,
    EMPTY_STREAM_RETRIES,
    "a: exactly EMPTY_STREAM_RETRIES degenerate_final retries"
  );
  // Bounded: turns = bound + 1 (the final turn that hits the bound and breaks).
  assert.ok(
    res.turnsTaken <= EMPTY_STREAM_RETRIES + 1,
    "a: turn count bounded by the empty-stream retry bound"
  );
  // HONESTY: finalText preserves the original partial+marker (the client sees
  // exactly what the engine produced, including the guard marker).
  assert.ok(
    res.finalText.includes("[StreamProxy Guard: Runaway repetition loop"),
    "a: finalText preserves the guard marker (honesty)"
  );
  assert.strictEqual(
    res.finalText,
    MARKER_ONLY,
    "a: finalText is the original marker-only content, verbatim"
  );
  // A degenerate turn is never recorded as an assistant message.
  assert.strictEqual(
    countType(logger, "assistant_message"),
    0,
    "a: no assistant_message recorded for degenerate finals"
  );
  console.log(
    `  [PASS] (a) marker-only final -> ${EMPTY_STREAM_RETRIES} degenerate_final retries then 'degenerate_response_truncated' (marker preserved, ${res.turnsTaken} turns)`
  );
}

// ---------------------------------------------------------------------------
// Vector (b): marker-only final, then a clean recovery turn -> "completed".
// The degenerate turn is retried (not recorded); the recovery is the result.
// ---------------------------------------------------------------------------
async function vectorB() {
  const llm = makeMockLlm([
    { content: MARKER_ONLY, toolCalls: [], finishReason: "stop" },
    { content: "Recovered after the degenerate final.", finishReason: "stop" },
  ]);
  const logger = makeMockLogger();
  const runner = new AnserRunner({ llm, logger });

  const res = await runner.run({
    prompt: "Do the thing.",
    sessionId: "test_b",
    maxTurns: 10,
  });

  assert.strictEqual(res.status, "completed", "b: status should be completed");
  assert.strictEqual(
    res.finalText,
    "Recovered after the degenerate final.",
    "b: finalText is the recovered content, NOT the marker"
  );
  // The degenerate turn was retried (not recorded as an assistant message).
  assert.strictEqual(
    degenerateRetries(logger).length,
    1,
    "b: exactly one degenerate_final retry"
  );
  assert.strictEqual(
    countType(logger, "assistant_message"),
    1,
    "b: exactly ONE assistant_message (the recovery, not the degenerate turn)"
  );
  assert.strictEqual(
    llm._calls,
    2,
    "b: LLM called exactly twice (degenerate + recovery)"
  );
  console.log("  [PASS] (b) marker-only then recovery -> 'completed', degenerate turn retried not recorded");
}

// ---------------------------------------------------------------------------
// Vector (c): substantive truncated final (real text >= 200 chars + marker)
// -> "completed" (a real, if truncated, deliverable; the marker stays visible
// in the result).
// ---------------------------------------------------------------------------
async function vectorC() {
  const llm = makeMockLlm([
    {
      content: SUBSTANTIVE_TRUNCATED,
      toolCalls: [],
      finishReason: "stop",
    },
  ]);
  const logger = makeMockLogger();
  const runner = new AnserRunner({ llm, logger });

  const res = await runner.run({
    prompt: "Write a long report.",
    sessionId: "test_c",
    maxTurns: 10,
  });

  assert.strictEqual(
    res.status,
    "completed",
    "c: a substantive (>=200 char) truncated final must be 'completed', NOT degenerate"
  );
  // No degenerate retry: the substantive remainder is above the threshold.
  assert.strictEqual(
    degenerateRetries(logger).length,
    0,
    "c: no degenerate_final retry for a substantive final"
  );
  // The deliverable is preserved, INCLUDING the visible guard marker.
  assert.ok(
    res.finalText.includes(SUBSTANTIVE_TEXT),
    "c: finalText contains the substantive deliverable"
  );
  assert.ok(
    res.finalText.includes("[StreamProxy Guard: Runaway repetition loop"),
    "c: the guard marker stays visible in the result"
  );
  // The substantive final IS recorded as an assistant message.
  assert.strictEqual(
    countType(logger, "assistant_message"),
    1,
    "c: the substantive final is recorded as an assistant message"
  );
  console.log("  [PASS] (c) substantive truncated final (>=200 chars + marker) -> 'completed', marker visible");
}

// ---------------------------------------------------------------------------
// Vector (d): clean final (no marker) -> "completed", unaffected (no false
// positive from the guard).
// ---------------------------------------------------------------------------
async function vectorD() {
  const llm = makeMockLlm([
    { content: CLEAN_FINAL, toolCalls: [], finishReason: "stop" },
  ]);
  const logger = makeMockLogger();
  const runner = new AnserRunner({ llm, logger });

  const res = await runner.run({
    prompt: "Quick task.",
    sessionId: "test_d",
    maxTurns: 10,
  });

  assert.strictEqual(res.status, "completed", "d: status completed");
  assert.strictEqual(res.turnsTaken, 1, "d: exactly one turn (immediate break)");
  assert.strictEqual(
    res.finalText,
    CLEAN_FINAL,
    "d: finalText is the clean content, verbatim"
  );
  assert.strictEqual(
    degenerateRetries(logger).length,
    0,
    "d: no degenerate retry for a clean final"
  );
  assert.strictEqual(
    countType(logger, "empty_stream_retry"),
    0,
    "d: no empty_stream_retry of any kind for a clean final"
  );
  console.log("  [PASS] (d) clean final (no marker) -> 'completed', unaffected");
}

// ---------------------------------------------------------------------------
// Vector (e): marker + small text BUT a tool call this turn -> NOT degenerate
// (a tool call is real output). The turn is recorded and the session
// completes.
// ---------------------------------------------------------------------------
async function vectorE() {
  const smallText = "Starting the work.";
  const llm = makeMockLlm([
    {
      content: smallText + buildMarker("character", "a"),
      toolCalls: [makeToolCall("call_e1")],
      finishReason: "stop",
    },
    { content: "Done after the tool call.", finishReason: "stop" },
  ]);
  const logger = makeMockLogger();
  const runner = new AnserRunner({ llm, logger });

  const res = await runner.run({
    prompt: "Use a tool.",
    sessionId: "test_e",
    maxTurns: 10,
  });

  assert.strictEqual(
    res.status,
    "completed",
    "e: a marker final WITH a tool call must be 'completed', NOT degenerate"
  );
  // A tool call is real output -> the turn is NOT degenerate (no retry).
  assert.strictEqual(
    degenerateRetries(logger).length,
    0,
    "e: no degenerate_final retry when the turn has a tool call"
  );
  // The marker+tool-call turn IS recorded as an assistant message.
  const assistantMsgs = logger.events.filter((e) => e.type === "assistant_message");
  assert.ok(
    assistantMsgs.length >= 1,
    "e: the marker+tool-call turn is recorded as an assistant message"
  );
  console.log("  [PASS] (e) marker + small text WITH a tool call -> NOT degenerate, 'completed'");
}

// ---------------------------------------------------------------------------
// Vector (f): marker + small text in a LONG session (turnsTaken > max) -> NOT
// degenerate (the session did real work); "completed".
// ---------------------------------------------------------------------------
async function vectorF() {
  const smallText = "Continuing the long task.";
  // Three tool-call turns (each continues the loop) push turnsTaken to 3,
  // then the marker final lands on turn 4 (> DEGENERATE_FINAL_MAX_TURNS=3).
  const llm = makeMockLlm([
    { content: "", toolCalls: [makeToolCall("call_f1")], finishReason: "stop" },
    { content: "", toolCalls: [makeToolCall("call_f2")], finishReason: "stop" },
    { content: "", toolCalls: [makeToolCall("call_f3")], finishReason: "stop" },
    {
      content: smallText + buildMarker("character", "a"),
      toolCalls: [],
      finishReason: "stop",
    },
  ]);
  const logger = makeMockLogger();
  const runner = new AnserRunner({ llm, logger });

  const res = await runner.run({
    prompt: "Long task.",
    sessionId: "test_f",
    maxTurns: 100,
  });

  assert.strictEqual(
    res.status,
    "completed",
    "f: a marker final in a LONG session (turnsTaken > max) must be 'completed', NOT degenerate"
  );
  // The session ran long enough that the final is NOT "short".
  assert.ok(
    res.turnsTaken > DEGENERATE_FINAL_MAX_TURNS,
    `f: turnsTaken (${res.turnsTaken}) must exceed DEGENERATE_FINAL_MAX_TURNS (${DEGENERATE_FINAL_MAX_TURNS})`
  );
  // Not degenerate -> no degenerate retry.
  assert.strictEqual(
    degenerateRetries(logger).length,
    0,
    "f: no degenerate_final retry in a long session"
  );
  console.log(
    `  [PASS] (f) marker final in a long session (${res.turnsTaken} turns > ${DEGENERATE_FINAL_MAX_TURNS}) -> 'completed', NOT degenerate`
  );
}

// ---------------------------------------------------------------------------
// Run all vectors.
// ---------------------------------------------------------------------------
async function main() {
  console.log("=== M3b Degenerate-Final Guard Verification (offline) ===");
  console.log(`EMPTY_STREAM_RETRIES = ${EMPTY_STREAM_RETRIES}`);
  console.log(`DEGENERATE_FINAL_SUBSTANTIVE_CHARS = ${DEGENERATE_FINAL_SUBSTANTIVE_CHARS}`);
  console.log(`DEGENERATE_FINAL_MAX_TURNS = ${DEGENERATE_FINAL_MAX_TURNS}`);
  console.log(`GUARD_MARKER (character:"a") = ${JSON.stringify(MARKER_ONLY)}\n`);

  let passed = 0;
  let failed = 0;
  const vectors = [
    ["(a)", vectorA],
    ["(b)", vectorB],
    ["(c)", vectorC],
    ["(d)", vectorD],
    ["(e)", vectorE],
    ["(f)", vectorF],
  ];

  for (const [label, fn] of vectors) {
    try {
      await fn();
      passed++;
    } catch (err) {
      failed++;
      console.error(`  [FAIL] ${label}: ${err.message}`);
    }
  }

  console.log("\n==========================================");
  console.log(`Degenerate-Final Guard: ${passed} PASSED, ${failed} FAILED`);
  console.log("==========================================");
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Degenerate-final test uncaught error:", err);
  process.exit(1);
});
