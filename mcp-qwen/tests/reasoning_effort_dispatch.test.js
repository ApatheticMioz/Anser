/**
 * Per-Dispatch Reasoning-Effort Plumbing Verification (fully OFFLINE)
 *
 * Proves the qwen_coworker `reasoning_effort` param is plumbed task-locally
 * through the dispatch path (tool handler -> task record -> runner -> provider
 * request options) with the existing QWEN_REASONING_EFFORT env read preserved
 * as the fallback, and NO cross-task leakage:
 *
 *   (a) schema: the REAL qwen_coworker inputSchema (captured from
 *       registerTools) accepts xhigh/medium/low and an omitted param, and
 *       REJECTS off/high/XHIGH — the tiers the engine's chat template does
 *       NOT accept (verified against the live Qwen3.8-27B chat_template.jinja
 *       and the live vLLM engine: off/high -> 400, xhigh/medium/low -> 200).
 *   (b) provider: param ABSENT + env unset -> chat_template_kwargs.
 *       reasoning_effort === "xhigh" (the existing dynamic env default,
 *       unchanged).
 *   (c) provider: param ABSENT + env set -> the env value is forwarded
 *       (the dynamic read remains the fallback).
 *   (d) provider: param PRESENT -> the param value is forwarded, OVERRIDING
 *       a conflicting env value (task-local precedence).
 *   (e) provider: NO cross-task leakage — a param on call N does not leak
 *       into call N+1, which must fall back to the env default. Proves the
 *       plumbing never mutates process.env.
 *   (f) runner: threads the RAW param to the provider's streamChat (so the
 *       provider's env fallback applies when it is absent) and surfaces the
 *       EFFECTIVE value in the session_start event.
 *
 * No vLLM, no network. globalThis.fetch is monkey-patched (provider vectors)
 * and the LLM/logger are injected via the runner's constructor seams (runner
 * vector), matching the existing test patterns.
 */

import assert from "node:assert";
import { z } from "zod";

const { REASONING_EFFORT_TIERS, getReasoningEffort } = await import(
  "../src/config.js"
);
const { VllmProviderService } = await import(
  "../src/harness/services/provider_vllm.js"
);
const { registerTools } = await import("../src/tools.js");
const { AnserRunner } = await import("../src/harness/runner.js");

// ---------------------------------------------------------------------------
// SSE fetch mock: feeds the provider a scripted byte stream and captures the
// outgoing request payload (same pattern as provider_reasoning.test.js).
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

// A minimal, clean SSE stream (one content delta, a stop, then DONE).
const SIMPLE_SSE =
  'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\n' +
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
  'data: [DONE]\n\n';

// ---------------------------------------------------------------------------
// Capture the REAL qwen_coworker tool schema by registering the tools against
// a mock server (no McpServer, no port, no side effects beyond the heal
// gatekeeper reference).
// ---------------------------------------------------------------------------
function captureCoworkerSchema() {
  const tools = {};
  const mockServer = {
    registerTool: (name, meta, handler) => {
      tools[name] = { meta, handler };
    },
  };
  registerTools(mockServer);
  return tools.qwen_coworker;
}

// ---------------------------------------------------------------------------
// Vector (a): the real tool schema accepts the valid tiers + omission and
// rejects the tiers the engine's chat template does not support.
// ---------------------------------------------------------------------------
async function vectorA() {
  const { meta } = captureCoworkerSchema();
  // meta.inputSchema is the raw zod SHAPE (a plain object of zod fields), not
  // a z.object. Wrap it to get a parseable schema (the MCP SDK does the same
  // conversion when it serves the tool).
  const schema = z.object(meta.inputSchema);
  assert.ok(schema, "a: qwen_coworker has an inputSchema");
  assert.ok(
    schema.shape.reasoning_effort,
    "a: inputSchema exposes a reasoning_effort field"
  );

  // The schema must be built from the single source of truth.
  assert.deepStrictEqual(
    REASONING_EFFORT_TIERS,
    ["xhigh", "medium", "low"],
    "a: REASONING_EFFORT_TIERS is the verified engine set (no off/high)"
  );

  // Valid: every documented tier the engine accepts, plus the omitted case.
  for (const tier of REASONING_EFFORT_TIERS) {
    const r = schema.safeParse({ prompt: "do the thing", reasoning_effort: tier });
    assert.ok(r.success, `a: schema accepts reasoning_effort="${tier}"`);
    assert.strictEqual(r.data.reasoning_effort, tier, `a: "${tier}" round-trips`);
  }
  const omitted = schema.safeParse({ prompt: "do the thing" });
  assert.ok(omitted.success, "a: schema accepts an omitted reasoning_effort");
  assert.strictEqual(
    omitted.data.reasoning_effort,
    undefined,
    "a: omitted param stays undefined (not defaulted in the schema)"
  );

  // Invalid: the tiers the engine's chat template REJECTS (off/high) plus a
  // case-sensitivity probe. These must be schema-rejected (fail fast).
  for (const bad of ["off", "high", "XHIGH", "xhigh ", ""]) {
    const r = schema.safeParse({ prompt: "do the thing", reasoning_effort: bad });
    assert.ok(
      !r.success,
      `a: schema REJECTS reasoning_effort=${JSON.stringify(bad)}`
    );
  }
  console.log(
    "  [PASS] (a) real tool schema accepts xhigh/medium/low + omitted, rejects off/high/XHIGH"
  );
}

