/**
 * Provider Engine Normalization Verification (fully OFFLINE)
 *
 * Proves src/harness/services/provider_vllm.js normalizes engine
 * configuration and reasoning transport:
 *   (a) The constructor defaults are wired to config.js:
 *       svc.model === MODEL and svc.baseUrl === BASE_URL (imported from
 *       ../src/config.js, i.e. env > ~/.castor/config.json > built-in
 *       defaults); explicit options still override.
 *   (b) SSE delta.reasoning_content (Ollama / llama-server style) is
 *       extracted as reasoning and never leaks into content.
 *   (c) SSE delta.content containing think-tag segments (Ollama /
 *       llama-server without a reasoning parser) is split: the thinking
 *       segment becomes reasoning, the rest stays content; onToken only
 *       sees the stripped content.
 *   (d) Think tags split across chunk boundaries are still normalized
 *       (a partial opening tag held at a chunk edge is not leaked into
 *       content).
 *
 * No vLLM, no network. globalThis.fetch is monkey-patched to return a
 * real Response wrapping a ReadableStream of SSE bytes, exactly like
 * provider_reasoning.test.js.
 */

import assert from "node:assert";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { VllmProviderService } = await import(
  "../src/harness/services/provider_vllm.js"
);
const { MODEL, BASE_URL, STREAM_PROXY_PORT, VLLM_PORT } = await import("../src/config.js");

// The think tags, built from the backtick char code so this file never
// contains the raw tag sequence.
const THINK_OPEN = String.fromCharCode(96) + "think";
const THINK_CLOSE = String.fromCharCode(96) + "think" + String.fromCharCode(96);

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

// ---------------------------------------------------------------------------
// Vector (a): constructor defaults are wired to config.js MODEL / BASE_URL.
// ---------------------------------------------------------------------------
async function vectorA() {
  const svc = new VllmProviderService();
  const expectedBase =
    BASE_URL === `http://localhost:${VLLM_PORT}/v1`
      ? `http://127.0.0.1:${STREAM_PROXY_PORT}/v1`
      : BASE_URL;
  assert.strictEqual(svc.baseUrl, expectedBase, "a: default baseUrl is stream proxy or config BASE_URL");

  // Explicit options still override the config defaults.
  const overridden = new VllmProviderService({
    model: "override-model",
    baseUrl: "http://127.0.0.1:18022/v1",
  });
  assert.strictEqual(overridden.model, "override-model", "a: model option overrides");
  assert.strictEqual(
    overridden.baseUrl,
    "http://127.0.0.1:18022/v1",
    "a: baseUrl option overrides"
  );
  console.log(
    `  [PASS] (a) constructor defaults wired to config (model=${MODEL}, baseUrl=${BASE_URL}); options override`
  );
}

// ---------------------------------------------------------------------------
// Vector (b): delta.reasoning_content (Ollama / llama-server) -> reasoning.
// ---------------------------------------------------------------------------
async function vectorB() {
  sseFetchMock(
    sse([
      { choices: [{ delta: { reasoning_content: "Ollama thinking " }, finish_reason: null }] },
      { choices: [{ delta: { reasoning_content: "segment." }, finish_reason: null }] },
      { choices: [{ delta: { content: "Final answer." }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      "[DONE]",
    ])
  );
  const svc = new VllmProviderService();
  const res = await svc.streamChat({ messages: [{ role: "user", content: "q" }] });

  assert.strictEqual(res.content, "Final answer.", "b: content assembled, no reasoning leak");
  assert.strictEqual(res.reasoning, "Ollama thinking segment.", "b: reasoning_content extracted");
  assert.strictEqual(res.hadReasoning, true, "b: hadReasoning true");
  assert.ok(res.reasoningTokens > 0, "b: reasoningTokens counted");
  assert.strictEqual(res.finishReason, "stop", "b: finishReason stop");
  console.log("  [PASS] (b) delta.reasoning_content -> reasoning (not content)");
}

// ---------------------------------------------------------------------------
// Vector (c): think-tag segments inside delta.content are split.
// ---------------------------------------------------------------------------
async function vectorC() {
  const tokens = [];
  sseFetchMock(
    sse([
      { choices: [{ delta: { content: THINK_OPEN }, finish_reason: null }] },
      { choices: [{ delta: { content: "Let me think about this carefully." }, finish_reason: null }] },
      { choices: [{ delta: { content: THINK_CLOSE }, finish_reason: null }] },
      { choices: [{ delta: { content: "The answer is 42." }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      "[DONE]",
    ])
  );
  const svc = new VllmProviderService();
  const res = await svc.streamChat({
    messages: [{ role: "user", content: "q" }],
    onToken: (t) => tokens.push(t),
  });

  assert.strictEqual(res.content, "The answer is 42.", "c: content stripped of think segment");
  assert.strictEqual(res.reasoning, "Let me think about this carefully.", "c: think segment -> reasoning");
  assert.strictEqual(res.hadReasoning, true, "c: hadReasoning true");
  assert.ok(res.reasoningTokens > 0, "c: reasoningTokens counted");
  // onToken must only ever see the stripped content, never the thinking.
  assert.deepStrictEqual(tokens, ["The answer is 42."], "c: onToken sees stripped content only");
  assert.strictEqual(res.finishReason, "stop", "c: finishReason stop");
  console.log("  [PASS] (c) think-tag segment in content -> reasoning; content/onToken stripped");
}

// ---------------------------------------------------------------------------
// Vector (d): think tags split across chunk boundaries.
// ---------------------------------------------------------------------------
async function vectorD() {
  const tokens = [];
  sseFetchMock(
    sse([
      // Opening tag split across two chunks: "
      { choices: [{ delta: { content: THINK_OPEN.slice(0, 3) }, finish_reason: null }] },
      { choices: [{ delta: { content: THINK_OPEN.slice(3) }, finish_reason: null }] },
      { choices: [{ delta: { content: "thinking across chunks" }, finish_reason: null }] },
      // Closing tag split across two chunks: "
      { choices: [{ delta: { content: THINK_CLOSE.slice(0, 3) }, finish_reason: null }] },
      { choices: [{ delta: { content: THINK_CLOSE.slice(3) }, finish_reason: null }] },
      { choices: [{ delta: { content: " done." }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      "[DONE]",
    ])
  );
  const svc = new VllmProviderService();
  const res = await svc.streamChat({
    messages: [{ role: "user", content: "q" }],
    onToken: (t) => tokens.push(t),
  });

  assert.strictEqual(res.content, " done.", "d: content stripped across split tags");
  assert.strictEqual(res.reasoning, "thinking across chunks", "d: split think segment -> reasoning");
  assert.strictEqual(res.hadReasoning, true, "d: hadReasoning true");
  assert.deepStrictEqual(tokens, [" done."], "d: onToken sees stripped content only");
  console.log("  [PASS] (d) think tags split across chunks still normalized");
}

// ---------------------------------------------------------------------------
// Run all vectors.
// ---------------------------------------------------------------------------
async function main() {
  console.log("=== Provider Engine Normalization Verification (offline) ===");
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
  console.log(`Provider Normalization Verification: ${passed} / ${vectors.length} vectors passed`);
  if (failed > 0) {
    console.log(`Verdict: ${failed} VECTOR(S) FAILED.`);
    process.exit(1);
  }
  console.log(`Verdict: ALL NORMALIZATION VECTORS PASSED.`);
  console.log(`==========================================================================`);
  process.exit(0);
}

main().catch((e) => {
  console.error("HARNESS FAILURE:", e);
  process.exit(1);
});
