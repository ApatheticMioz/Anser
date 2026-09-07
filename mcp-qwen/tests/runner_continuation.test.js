/**
 * Runner Continuation-on-Cutoff Verification (fully OFFLINE)
 *
 * Proves the Anser runner is honest about and resilient to
 * output-ceiling truncation (finish_reason: "length"):
 *   (a) "length" twice then "stop"  -> completed, 2 continuations, finishReason logged
 *   (b) "length" always             -> terminates at the MAX_CONTINUATION_TURNS cap
 *   (c) "length" + invalid-JSON tool call -> call dropped, never executed, continuation injected
 *   (d) happy path "stop" + no tool calls -> breaks immediately, zero continuations
 *   (e) empty generation (no content, no tool calls, no real finish_reason)
 *       then a normal stop-with-content turn -> completed, empty turn absent
 *       from history, retry counted
 *   (f) always-empty generations    -> terminates at the EMPTY_STREAM_RETRIES
 *       bound with honest status "engine_empty_response"
 *   (g) empty-STOP turn (finish "stop", zero content, zero tool calls) then a
 *       normal stop-with-content turn -> retried via the P2b path with reason
 *       "empty_stop", session completes
 *   (h) reasoning-only length cutoff (metrics.hadReasoning) -> continuation
 *       injects the REASONING_LANDING_DIRECTIVE ("reasoning_landing"), not the
 *       generic resume directive
 *
 * No vLLM, no network. The LLM provider and event logger are injected via the
 * runner's constructor seams (this._llm / this._logger).
 */

import assert from "node:assert";

// Set the continuation + empty-stream budgets BEFORE importing the runner so
// the config module picks them up at load time.
process.env.QWEN_MAX_CONTINUATION_TURNS = "3";
process.env.QWEN_EMPTY_STREAM_RETRIES = "2";

const { AnserRunner, CONTINUATION_DIRECTIVE } =
  await import("../src/harness/runner.js");
const { MAX_CONTINUATION_TURNS, EMPTY_STREAM_RETRIES } = await import(
  "../src/config.js"
);

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
      // Snapshot: `messages` is a live array the runner keeps mutating, so a
      // bare reference would show post-call state (aliasing).
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
      // If the step explicitly carries a "finishReason" key (even if it is
      // undefined), honor it verbatim - this models an aborted/zero-byte
      // stream that produced NO real finish_reason frame. Otherwise default
      // to "stop" (the provider's default-fill for a clean turn).
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
// In-memory mock logger (same surface the runner uses: append / readAll /
// getConversationHistory).
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
      return []; // fresh session, no prior history
    },
  };
}

function countType(logger, type) {
  return logger.events.filter((e) => e.type === type).length;
}

// ---------------------------------------------------------------------------
// Vector (a): "length" twice (partial content) then "stop" with final text.
// ---------------------------------------------------------------------------
async function vectorA() {
  const llm = makeMockLlm([
    { content: "Part one of the answer. ", finishReason: "length" },
    { content: "Part two continues here. ", finishReason: "length" },
    { content: "Part three concludes it.", finishReason: "stop" },
  ]);
  const logger = makeMockLogger();
  const runner = new AnserRunner({ llm, logger });

  const res = await runner.run({
    prompt: "Write a three-part answer.",
    sessionId: "test_a",
    maxTurns: 10,
  });

  assert.strictEqual(res.status, "completed", "a: status should be completed");
  assert.ok(
    res.finalText.includes("Part three concludes it."),
    "a: finalText should contain the last (stop) content"
  );
  assert.strictEqual(
    countType(logger, "continuation_injected"),
    2,
    "a: exactly 2 continuation_injected entries"
  );
  // Every assistant_message entry must carry a finishReason.
  const assistantMsgs = logger.events.filter((e) => e.type === "assistant_message");
  assert.ok(assistantMsgs.length >= 3, "a: at least 3 assistant messages");
  for (const m of assistantMsgs) {
    assert.ok("finishReason" in m, "a: assistant_message must carry finishReason");
  }
  // The continuation directive must have been pushed as a user message.
  assert.ok(
    llm._calls === 3,
    "a: mock LLM called exactly 3 times"
  );
  console.log("  [PASS] (a) length x2 then stop -> completed, 2 continuations, finishReason logged");
}

