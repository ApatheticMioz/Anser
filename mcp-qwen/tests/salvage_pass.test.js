/**
 * E2: Salvage Pass on Deliberation-Budget Exhaustion (F6.3)
 *
 * Proves that when the reasoning budget is exhausted, the runner fires ONE
 * bounded extraction turn (tools disabled, low reasoning effort, minimal
 * message set) to salvage the model's accumulated partial findings to
 * `.scratch/salvage_<sessionId>.md`, while preserving the honest
 * `reasoning_budget_exhausted` status.
 *
 * Vectors:
 *   (a) consecutive reasoning cutoffs > 1 -> salvage fires, file written,
 *       status remains reasoning_budget_exhausted, salvage_extracted event
 *   (b) salvage LLM throws -> salvage_failed logged, honest status, no crash
 *   (c) salvage LLM returns empty -> salvage_empty logged, honest status
 *   (d) SALVAGE_DIRECTIVE is non-coercive (prompt_integrity family)
 *   (e) salvage is a terminal extraction, not a continuation retry
 *
 * No vLLM, no network. The LLM provider and event logger are injected via
 * the runner's constructor seams.
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

// Set the continuation budget BEFORE importing the runner so the config
// module picks it up at load time.
process.env.QWEN_MAX_CONTINUATION_TURNS = "3";
process.env.QWEN_EMPTY_STREAM_RETRIES = "2";

const {
  AnserRunner,
  SALVAGE_DIRECTIVE,
} = await import("../src/harness/runner.js");

// ---------------------------------------------------------------------------
// Mock LLM: returns a scripted sequence of turn results.
// ---------------------------------------------------------------------------
function makeMockLlm(script) {
  let call = 0;
  return {
    _calls: 0,
    _lastMessages: null,
    _lastParams: null,
    async streamChat(params = {}) {
      this._calls++;
      this._lastMessages = params.messages ? [...params.messages] : null;
      this._lastParams = { ...params };
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
// In-memory mock logger.
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

// ---------------------------------------------------------------------------
// Vector (a): consecutive reasoning cutoffs > 1 -> salvage fires.
//
// Script:
//   Turn 1: reasoning cutoff (hadReasoning, empty content, finish "length")
//           -> continuation 1 injected (balanced_landing)
//   Turn 2: reasoning cutoff again -> consecutive = 2 > 1 -> EXHAUSTED
//           -> salvage fires (one extra streamChat call with tools: [])
//           -> status = reasoning_budget_exhausted
//
// The mock LLM script has 2 "normal" turns + 1 salvage turn.
// The salvage turn is the 3rd call; it returns non-empty content.
// ---------------------------------------------------------------------------
async function vectorA() {
  const salvageContent =
    "## Partial Findings\n\n- Root cause identified: the continuation loop\n" +
    "- Table of test results (partial):\n  | Test | Status |\n  |---|---|\n  | a | pass |\n" +
    "- Incomplete: need to verify edge case B\n";

  const llm = makeMockLlm([
    // Turn 1: reasoning cutoff
    { content: "", toolCalls: [], finishReason: "length", hadReasoning: true },
    // Turn 2: reasoning cutoff again -> consecutive = 2 -> EXHAUSTED
    { content: "", toolCalls: [], finishReason: "length", hadReasoning: true },
    // Turn 3 (salvage): non-empty content
    { content: salvageContent, toolCalls: [], finishReason: "stop", hadReasoning: false },
  ]);
  const logger = makeMockLogger();
  const runner = new AnserRunner({ llm, logger });

  const res = await runner.run({
    prompt: "Think deeply and exhaust the budget.",
    sessionId: "salvage_a",
    maxTurns: 10,
  });

  // Status must remain honest.
  assert.strictEqual(
    res.status,
    "reasoning_budget_exhausted",
    "a: status must be reasoning_budget_exhausted"
  );
  assert.ok(
    res.finalText.includes("ReasoningBudgetExhaustedError"),
    "a: finalText contains the diagnostic error name"
  );

  // The salvage file path must be appended to finalText.
  assert.ok(
    res.finalText.includes("[Salvage] Partial findings saved to:"),
    "a: finalText includes the salvage path annotation"
  );
  assert.ok(
    res.finalText.includes("salvage_salvage_a.md"),
    "a: salvage path names the session"
  );

  // Exactly one salvage_extracted event.
  assert.strictEqual(
    countType(logger, "salvage_extracted"),
    1,
    "a: exactly one salvage_extracted event"
  );
  const salvageEvent = logger.events.find((e) => e.type === "salvage_extracted");
  assert.ok(
    salvageEvent.path.includes("salvage_salvage_a.md"),
    "a: salvage_extracted event carries the correct path"
  );
  assert.ok(
    salvageEvent.bytes > 0,
    "a: salvage_extracted event carries a positive byte count"
  );

  // The salvage streamChat call must have tools: [] and reasoningEffort: "low".
  assert.strictEqual(
    llm._calls,
    3,
    "a: exactly 3 LLM calls (2 reasoning cutoffs + 1 salvage)"
  );
  assert.deepStrictEqual(
    llm._lastParams.tools,
    [],
    "a: salvage call has tools disabled"
  );
  assert.strictEqual(
    llm._lastParams.reasoningEffort,
    "low",
    "a: salvage call uses low reasoning effort"
  );

  // The salvage directive must be the last user message in the salvage call.
  const lastMsg = llm._lastMessages[llm._lastMessages.length - 1];
  assert.strictEqual(
    lastMsg.role,
    "user",
    "a: last message in salvage call is user-role"
  );
  assert.ok(
    lastMsg.content.includes("salvage_salvage_a.md"),
    "a: salvage directive names the session-specific path"
  );
  assert.ok(
    lastMsg.content.includes("Do not reason further"),
    "a: salvage directive instructs not to reason further"
  );

  // The salvage file must exist on disk with the expected content.
  const scratchDir = path.join(process.cwd(), ".scratch");
  const salvageFile = path.join(scratchDir, "salvage_salvage_a.md");
  assert.ok(
    fs.existsSync(salvageFile),
    "a: salvage file exists on disk"
  );
  const fileContent = fs.readFileSync(salvageFile, "utf8");
  assert.ok(
    fileContent.includes("Partial Findings"),
    "a: salvage file contains the model's findings"
  );
  // Clean up.
  fs.rmSync(salvageFile, { force: true });

  console.log(
    "  [PASS] (a) consecutive reasoning cutoffs -> salvage fires, file written, honest status preserved"
  );
}

// ---------------------------------------------------------------------------
// Vector (b): salvage LLM throws -> salvage_failed logged, honest status.
// ---------------------------------------------------------------------------
async function vectorB() {
  const llm = makeMockLlm([
    // Turn 1: reasoning cutoff
    { content: "", toolCalls: [], finishReason: "length", hadReasoning: true },
    // Turn 2: reasoning cutoff again -> EXHAUSTED
    { content: "", toolCalls: [], finishReason: "length", hadReasoning: true },
    // Turn 3 (salvage): will be overridden to throw
    { content: "", toolCalls: [], finishReason: "stop", hadReasoning: false },
  ]);

  // Override the mock to throw on the 3rd call (the salvage call).
  const originalStreamChat = llm.streamChat.bind(llm);
  llm.streamChat = async (params) => {
    if (llm._calls === 2) {
      throw new Error("Salvage LLM exploded");
    }
    return originalStreamChat(params);
  };

  const logger = makeMockLogger();
  const runner = new AnserRunner({ llm, logger });

  const res = await runner.run({
    prompt: "Think deeply and exhaust the budget (salvage throws).",
    sessionId: "salvage_b",
    maxTurns: 10,
  });

  // Status must remain honest despite the salvage failure.
  assert.strictEqual(
    res.status,
    "reasoning_budget_exhausted",
    "b: status must be reasoning_budget_exhausted even when salvage throws"
  );
  assert.ok(
    res.finalText.includes("ReasoningBudgetExhaustedError"),
    "b: finalText contains the diagnostic error name"
  );
  // No salvage path annotation (salvage failed).
  assert.ok(
    !res.finalText.includes("[Salvage]"),
    "b: no salvage annotation when salvage fails"
  );

  // salvage_failed event must be logged.
  assert.strictEqual(
    countType(logger, "salvage_failed"),
    1,
    "b: exactly one salvage_failed event"
  );
  const failEvent = logger.events.find((e) => e.type === "salvage_failed");
  assert.ok(
    failEvent.error.includes("Salvage LLM exploded"),
    "b: salvage_failed event carries the error message"
  );

  // No salvage_extracted event.
  assert.strictEqual(
    countType(logger, "salvage_extracted"),
    0,
    "b: no salvage_extracted event when salvage throws"
  );

  console.log(
    "  [PASS] (b) salvage LLM throws -> salvage_failed logged, honest status preserved, no crash"
  );
}

// ---------------------------------------------------------------------------
// Vector (c): salvage LLM returns empty -> salvage_empty logged, honest status.
// ---------------------------------------------------------------------------
async function vectorC() {
  const llm = makeMockLlm([
    // Turn 1: reasoning cutoff
    { content: "", toolCalls: [], finishReason: "length", hadReasoning: true },
    // Turn 2: reasoning cutoff again -> EXHAUSTED
    { content: "", toolCalls: [], finishReason: "length", hadReasoning: true },
    // Turn 3 (salvage): returns empty content
    { content: "", toolCalls: [], finishReason: "stop", hadReasoning: false },
  ]);
  const logger = makeMockLogger();
  const runner = new AnserRunner({ llm, logger });

  const res = await runner.run({
    prompt: "Think deeply and exhaust the budget (salvage empty).",
    sessionId: "salvage_c",
    maxTurns: 10,
  });

  assert.strictEqual(
    res.status,
    "reasoning_budget_exhausted",
    "c: status must be reasoning_budget_exhausted"
  );
  assert.ok(
    !res.finalText.includes("[Salvage]"),
    "c: no salvage annotation when salvage returns empty"
  );

  assert.strictEqual(
    countType(logger, "salvage_empty"),
    1,
    "c: exactly one salvage_empty event"
  );
  assert.strictEqual(
    countType(logger, "salvage_extracted"),
    0,
    "c: no salvage_extracted event"
  );

  console.log(
    "  [PASS] (c) salvage returns empty -> salvage_empty logged, honest status preserved"
  );
}

// ---------------------------------------------------------------------------
// Vector (d): SALVAGE_DIRECTIVE is non-coercive (prompt_integrity family).
// ---------------------------------------------------------------------------
async function vectorD() {
  // The salvage directive must NOT contain coercive language.
  assert.ok(
    !SALVAGE_DIRECTIVE.includes("Conclude your thinking immediately"),
    "d: must not violently command immediate conclusion"
  );
  assert.ok(
    !SALVAGE_DIRECTIVE.includes("Emit your next concrete empirical action"),
    "d: must not coerce forced tool execution"
  );
  assert.ok(
    !SALVAGE_DIRECTIVE.includes("You MUST"),
    "d: must not use imperative MUST"
  );
  assert.ok(
    !SALVAGE_DIRECTIVE.includes("IMMEDIATELY"),
    "d: must not use ALL-CAPS urgency"
  );

  // It MUST be a request, not a command.
  assert.ok(
    SALVAGE_DIRECTIVE.includes("Do not reason further"),
    "d: must instruct not to reason further"
  );
  assert.ok(
    SALVAGE_DIRECTIVE.includes("record the findings"),
    "d: must ask to record findings"
  );
  assert.ok(
    SALVAGE_DIRECTIVE.includes("state what remains incomplete"),
    "d: must ask to state what remains incomplete"
  );
  assert.ok(
    SALVAGE_DIRECTIVE.includes("best-effort"),
    "d: must frame as best-effort"
  );

  console.log(
    "  [PASS] (d) SALVAGE_DIRECTIVE is non-coercive (prompt_integrity family)"
  );
}

// ---------------------------------------------------------------------------
// Vector (e): the salvage call does NOT reset consecutiveReasoningContinuations
// or inject a continuation. It is a terminal extraction, not a retry.
// ---------------------------------------------------------------------------
async function vectorE() {
  const salvageContent = "Partial findings: the root cause is X.";
  const llm = makeMockLlm([
    { content: "", toolCalls: [], finishReason: "length", hadReasoning: true },
    { content: "", toolCalls: [], finishReason: "length", hadReasoning: true },
    { content: salvageContent, toolCalls: [], finishReason: "stop", hadReasoning: false },
  ]);
  const logger = makeMockLogger();
  const runner = new AnserRunner({ llm, logger });

  const res = await runner.run({
    prompt: "Think deeply.",
    sessionId: "salvage_e",
    maxTurns: 10,
  });

  // The salvage must NOT have injected a continuation.
  const contEvents = logger.events.filter((e) => e.type === "continuation_injected");
  // Only 1 continuation was injected (after turn 1). The salvage is NOT a continuation.
  assert.strictEqual(
    contEvents.length,
    1,
    "e: exactly 1 continuation_injected (the salvage is NOT a continuation)"
  );

  // The session must have terminated (not continued looping).
  assert.strictEqual(
    res.status,
    "reasoning_budget_exhausted",
    "e: status is reasoning_budget_exhausted (terminal)"
  );

  // Clean up the salvage file.
  const salvageFile = path.join(process.cwd(), ".scratch", "salvage_salvage_e.md");
  fs.rmSync(salvageFile, { force: true });

  console.log(
    "  [PASS] (e) salvage is a terminal extraction, not a continuation retry"
  );
}

// ---------------------------------------------------------------------------
// Run all vectors.
// ---------------------------------------------------------------------------
async function main() {
  console.log("=== E2: Salvage Pass on Deliberation-Budget Exhaustion (F6.3) ===\n");

  let passed = 0;
  let failed = 0;
  const vectors = [
    ["(a)", vectorA],
    ["(b)", vectorB],
    ["(c)", vectorC],
    ["(d)", vectorD],
    ["(e)", vectorE],
  ];

  for (const [label, fn] of vectors) {
    try {
      await fn();
      passed++;
    } catch (err) {
      failed++;
      console.error(`  [FAIL] ${label}: ${err.message}`);
      if (err.stack) console.error(err.stack);
    }
  }

  console.log(`\n==========================================================================`);
  console.log(`Salvage Pass Verification: ${passed} / ${vectors.length} vectors passed`);
  if (failed > 0) {
    console.log(`Verdict: ${failed} VECTOR(S) FAILED.`);
    process.exit(1);
  }
  console.log(`Verdict: ALL SALVAGE VECTORS PASSED.`);
  console.log(`==========================================================================`);
  process.exit(0);
}

main().catch((e) => {
  console.error("HARNESS FAILURE:", e);
  process.exit(1);
});
