/**
 * Provider Usage-Chunk Telemetry Verification (fully OFFLINE)
 *
 * Proves src/harness/services/provider_vllm.js records prompt-token telemetry
 * honestly from the vLLM stream_options { include_usage: true } terminal chunk
 * (empty choices + a `usage` field), and that the usage-only terminal chunk
 * does NOT trip the runner's empty-stream detection:
 *
 *   (a) usage present  -> metrics.promptTokens = engine prompt_tokens,
 *       NO promptTokensEstimated flag (authoritative measurement).
 *   (b) usage absent   -> metrics.promptTokens = chars-based estimate,
 *       promptTokensEstimated === true (honest telemetry: a guess is flagged).
 *   (c) the usage chunk does not null out the turn's finishReason / content
 *       (content + finish "stop" + trailing usage chunk -> finishReason "stop",
 *       content preserved; the empty-choices chunk is consumed gracefully).
 *   (d) completion tokens from usage take precedence over the local
 *       per-delta count (metrics.completionTokens = engine completion_tokens).
 *   (e) reasoningTokens accounting unchanged (reasoning deltas still counted
 *       locally; the engine usage completion count only replaces the CONTENT
 *       completion count, never the reasoning field).
 *   (f) RUNNER-LEVEL: a usage-only terminal chunk (empty choices, no content,
 *       no tool calls, no finish_reason) does NOT trip the runner's
 *       no-content / no-toolCalls / no-finishReason empty-stream heuristics —
 *       the turn completes as "completed" with the assistant_message recorded
 *       and zero empty_stream_retry events.
 *
 * No vLLM, no network. The stream layer (globalThis.fetch) is monkey-patched
 * to return a real Response wrapping a ReadableStream of SSE bytes, exactly
 * like provider_reasoning.test.js. Vector (f) drives the REAL provider + REAL
 * runner (only the fetch stream layer is mocked) so the usage chunk is parsed
 * by the actual _consumeStream and classified by the actual runner heuristics.
 */

import assert from "node:assert";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Set the continuation + empty-stream budgets BEFORE importing the runner so
// the config module picks them up at load time (matches runner_continuation.test.js).
process.env.QWEN_MAX_CONTINUATION_TURNS = "3";
process.env.QWEN_EMPTY_STREAM_RETRIES = "2";

const { VllmProviderService } = await import(
  "../src/harness/services/provider_vllm.js"
);
const { AnserRunner } = await import("../src/harness/runner.js");

// ---------------------------------------------------------------------------
// SSE fetch mock: feeds the provider a scripted byte stream.
// ---------------------------------------------------------------------------
function sseFetchMock(sseText, capture) {
  globalThis.fetch = async (url, opts) => {
    if (capture && opts?.body) capture.payload = JSON.parse(opts.body);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sseText));
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
}

function sse(frames) {
  // frames: array of JSON objects (or the literal string "[DONE]").
  return (
    frames
      .map((f) => `data: ${typeof f === "string" ? f : JSON.stringify(f)}`)
      .join("\n\n") + "\n\n"
  );
}

// A usage-only terminal chunk: empty choices + a `usage` field. This is the
// exact shape vLLM 0.28+ emits for stream_options { include_usage: true }.
const USAGE_CHUNK = {
  choices: [],
  usage: { prompt_tokens: 123, completion_tokens: 45, total_tokens: 168 },
};

