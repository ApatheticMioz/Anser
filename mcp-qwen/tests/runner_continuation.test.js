/**
 * Runner Continuation-on-Cutoff Verification (fully OFFLINE)
 *
 * Proves the DeepSeek AVO runner is honest about and resilient to
 * output-ceiling truncation (finish_reason: "length"):
 *   (a) "length" twice then "stop"  -> completed, 2 continuations, finishReason logged
 *   (b) "length" always             -> terminates at the MAX_CONTINUATION_TURNS cap
 *   (c) "length" + invalid-JSON tool call -> call dropped, never executed, continuation injected
 *   (d) happy path "stop" + no tool calls -> breaks immediately, zero continuations
 *
 * No vLLM, no network. The LLM provider and event logger are injected via the
 * runner's constructor seams (this._llm / this._logger).
 */

import assert from "node:assert";

// Set the continuation budget BEFORE importing the runner so the config
// module picks it up at load time.
process.env.QWEN_MAX_CONTINUATION_TURNS = "3";

const { DeepSeekAvoRunner, CONTINUATION_DIRECTIVE } = await import(
  "../src/harness/runner.js"
);
const { MAX_CONTINUATION_TURNS } = await import("../src/config.js");

// ---------------------------------------------------------------------------
// Mock LLM: returns a scripted sequence of turn results.
// ---------------------------------------------------------------------------
function makeMockLlm(script) {
  let call = 0;
  return {
    _calls: 0,
    async streamChat() {
      this._calls++;
      const step = script[Math.min(call, script.length - 1)];
      call++;
      const metrics = {
        promptTokens: 0,
        completionTokens: (step.content || "").length,
        ttftMs: 1,
        totalMs: 1,
        tokensPerSec: 0,
      };
      return {
        content: step.content ?? "",
        toolCalls: step.toolCalls ?? [],
        finishReason: step.finishReason ?? "stop",
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
  const runner = new DeepSeekAvoRunner({ llm, logger });

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
  const runner = new DeepSeekAvoRunner({ llm, logger });

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
  const runner = new DeepSeekAvoRunner({ llm, logger });

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
  // Session still completes once the model re-emits cleanly.
  assert.strictEqual(res.status, "completed", "c: session completes after re-emit");
  console.log("  [PASS] (c) length + invalid-JSON tool call -> dropped, never executed, continuation injected");
}

// ---------------------------------------------------------------------------
// Vector (d): happy path — "stop" + empty toolCalls -> immediate break.
// ---------------------------------------------------------------------------
async function vectorD() {
  const llm = makeMockLlm([
    { content: "All done in one shot.", finishReason: "stop" },
  ]);
  const logger = makeMockLogger();
  const runner = new DeepSeekAvoRunner({ llm, logger });

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
// Run all vectors.
// ---------------------------------------------------------------------------
async function main() {
  console.log("=== Runner Continuation-on-Cutoff Verification (offline) ===");
  console.log(`MAX_CONTINUATION_TURNS = ${MAX_CONTINUATION_TURNS}`);
  console.log(`CONTINUATION_DIRECTIVE = "${CONTINUATION_DIRECTIVE}"\n`);

  let passed = 0;
  let failed = 0;
  const vectors = [
    ["(a)", vectorA],
    ["(b)", vectorB],
    ["(c)", vectorC],
    ["(d)", vectorD],
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
