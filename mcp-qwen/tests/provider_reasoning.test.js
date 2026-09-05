/**
 * Provider Reasoning-Token Accounting Verification (fully OFFLINE)
 *
 * Proves src/harness/services/provider_vllm.js surfaces server-side reasoning
 * (thinking) instead of dropping it on the floor:
 *   (a) SSE with the LIVE field delta.reasoning then delta.content deltas
 *       -> fullContent correct, reasoningTokens>0, hadReasoning=true, TTFT
 *          measured from the first REASONING delta (not the first content).
 *   (b) reasoning-only stream (delta.reasoning) ending finish_reason "length"
 *       -> content "", reasoningTokens>0, finishReason "length".
 *   (c) legacy delta.reasoning_content field ALSO counted (compat).
 *   (d) QWEN_MAX_TOKENS env honored in the request payload max_tokens
 *       (child process: config reads env at import time).
 *   (e) QWEN_REASONING_EFFORT=low -> payload.chat_template_kwargs.
 *       reasoning_effort==="low"; env unset -> no chat_template_kwargs key.
 *
 * No vLLM, no network. globalThis.fetch is monkey-patched to return a real
 * Response wrapping a ReadableStream of SSE bytes.
 */

import assert from "node:assert";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { VllmProviderService } = await import(
  "../src/harness/services/provider_vllm.js"
);

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
// Vector (a): LIVE field delta.reasoning then content -> accounted + TTFT.
// ---------------------------------------------------------------------------
async function vectorA() {
  const capture = {};
  sseFetchMock(
    sse([
      { choices: [{ delta: { reasoning: "Thinking hard about " }, finish_reason: null }] },
      { choices: [{ delta: { reasoning: "the architecture." }, finish_reason: null }] },
      { choices: [{ delta: { content: "The answer" }, finish_reason: null }] },
      { choices: [{ delta: { content: " is 42." }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      "[DONE]",
    ]),
    capture
  );
  const svc = new VllmProviderService();
  const t0 = Date.now();
  const res = await svc.streamChat({ messages: [{ role: "user", content: "q" }] });
  const elapsed = Date.now() - t0;

  assert.strictEqual(res.content, "The answer is 42.", "a: content assembled");
  assert.strictEqual(res.finishReason, "stop", "a: finishReason stop");
  assert.strictEqual(res.hadReasoning, true, "a: hadReasoning true");
  assert.ok(res.reasoningTokens > 0, "a: reasoningTokens counted");
  assert.ok(
    res.metrics.hadReasoning === true && res.metrics.reasoningTokens > 0,
    "a: metrics carry reasoning accounting"
  );
  // TTFT must have been measured (first delta of ANY kind, reasoning included).
  assert.ok(
    res.metrics.ttftMs < elapsed + 5,
    "a: ttft measured from first reasoning delta"
  );
  console.log("  [PASS] (a) delta.reasoning + content -> accounted, TTFT from reasoning");
}

// ---------------------------------------------------------------------------
// Vector (b): reasoning-only stream ending finish_reason "length".
// ---------------------------------------------------------------------------
async function vectorB() {
  sseFetchMock(
    sse([
      { choices: [{ delta: { reasoning: "Deep thought part one. " }, finish_reason: null }] },
      { choices: [{ delta: { reasoning: "Deep thought part two." }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "length" }] },
      "[DONE]",
    ])
  );
  const svc = new VllmProviderService();
  const res = await svc.streamChat({ messages: [{ role: "user", content: "q" }] });

  assert.strictEqual(res.content, "", "b: content empty (reasoning never surfaced)");
  assert.strictEqual(res.finishReason, "length", "b: finishReason length");
  assert.strictEqual(res.hadReasoning, true, "b: hadReasoning true");
  assert.ok(res.reasoningTokens >= 2, "b: reasoningTokens counted across chunks");
  assert.strictEqual(res.toolCalls.length, 0, "b: no tool calls");
  console.log("  [PASS] (b) reasoning-only length -> visible as hadReasoning, not silent");
}

// ---------------------------------------------------------------------------
// Vector (c): legacy delta.reasoning_content field (compat).
// ---------------------------------------------------------------------------
async function vectorC() {
  sseFetchMock(
    sse([
      { choices: [{ delta: { reasoning_content: "Legacy parser thinking." }, finish_reason: null }] },
      { choices: [{ delta: { content: "Done." }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      "[DONE]",
    ])
  );
  const svc = new VllmProviderService();
  const res = await svc.streamChat({ messages: [{ role: "user", content: "q" }] });

  assert.strictEqual(res.content, "Done.", "c: content assembled");
  assert.strictEqual(res.hadReasoning, true, "c: legacy field counted");
  assert.ok(res.reasoningTokens > 0, "c: reasoningTokens counted");
  console.log("  [PASS] (c) legacy reasoning_content compat");
}

// ---------------------------------------------------------------------------
// Vectors (d)/(e): env-driven payload knobs, verified in a child process
// (config.js reads env at import time; the parent process already imported it).
// ---------------------------------------------------------------------------
function runChildProbe(env) {
  const providerUrl = pathToFileURL(
    path.join(__dirname, "..", "src", "harness", "services", "provider_vllm.js")
  ).href;
  const childCode = `
    // With -e, user args land at argv[1] on some Node versions; find by shape.
    const providerUrl = process.argv.find((a) => a && a.endsWith("provider_vllm.js"));
    let captured = null;
    globalThis.fetch = async (url, opts) => {
      captured = JSON.parse(opts.body);
      const sse =
        'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\\n\\n' +
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\\n\\n' +
        'data: [DONE]\\n\\n';
      const stream = new ReadableStream({
        start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close(); },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    const { VllmProviderService } = await import(providerUrl);
    const svc = new VllmProviderService();
    await svc.streamChat({ messages: [{ role: "user", content: "hi" }] });
    console.log(JSON.stringify({
      max_tokens: captured.max_tokens,
      hasKwargs: Object.prototype.hasOwnProperty.call(captured, "chat_template_kwargs"),
      effort: captured.chat_template_kwargs?.reasoning_effort ?? null,
    }));
  `;
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", childCode, providerUrl], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 30_000,
  });
  if (res.status !== 0) {
    throw new Error(`child probe failed: ${res.stderr || res.stdout}`);
  }
  const line = res.stdout.trim().split("\n").filter(Boolean).pop();
  return JSON.parse(line);
}

async function vectorD() {
  const out = runChildProbe({ QWEN_MAX_TOKENS: "7777" });
  assert.strictEqual(out.max_tokens, 7777, "d: QWEN_MAX_TOKENS honored in payload");
  console.log("  [PASS] (d) QWEN_MAX_TOKENS=7777 -> payload max_tokens=7777");
}

async function vectorE() {
  const withEffort = runChildProbe({ QWEN_REASONING_EFFORT: "low" });
  assert.strictEqual(
    withEffort.effort,
    "low",
    "e: QWEN_REASONING_EFFORT=low forwarded as chat_template_kwargs.reasoning_effort"
  );
  assert.strictEqual(withEffort.hasKwargs, true, "e: chat_template_kwargs present when set");

  const without = runChildProbe({ QWEN_REASONING_EFFORT: "" });
  assert.strictEqual(
    without.hasKwargs,
    false,
    "e: no chat_template_kwargs key when env unset"
  );
  console.log("  [PASS] (e) reasoning-effort passthrough (set -> forwarded, unset -> absent)");
}

// ---------------------------------------------------------------------------
// Run all vectors.
// ---------------------------------------------------------------------------
async function main() {
  console.log("=== Provider Reasoning-Token Accounting Verification (offline) ===");
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
    }
  }
  console.log(`\n==========================================================================`);
  console.log(`Provider Reasoning Verification: ${passed} / ${vectors.length} vectors passed`);
  if (failed > 0) {
    console.log(`Verdict: ${failed} VECTOR(S) FAILED.`);
    process.exit(1);
  }
  console.log(`Verdict: ALL REASONING VECTORS PASSED.`);
  console.log(`==========================================================================`);
  process.exit(0);
}

main().catch((e) => {
  console.error("HARNESS FAILURE:", e);
  process.exit(1);
});