// ---------------------------------------------------------------------------
// Vector (a): usage present -> engine promptTokens, NO estimated flag.
// ---------------------------------------------------------------------------
async function vectorA() {
  sseFetchMock(
    sse([
      { choices: [{ delta: { content: "Hello " }, finish_reason: null }] },
      { choices: [{ delta: { content: "world." }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      USAGE_CHUNK,
      "[DONE]",
    ])
  );
  const svc = new VllmProviderService();
  const res = await svc.streamChat({ messages: [{ role: "user", content: "q" }] });

  assert.strictEqual(
    res.metrics.promptTokens,
    123,
    "a: promptTokens = engine prompt_tokens"
  );
  assert.strictEqual(
    "promptTokensEstimated" in res.metrics,
    false,
    "a: NO promptTokensEstimated key when engine usage is present"
  );
  assert.strictEqual(
    res.metrics.promptTokensEstimated,
    undefined,
    "a: flag absent (not false) when engine usage is present"
  );
  console.log("  [PASS] (a) usage present -> engine promptTokens, no estimated flag");
}

// ---------------------------------------------------------------------------
// Vector (b): usage absent -> chars-based estimate + promptTokensEstimated flag.
// ---------------------------------------------------------------------------
async function vectorB() {
  sseFetchMock(
    sse([
      { choices: [{ delta: { content: "Hello " }, finish_reason: null }] },
      { choices: [{ delta: { content: "world." }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      "[DONE]",
    ])
  );
  const svc = new VllmProviderService();
  const res = await svc.streamChat({ messages: [{ role: "user", content: "q" }] });

  // The chars-based estimate for the exact messages used, computed identically
  // to the provider: JSON.stringify(messages).length / 3.5, ceiling.
  const expectedEstimate = Math.ceil(
    JSON.stringify([{ role: "user", content: "q" }]).length / 3.5
  );
  assert.strictEqual(
    res.metrics.promptTokens,
    expectedEstimate,
    `b: promptTokens = chars-based estimate (${expectedEstimate})`
  );
  assert.strictEqual(
    res.metrics.promptTokensEstimated,
    true,
    "b: promptTokensEstimated === true when engine usage is absent"
  );
  console.log(
    `  [PASS] (b) usage absent -> estimated promptTokens=${expectedEstimate} + flag`
  );
}

// ---------------------------------------------------------------------------
// Vector (c): the usage chunk does not null out the turn's finishReason /
// content. A stream with content + finish "stop" + a trailing usage chunk must
// still report finishReason "stop" and the assembled content (the empty-choices
// usage chunk is consumed gracefully, never mistaken for a dead stream).
// ---------------------------------------------------------------------------
async function vectorC() {
  sseFetchMock(
    sse([
      { choices: [{ delta: { content: "The answer " }, finish_reason: null }] },
      { choices: [{ delta: { content: "is 42." }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      USAGE_CHUNK,
      "[DONE]",
    ])
  );
  const svc = new VllmProviderService();
  const res = await svc.streamChat({ messages: [{ role: "user", content: "q" }] });

  assert.strictEqual(
    res.content,
    "The answer is 42.",
    "c: content assembled (usage chunk did not clobber it)"
  );
  assert.strictEqual(
    res.finishReason,
    "stop",
    "c: finishReason preserved as stop (usage chunk did not null it)"
  );
  assert.strictEqual(res.toolCalls.length, 0, "c: no tool calls");
  console.log("  [PASS] (c) usage chunk does not null out finishReason / content");
}

// ---------------------------------------------------------------------------
// Vector (d): completion tokens from usage take precedence over the local
// per-delta count.
// ---------------------------------------------------------------------------
async function vectorD() {
  // 2 content deltas -> the local per-delta count would be 2, but the engine
  // usage reports completion_tokens = 45 (authoritative).
  sseFetchMock(
    sse([
      { choices: [{ delta: { content: "Hello " }, finish_reason: null }] },
      { choices: [{ delta: { content: "world." }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      USAGE_CHUNK,
      "[DONE]",
    ])
  );
  const svc = new VllmProviderService();
  const res = await svc.streamChat({ messages: [{ role: "user", content: "q" }] });

  assert.strictEqual(
    res.metrics.completionTokens,
    45,
    "d: completionTokens = engine completion_tokens (takes precedence over local count)"
  );
  console.log("  [PASS] (d) completion tokens from usage take precedence over local count");
}

// ---------------------------------------------------------------------------
// Vector (e): reasoningTokens accounting unchanged. Reasoning deltas are
// counted locally (chars/4) and are NOT clobbered by the engine usage
// completion count; the usage completion count only replaces the CONTENT
// completion count.
// ---------------------------------------------------------------------------
async function vectorE() {
  sseFetchMock(
    sse([
      {
        choices: [
          { delta: { reasoning: "Thinking hard about the answer. " }, finish_reason: null },
        ],
      },
      { choices: [{ delta: { content: "The answer is 42." }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      USAGE_CHUNK,
      "[DONE]",
    ])
  );
  const svc = new VllmProviderService();
  const res = await svc.streamChat({ messages: [{ role: "user", content: "q" }] });

  assert.strictEqual(res.hadReasoning, true, "e: hadReasoning true");
  assert.ok(
    res.metrics.reasoningTokens > 0,
    "e: reasoningTokens counted locally (unchanged)"
  );
  // The engine usage completion count (45) replaces the CONTENT completion
  // count, but the reasoning accounting is a separate, untouched field.
  assert.strictEqual(
    res.metrics.completionTokens,
    45,
    "e: completionTokens = engine usage (content)"
  );
  assert.strictEqual(
    res.metrics.reasoningTokens,
    res.reasoningTokens,
    "e: metrics.reasoningTokens matches top-level reasoningTokens (unchanged)"
  );
  console.log(
    `  [PASS] (e) reasoningTokens accounting unchanged (reasoning=${res.metrics.reasoningTokens}, completion=${res.metrics.completionTokens})`
  );
}

// ---------------------------------------------------------------------------
// Vector (f): RUNNER-LEVEL — the usage-only terminal chunk does NOT trip the
// runner's empty-stream detection. Drives the REAL provider + REAL runner with
// only the fetch stream layer mocked, so the usage chunk is parsed by the
// actual _consumeStream and classified by the actual runner heuristics.
// ---------------------------------------------------------------------------
async function vectorF() {
  // The stream: content + finish "stop" + a usage-only terminal chunk + [DONE].
  // The usage chunk has empty choices, no content, no tool calls, and no
  // finish_reason — exactly the shape that could be mistaken for a dead/empty
  // stream. It must NOT trip the runner's empty-stream heuristics.
  //
  // Built with the sse() helper (real newlines) so the provider's
  // buffer.split("\n") frame parser sees each chunk as its own SSE frame.
  const sseText = sse([
    { choices: [{ delta: { content: "Hello " }, finish_reason: null }] },
    { choices: [{ delta: { content: "world." }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
    USAGE_CHUNK,
    "[DONE]",
  ]);
  sseFetchMock(sseText);

  const logger = {
    events: [],
    append(e) {
      const entry = { timestamp: new Date().toISOString(), ...e };
      this.events.push(entry);
      return entry;
    },
    readAll() {
      return this.events;
    },
    getConversationHistory() {
      return [];
    },
  };
  // No llm injected -> the runner mounts the REAL vllm provider, whose
  // streamChat calls the (mocked) fetch.
  const runner = new AnserRunner({ logger });

  const res = await runner.run({
    prompt: "hi",
    sessionId: "usage_chunk_runner",
    maxTurns: 10,
  });

  // The turn must complete cleanly — the usage chunk did NOT trip the
  // no-content / no-toolCalls / no-finishReason empty-stream heuristics.
  assert.strictEqual(
    res.status,
    "completed",
    `f: status must be 'completed' (usage chunk did not trip empty-stream detection), got '${res.status}'`
  );
  assert.strictEqual(
    res.finalText,
    "Hello world.",
    "f: finalText is the real content (not empty)"
  );
  // No empty-stream retry was triggered.
  const emptyRetries = logger.events.filter((e) => e.type === "empty_stream_retry");
  assert.strictEqual(
    emptyRetries.length,
    0,
    `f: zero empty_stream_retry events (usage chunk did not trip detection), got ${emptyRetries.length}`
  );
  // The assistant turn was recorded (not dropped as empty).
  const assistantMsgs = logger.events.filter((e) => e.type === "assistant_message");
  assert.strictEqual(
    assistantMsgs.length,
    1,
    "f: exactly one assistant_message recorded (the turn was not dropped as empty)"
  );
  // The recorded turn carries the engine-reported promptTokens (no estimated flag).
  assert.strictEqual(
    assistantMsgs[0].metrics.promptTokens,
    123,
    "f: recorded assistant_message carries engine promptTokens=123"
  );
  assert.strictEqual(
    "promptTokensEstimated" in assistantMsgs[0].metrics,
    false,
    "f: recorded assistant_message has NO promptTokensEstimated flag"
  );
  // The session_end event reflects the engine completion count.
  const sessionEnd = logger.events.find((e) => e.type === "session_end");
  assert.strictEqual(sessionEnd.status, "completed", "f: session_end status completed");
  assert.strictEqual(
    sessionEnd.totalCompletionTokens,
    45,
    "f: session_end totalCompletionTokens = engine completion_tokens (45)"
  );
  console.log(
    "  [PASS] (f) usage-only terminal chunk does NOT trip the runner's empty-stream detection"
  );
}

// ---------------------------------------------------------------------------
// Run all vectors.
// ---------------------------------------------------------------------------
async function main() {
  console.log("=== Provider Usage-Chunk Telemetry Verification (offline) ===");
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
  console.log(`\n==========================================================================`);
  console.log(`Provider Usage-Chunk Verification: ${passed} / ${vectors.length} vectors passed`);
  if (failed > 0) {
    console.log(`Verdict: ${failed} VECTOR(S) FAILED.`);
    process.exit(1);
  }
  console.log(`Verdict: ALL USAGE-CHUNK VECTORS PASSED.`);
  console.log(`==========================================================================`);
  process.exit(0);
}

main().catch((e) => {
  console.error("HARNESS FAILURE:", e);
  process.exit(1);
});