// ---------------------------------------------------------------------------
// Vector (b): "length" ALWAYS -> terminates at the continuation cap.
// ---------------------------------------------------------------------------
async function vectorB() {
  const llm = makeMockLlm([
    { content: "truncated...", finishReason: "length" },
  ]); // always returns the same "length" turn
  const logger = makeMockLogger();
  const runner = new AnserRunner({ llm, logger });

  const res = await runner.run({
    prompt: "Keep going forever.",
    sessionId: "test_b",
    maxTurns: 1000, // high so the cap, not maxTurns, governs
  });

  assert.strictEqual(
    res.status,
    "length_limit_reached",
    "b: status should be length_limit_reached"
  );
  assert.strictEqual(
    countType(logger, "continuation_injected"),
    MAX_CONTINUATION_TURNS,
    "b: exactly MAX_CONTINUATION_TURNS continuations injected"
  );
  // Bounded: turns = cap + 1 (the final turn that hits the cap and breaks).
  assert.ok(
    res.turnsTaken <= MAX_CONTINUATION_TURNS + 1,
    "b: turn count must be bounded by the continuation cap"
  );
  console.log(
    `  [PASS] (b) always-length -> length_limit_reached at cap (${res.turnsTaken} turns, ${MAX_CONTINUATION_TURNS} continuations)`
  );
}

// ---------------------------------------------------------------------------
// Vector (c): "length" + one tool call with INVALID JSON args.
// ---------------------------------------------------------------------------
async function vectorC() {
  const badToolCall = {
    id: "call_bad_1",
    type: "function",
    function: {
      name: "ast_search",
      arguments: '{"path": "src/', // truncated, invalid JSON
    },
  };
  const llm = makeMockLlm([
    { content: "", toolCalls: [badToolCall], finishReason: "length" },
    { content: "Done after re-emitting.", finishReason: "stop" },
  ]);
  const logger = makeMockLogger();
  const runner = new AnserRunner({ llm, logger });

  const res = await runner.run({
    prompt: "Search the code.",
    sessionId: "test_c",
    maxTurns: 10,
  });

  // The mangled call must have been dropped, never executed.
  const dropped = logger.events.filter((e) => e.type === "tool_call_dropped");
  assert.strictEqual(dropped.length, 1, "c: exactly one tool_call_dropped entry");
  assert.strictEqual(dropped[0].toolCallId, "call_bad_1", "c: dropped the right call");
  // No tool_result for the dropped call => executeTool was never invoked.
  const resultsForCall = logger.events.filter(
    (e) => e.type === "tool_result" && e.toolCallId === "call_bad_1"
  );
  assert.strictEqual(
    resultsForCall.length,
    0,
    "c: executeTool was NEVER invoked for the truncated call"
  );
  // A continuation was injected because the turn was "length" with a dropped call.
  assert.ok(
    countType(logger, "continuation_injected") >= 1,
    "c: a continuation was injected after the dropped call"
  );
  // Verify that the assistant message's malformed tool_call was sanitized to "{}"
  // so downstream vLLM parsers do not throw JSONDecodeError on turn 2
  const assistantMsgWithToolCall = llm._lastMessages.find(
    (m) => m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0
  );
  assert.ok(assistantMsgWithToolCall, "c: assistant message with tool calls preserved in history");
  assert.strictEqual(
    assistantMsgWithToolCall.tool_calls[0].function.arguments,
    "{}",
    "c: truncated tool call arguments sanitized to '{}' in history"
  );

  // Session still completes once the model re-emits cleanly.
  assert.strictEqual(res.status, "completed", "c: session completes after re-emit");
  console.log("  [PASS] (c) length + invalid-JSON tool call -> dropped, arguments sanitized to '{}', continuation injected");
}