// ---------------------------------------------------------------------------
// Vector (b): param ABSENT + env unset -> the existing dynamic env default
// (xhigh) is forwarded. This is the zero-behavior-change guarantee.
// ---------------------------------------------------------------------------
async function vectorB() {
  const prevEnv = process.env.QWEN_REASONING_EFFORT;
  delete process.env.QWEN_REASONING_EFFORT;
  try {
    const capture = {};
    sseFetchMock(SIMPLE_SSE, capture);
    const svc = new VllmProviderService();
    await svc.streamChat({ messages: [{ role: "user", content: "q" }] });
    assert.strictEqual(
      capture.payload.chat_template_kwargs?.reasoning_effort,
      "xhigh",
      "b: param absent + env unset -> xhigh (existing default, unchanged)"
    );
  } finally {
    if (prevEnv === undefined) delete process.env.QWEN_REASONING_EFFORT;
    else process.env.QWEN_REASONING_EFFORT = prevEnv;
  }
  console.log("  [PASS] (b) param absent + env unset -> xhigh (unchanged default)");
}

// ---------------------------------------------------------------------------
// Vector (c): param ABSENT + env set -> the env value is forwarded (the
// dynamic read remains the fallback).
// ---------------------------------------------------------------------------
async function vectorC() {
  const prevEnv = process.env.QWEN_REASONING_EFFORT;
  process.env.QWEN_REASONING_EFFORT = "low";
  try {
    const capture = {};
    sseFetchMock(SIMPLE_SSE, capture);
    const svc = new VllmProviderService();
    await svc.streamChat({ messages: [{ role: "user", content: "q" }] });
    assert.strictEqual(
      capture.payload.chat_template_kwargs?.reasoning_effort,
      "low",
      "c: param absent + env=low -> env value forwarded (fallback intact)"
    );
  } finally {
    if (prevEnv === undefined) delete process.env.QWEN_REASONING_EFFORT;
    else process.env.QWEN_REASONING_EFFORT = prevEnv;
  }
  console.log("  [PASS] (c) param absent + env=low -> env value forwarded (fallback)");
}

// ---------------------------------------------------------------------------
// Vector (d): param PRESENT -> the param value is forwarded, OVERRIDING a
// conflicting env value (task-local precedence).
// ---------------------------------------------------------------------------
async function vectorD() {
  const prevEnv = process.env.QWEN_REASONING_EFFORT;
  process.env.QWEN_REASONING_EFFORT = "low"; // conflicting env value
  try {
    const capture = {};
    sseFetchMock(SIMPLE_SSE, capture);
    const svc = new VllmProviderService();
    await svc.streamChat({
      messages: [{ role: "user", content: "q" }],
      reasoningEffort: "medium",
    });
    assert.strictEqual(
      capture.payload.chat_template_kwargs?.reasoning_effort,
      "medium",
      "d: param=medium overrides env=low (task-local precedence)"
    );
  } finally {
    if (prevEnv === undefined) delete process.env.QWEN_REASONING_EFFORT;
    else process.env.QWEN_REASONING_EFFORT = prevEnv;
  }
  console.log("  [PASS] (d) param=medium overrides env=low (task-local precedence)");
}

// ---------------------------------------------------------------------------
// Vector (e): NO cross-task leakage — a param on call N must NOT leak into
// call N+1. The second call (no param) must fall back to the env default,
// proving the plumbing never mutates process.env.
// ---------------------------------------------------------------------------
async function vectorE() {
  const prevEnv = process.env.QWEN_REASONING_EFFORT;
  delete process.env.QWEN_REASONING_EFFORT;
  try {
    const svc = new VllmProviderService();

    // Call N: a task-local param.
    const capN = {};
    sseFetchMock(SIMPLE_SSE, capN);
    await svc.streamChat({
      messages: [{ role: "user", content: "q" }],
      reasoningEffort: "medium",
    });
    assert.strictEqual(
      capN.payload.chat_template_kwargs?.reasoning_effort,
      "medium",
      "e: call N uses its own param"
    );

    // Call N+1: a DIFFERENT task with no param. It must fall back to the env
    // default (xhigh), NOT inherit call N's "medium".
    const capN1 = {};
    sseFetchMock(SIMPLE_SSE, capN1);
    await svc.streamChat({ messages: [{ role: "user", content: "q" }] });
    assert.strictEqual(
      capN1.payload.chat_template_kwargs?.reasoning_effort,
      "xhigh",
      "e: call N+1 (no param) falls back to env default, NOT call N's param"
    );

    // The invariant's root cause: process.env must be untouched by the
    // param-bearing call.
    assert.strictEqual(
      process.env.QWEN_REASONING_EFFORT,
      undefined,
      "e: process.env.QWEN_REASONING_EFFORT was never mutated by the param"
    );
  } finally {
    if (prevEnv === undefined) delete process.env.QWEN_REASONING_EFFORT;
    else process.env.QWEN_REASONING_EFFORT = prevEnv;
  }
  console.log(
    "  [PASS] (e) no cross-task leakage: param on call N does not affect call N+1 (env untouched)"
  );
}