// ---------------------------------------------------------------------------
// Vector (d): happy path - "stop" + empty toolCalls -> immediate break.
// ---------------------------------------------------------------------------
async function vectorD() {
  const llm = makeMockLlm([
    { content: "All done in one shot.", finishReason: "stop" },
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
    countType(logger, "continuation_injected"),
    0,
    "d: zero continuations injected on the happy path"
  );
  assert.strictEqual(llm._calls, 1, "d: LLM called exactly once");
  console.log("  [PASS] (d) happy path stop + no tool calls -> immediate break, 0 continuations");
}

// ---------------------------------------------------------------------------
// Vector (e): first turn is an EMPTY generation (no content, no tool calls,
// no real finish_reason -> undefined), then a normal stop-with-content turn.
// The empty turn must be retried (not recorded as an assistant message), and
// the session must complete with the real content.
// ---------------------------------------------------------------------------
async function vectorE() {
  const llm = makeMockLlm([
    // Aborted / zero-byte stream: no content, no tool calls, no finish_reason.
    { content: "", toolCalls: [], finishReason: undefined },
    // The retry succeeds with a real, clean stop turn.
    { content: "Recovered after the empty stream.", finishReason: "stop" },
  ]);
  const logger = makeMockLogger();
  const runner = new AnserRunner({ llm, logger });

  const res = await runner.run({
    prompt: "Do the thing.",
    sessionId: "test_e",
    maxTurns: 10,
  });

  assert.strictEqual(res.status, "completed", "e: status should be completed");
  assert.strictEqual(
    res.finalText,
    "Recovered after the empty stream.",
    "e: finalText should be the recovered content, not the empty turn"
  );
  // The empty turn must NOT have been recorded as an assistant message.
  const assistantMsgs = logger.events.filter((e) => e.type === "assistant_message");
  assert.strictEqual(
    assistantMsgs.length,
    1,
    "e: exactly ONE assistant_message (the empty turn was not recorded)"
  );
  assert.strictEqual(
    assistantMsgs[0].content,
    "Recovered after the empty stream.",
    "e: the recorded assistant message is the recovered one"
  );
  // The retry was counted.
  assert.strictEqual(
    countType(logger, "empty_stream_retry"),
    1,
    "e: exactly one empty_stream_retry entry"
  );
  // Two LLM calls total: the empty turn + the successful retry.
  assert.strictEqual(llm._calls, 2, "e: LLM called exactly twice (empty + retry)");
  console.log("  [PASS] (e) empty-then-stop -> completed, empty turn absent from history, retry counted");
}

// ---------------------------------------------------------------------------
// Vector (f): the engine ALWAYS returns empty generations (no content, no
// tool calls, no real finish_reason). The runner must terminate at the
// EMPTY_STREAM_RETRIES bound with the honest status "engine_empty_response".
// ---------------------------------------------------------------------------
async function vectorF() {
  const llm = makeMockLlm([
    // Always the same empty / no-finish_reason turn.
    { content: "", toolCalls: [], finishReason: undefined },
  ]);
  const logger = makeMockLogger();
  const runner = new AnserRunner({ llm, logger });

  const res = await runner.run({
    prompt: "Keep trying.",
    sessionId: "test_f",
    maxTurns: 1000, // high so the retry bound, not maxTurns, governs
  });

  assert.strictEqual(
    res.status,
    "engine_empty_response",
    "f: status should be engine_empty_response"
  );
  // No assistant message should ever be recorded for an empty generation.
  assert.strictEqual(
    countType(logger, "assistant_message"),
    0,
    "f: no assistant_message recorded for empty generations"
  );
  // The retry budget was exhausted: exactly EMPTY_STREAM_RETRIES retries.
  assert.strictEqual(
    countType(logger, "empty_stream_retry"),
    EMPTY_STREAM_RETRIES,
    "f: exactly EMPTY_STREAM_RETRIES empty_stream_retry entries"
  );
  // Bounded: turns = bound + 1 (the final turn that hits the bound and breaks).
  assert.ok(
    res.turnsTaken <= EMPTY_STREAM_RETRIES + 1,
    "f: turn count must be bounded by the empty-stream retry bound"
  );
  // No false finalText.
  assert.strictEqual(res.finalText, "", "f: finalText must remain empty");
  console.log(
    `  [PASS] (f) always-empty -> engine_empty_response at bound (${res.turnsTaken} turns, ${EMPTY_STREAM_RETRIES} retries)`
  );
}

// ---------------------------------------------------------------------------
// Vector (g): empty-STOP turn (finish "stop", zero content, zero tool calls -
// the classic reasoning-burned-the-whole-budget signature) then a normal
// stop-with-content turn. Must route through the P2b retry path with reason
// "empty_stop" and complete.
// ---------------------------------------------------------------------------
async function vectorG() {
  const llm = makeMockLlm([
    { content: "", toolCalls: [], finishReason: "stop", hadReasoning: true },
    { content: "Recovered after the empty stop.", finishReason: "stop" },
  ]);
  const logger = makeMockLogger();
  const runner = new AnserRunner({ llm, logger });

  const res = await runner.run({
    prompt: "Do the thing.",
    sessionId: "test_g",
    maxTurns: 10,
  });

  assert.strictEqual(res.status, "completed", "g: status should be completed");
  const retries = logger.events.filter((e) => e.type === "empty_stream_retry");
  assert.strictEqual(retries.length, 1, "g: exactly one empty_stream_retry");
  assert.strictEqual(retries[0].reason, "empty_stop", "g: reason must be empty_stop");
  assert.strictEqual(
    countType(logger, "continuation_injected"),
    0,
    "g: NOT a length cutoff -> no continuation"
  );
  assert.strictEqual(
    res.finalText,
    "Recovered after the empty stop.",
    "g: finalText is the recovered content"
  );
  console.log("  [PASS] (g) empty-stop -> retried via empty_stop reason, completed");
}

// ---------------------------------------------------------------------------
// Vector (h): reasoning-only length cutoff (metrics.hadReasoning=true, zero
// content) -> the continuation must inject clean CONTINUATION_DIRECTIVE and
// log directive "resume" with hadReasoning=true.
// ---------------------------------------------------------------------------
async function vectorH() {
  const llm = makeMockLlm([
    { content: "", toolCalls: [], finishReason: "length", hadReasoning: true },
    { content: "Landed with concrete output.", finishReason: "stop" },
  ]);
  const logger = makeMockLogger();
  const runner = new AnserRunner({ llm, logger });

  const res = await runner.run({
    prompt: "Think, then act.",
    sessionId: "test_h",
    maxTurns: 10,
  });

  assert.strictEqual(res.status, "completed", "h: status completed");
  const conts = logger.events.filter((e) => e.type === "continuation_injected");
  assert.strictEqual(conts.length, 1, "h: exactly one continuation");
  assert.strictEqual(
    conts[0].directive,
    "resume",
    "h: directive must be resume"
  );
  assert.strictEqual(
    conts[0].hadReasoning,
    true,
    "h: hadReasoning recorded in continuation event"
  );
  const lastMsg = llm._lastMessages?.[llm._lastMessages.length - 1];
  assert.strictEqual(
    lastMsg?.content,
    CONTINUATION_DIRECTIVE,
    "h: injected message is clean CONTINUATION_DIRECTIVE text"
  );
  console.log("  [PASS] (h) reasoning-length cutoff -> clean continuation injected");
}

// ---------------------------------------------------------------------------
// Vector (i): Tool output bounding - observation exceeding 32 KB is truncated.
// ---------------------------------------------------------------------------
async function vectorI() {
  const toolCall = {
    id: "call_big_1",
    type: "function",
    function: {
      name: "bash",
      arguments: JSON.stringify({ command: "node -e \"console.log('A'.repeat(50000))\"" }),
    },
  };
  const llm = makeMockLlm([
    { content: "", toolCalls: [toolCall], finishReason: "stop" },
    { content: "Processed observation.", finishReason: "stop" },
  ]);
  const logger = makeMockLogger();
  const runner = new AnserRunner({ llm, logger });

  const res = await runner.run({
    prompt: "Run big command.",
    sessionId: "test_i",
    maxTurns: 5,
  });

  assert.strictEqual(res.status, "completed");
  const toolMsg = llm._lastMessages?.find((m) => m.role === "tool" && m.tool_call_id === "call_big_1");
  assert.ok(toolMsg, "i: tool message present in history");
  assert.ok(
    toolMsg.content.includes("[Observation Truncated: Tool output exceeded 32KB limit"),
    "i: observation truncation warning injected"
  );
  assert.ok(
    Buffer.byteLength(toolMsg.content, "utf8") < 35000,
    `i: tool observation capped near 32KB (was ${Buffer.byteLength(toolMsg.content, "utf8")} bytes)`
  );
  console.log("  [PASS] (i) large tool observation (>32KB) -> truncated with explicit SWE-agent warning");
}

// ---------------------------------------------------------------------------
// Vector (j): Honest failure status - [vLLM Error: ...] does not mask as completed.
// ---------------------------------------------------------------------------
async function vectorJ() {
  const llm = makeMockLlm([
    {
      content: "\n\n[vLLM Error: This model's maximum context length is 245760 tokens.]\n\n",
      finishReason: "stop",
    },
  ]);
  const logger = makeMockLogger();
  const runner = new AnserRunner({ llm, logger });

  const res = await runner.run({
    prompt: "Prompt that triggered error.",
    sessionId: "test_j",
    maxTurns: 5,
  });

  assert.strictEqual(res.status, "failed", "j: status must be 'failed', NOT 'completed'");
  console.log("  [PASS] (j) vLLM error string in finalText -> honest status 'failed'");
}

// ---------------------------------------------------------------------------
// Vector (k): reasoning-only length cutoffs exhausting continuation budget
// -> terminates with honest status "reasoning_budget_exhausted" (not completed).
// ---------------------------------------------------------------------------
async function vectorK() {
  const llm = makeMockLlm([
    { content: "", toolCalls: [], finishReason: "length", hadReasoning: true },
    { content: "", toolCalls: [], finishReason: "length", hadReasoning: true },
    { content: "", toolCalls: [], finishReason: "length", hadReasoning: true },
    { content: "", toolCalls: [], finishReason: "length", hadReasoning: true },
  ]);
  const logger = makeMockLogger();
  const runner = new AnserRunner({ llm, logger });

  const res = await runner.run({
    prompt: "Think deeply forever.",
    sessionId: "test_k",
    maxTurns: 10,
  });

  assert.strictEqual(res.status, "reasoning_budget_exhausted", "k: status must be reasoning_budget_exhausted");
  assert.ok(res.finalText.includes("ReasoningBudgetExhaustedError"), "k: finalText contains diagnostic error name");
  console.log("  [PASS] (k) reasoning budget exhausted -> honest status 'reasoning_budget_exhausted'");
}

// ---------------------------------------------------------------------------
// Run all vectors.
// ---------------------------------------------------------------------------
async function main() {
  console.log("=== Runner Continuation-on-Cutoff Verification (offline) ===");
  console.log(`MAX_CONTINUATION_TURNS = ${MAX_CONTINUATION_TURNS}`);
  console.log(`EMPTY_STREAM_RETRIES = ${EMPTY_STREAM_RETRIES}`);
  console.log(`CONTINUATION_DIRECTIVE = "${CONTINUATION_DIRECTIVE}"\n`);

  let passed = 0;
  let failed = 0;
  const vectors = [
    ["(a)", vectorA],
    ["(b)", vectorB],
    ["(c)", vectorC],
    ["(d)", vectorD],
    ["(e)", vectorE],
    ["(f)", vectorF],
    ["(g)", vectorG],
    ["(h)", vectorH],
    ["(i)", vectorI],
    ["(j)", vectorJ],
    ["(k)", vectorK],
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

  console.log(`\n==========================================================================`);
  console.log(`Runner Continuation Verification: ${passed} / ${vectors.length} vectors passed`);
  if (failed > 0) {
    console.log(`Verdict: ${failed} VECTOR(S) FAILED.`);
    process.exit(1);
  }
  console.log(`Verdict: ALL CONTINUATION VECTORS PASSED.`);
  console.log(`==========================================================================`);
  process.exit(0);
}

main().catch((e) => {
  console.error("HARNESS FAILURE:", e);
  process.exit(1);
});