// ---------------------------------------------------------------------------
// Mock LLM + logger (same surface the runner uses; same pattern as
// runner_continuation.test.js). The mock LLM records the reasoningEffort it
// was handed on each streamChat call.
// ---------------------------------------------------------------------------
function makeMockLlm() {
  return {
    _calls: 0,
    _reasoningEfforts: [],
    async streamChat({ reasoningEffort } = {}) {
      this._calls++;
      this._reasoningEfforts.push(reasoningEffort);
      return {
        content: "Done.",
        toolCalls: [],
        finishReason: "stop",
        hadReasoning: false,
        metrics: {
          promptTokens: 0,
          completionTokens: 5,
          ttftMs: 1,
          totalMs: 1,
          tokensPerSec: 0,
          hadReasoning: false,
        },
      };
    },
  };
}

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

// ---------------------------------------------------------------------------
// Vector (f): the runner threads the RAW param to the provider's streamChat
// (so the provider's env fallback applies when it is absent) and surfaces the
// EFFECTIVE value in the session_start event.
// ---------------------------------------------------------------------------
async function vectorF() {
  const prevEnv = process.env.QWEN_REASONING_EFFORT;
  delete process.env.QWEN_REASONING_EFFORT;
  try {
    // (f1) param provided -> the provider receives it verbatim; the
    // session_start event surfaces the same effective value.
    const llm1 = makeMockLlm();
    const logger1 = makeMockLogger();
    const runner1 = new AnserRunner({ llm: llm1, logger: logger1 });
    await runner1.run({
      prompt: "think at medium",
      sessionId: "re_f1",
      maxTurns: 10,
      reasoningEffort: "medium",
    });
    assert.strictEqual(
      llm1._reasoningEfforts[0],
      "medium",
      "f1: runner threads the raw param to the provider's streamChat"
    );
    const start1 = logger1.events.find((e) => e.type === "session_start");
    assert.strictEqual(
      start1.reasoningEffort,
      "medium",
      "f1: session_start event surfaces the effective (param) effort"
    );

    // (f2) param ABSENT -> the runner passes undefined (NOT a pre-resolved
    // value) so the provider's own env fallback is what applies; the
    // session_start event still surfaces the effective (env default) value.
    const llm2 = makeMockLlm();
    const logger2 = makeMockLogger();
    const runner2 = new AnserRunner({ llm: llm2, logger: logger2 });
    await runner2.run({
      prompt: "think at default",
      sessionId: "re_f2",
      maxTurns: 10,
    });
    assert.strictEqual(
      llm2._reasoningEfforts[0],
      undefined,
      "f2: runner passes undefined (not a pre-resolved value) when the param is absent"
    );
    const start2 = logger2.events.find((e) => e.type === "session_start");
    assert.strictEqual(
      start2.reasoningEffort,
      "xhigh",
      "f2: session_start event surfaces the effective (env default) effort"
    );
  } finally {
    if (prevEnv === undefined) delete process.env.QWEN_REASONING_EFFORT;
    else process.env.QWEN_REASONING_EFFORT = prevEnv;
  }
  console.log(
    "  [PASS] (f) runner threads raw param to provider + surfaces effective effort in session_start"
  );
}

// ---------------------------------------------------------------------------
// Run all vectors.
// ---------------------------------------------------------------------------
async function main() {
  console.log("=== Per-Dispatch Reasoning-Effort Plumbing Verification (offline) ===");
  console.log(`REASONING_EFFORT_TIERS = ${JSON.stringify(REASONING_EFFORT_TIERS)}`);
  console.log(`getReasoningEffort() (env unset) = ${getReasoningEffort()}\n`);

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
  console.log(`Reasoning-Effort Dispatch Verification: ${passed} / ${vectors.length} vectors passed`);
  if (failed > 0) {
    console.log(`Verdict: ${failed} VECTOR(S) FAILED.`);
    process.exit(1);
  }
  console.log(`Verdict: ALL REASONING-EFFORT VECTORS PASSED.`);
  console.log(`==========================================================================`);
  process.exit(0);
}

main().catch((e) => {
  console.error("HARNESS FAILURE:", e);
  process.exit(1);
});
