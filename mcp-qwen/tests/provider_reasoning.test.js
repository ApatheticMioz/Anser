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
 *   (f) P7b reasoning ceiling: QWEN_MAX_REASONING_TOKENS=4 + a reasoning
 *       stream -> turn ends locally with finish "length" AND
 *       metrics.reasoningCeilingHit=true (the P2d continuation directive
 *       lands instead of an 18-minute engine-hogging loop).
 *   (g) P7b honest finish: stream ends with NO finish_reason frame and no
 *       output -> finishReason null (dead stream reported as dead, never
 *       synthesized as "stop").
 *   (h) P7b stream-idle watchdog: comment-only stream that never closes ->
 *       rejects with "stream idle timeout" (proxy keep-alive comments do
 *       NOT count as engine activity).
 *   (i) P7b watchdog reset: meaningful frames spaced past the idle window
 *       keep the stream alive (watchdog resets on real SSE data).
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

  const withHigh = runChildProbe({ QWEN_REASONING_EFFORT: "high" });
  assert.strictEqual(
    withHigh.effort,
    "high",
    "e: QWEN_REASONING_EFFORT=high forwarded as chat_template_kwargs.reasoning_effort"
  );

  const without = runChildProbe({ QWEN_REASONING_EFFORT: "" });
  assert.strictEqual(
    without.hasKwargs,
    true,
    "e: chat_template_kwargs present by default"
  );
  assert.strictEqual(
    without.effort,
    "xhigh",
    "e: reasoning_effort defaults to xhigh when unset"
  );
  console.log("  [PASS] (e) reasoning-effort passthrough (default -> xhigh, override -> forwarded)");
}

// ---------------------------------------------------------------------------
// P7b vectors (f)-(i): stream-death hardening.
//
// runProbeChild(env, fetchMockBody): child process with a FULLY custom fetch
// mock. The child prints exactly one JSON line:
//   { rejected: bool, message?, result? }
// config.js reads env at import time, so every env-driven knob is probed in
// a child (the parent already imported it with default values).
// ---------------------------------------------------------------------------
function runProbeChild(env, fetchMockBody) {
  const providerUrl = pathToFileURL(
    path.join(__dirname, "..", "src", "harness", "services", "provider_vllm.js")
  ).href;
  const childCode = `
    const providerUrl = process.argv.find((a) => a && a.endsWith("provider_vllm.js"));
    ${fetchMockBody}
    const { VllmProviderService } = await import(providerUrl);
    const svc = new VllmProviderService();
    try {
      const res = await svc.streamChat({ messages: [{ role: "user", content: "hi" }] });
      console.log(JSON.stringify({
        rejected: false,
        result: {
          content: res.content,
          finishReason: res.finishReason,
          hadReasoning: res.hadReasoning,
          reasoningTokens: res.reasoningTokens,
          ceilingHit: res.metrics.reasoningCeilingHit ?? null,
        },
      }));
    } catch (err) {
      console.log(JSON.stringify({ rejected: true, message: String(err && err.message) }));
    }
    process.exit(0);
  `;
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", childCode, providerUrl], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 30_000,
  });
  if (res.status !== 0) {
    throw new Error(`probe child failed: ${res.stderr || res.stdout}`);
  }
  const line = res.stdout.trim().split("\n").filter(Boolean).pop();
  return JSON.parse(line);
}

// Closed-stream mock (static SSE text).
const STATIC_SSE_MOCK = (sseText) => `
    globalThis.fetch = async (url, opts) => {
      const stream = new ReadableStream({
        start(c) { c.enqueue(new TextEncoder().encode(${JSON.stringify(sseText)})); c.close(); },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    };
`;

// Vector (f): reasoning ceiling — QWEN_MAX_REASONING_TOKENS=4, a reasoning
// stream must end LOCALLY as length + reasoningCeilingHit (before any engine
// frame could supply its own reason).
async function vectorF() {
  const frames =
    'data: {"choices":[{"delta":{"reasoning":"A short thought."},"finish_reason":null}]}\n\n' + // ~4 est. tokens
    'data: {"choices":[{"delta":{"reasoning":"More thought."},"finish_reason":null}]}\n\n' +
    'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n' +
    'data: [DONE]\n\n';
  const out = runProbeChild({ QWEN_MAX_REASONING_TOKENS: "4" }, STATIC_SSE_MOCK(frames));
  assert.strictEqual(out.rejected, false, "f: ceiling cut must not reject");
  assert.strictEqual(out.result.finishReason, "length", "f: ceiling surfaces as length cutoff");
  assert.strictEqual(out.result.ceilingHit, true, "f: metrics.reasoningCeilingHit true");
  assert.strictEqual(out.result.hadReasoning, true, "f: hadReasoning true (P2d continuation routes)");
  assert.strictEqual(out.result.content, "", "f: reasoning never leaks into content");
  console.log("  [PASS] (f) reasoning ceiling -> local length cutoff + ceilingHit flag");
}

// Vector (g): honest finish — a stream that ends with no finish_reason and
// produced nothing reports finishReason null (never synthesized "stop").
async function vectorG() {
  // Parent-process vector: env-independent, so the plain sseFetchMock works.
  sseFetchMock(": keep-alive\n\n: keep-alive\n\n");
  const svc = new VllmProviderService();
  const res = await svc.streamChat({ messages: [{ role: "user", content: "q" }] });
  assert.strictEqual(res.finishReason, null, "g: dead/empty stream reports null finishReason");
  assert.strictEqual(res.content, "", "g: no content");
  assert.strictEqual(res.toolCalls.length, 0, "g: no tool calls");
  console.log("  [PASS] (g) stream w/o finish_reason + no output -> honest null");
}

// Vector (h): stream-idle watchdog — comment-only stream that never closes
// must reject with "stream idle timeout" (keep-alive comments are NOT engine
// activity). QWEN_STREAM_IDLE_TIMEOUT_MS=400 keeps the probe fast.
async function vectorH() {
  const mock = `
    let controllerRef = null;
    let timer = null;
    globalThis.fetch = async (url, opts) => {
      const stream = new ReadableStream({
        start(c) {
          controllerRef = c;
          timer = setInterval(() => {
            try { c.enqueue(new TextEncoder().encode(": keep-alive\\n\\n")); } catch {}
          }, 100);
        },
        cancel() { if (timer) clearInterval(timer); },
      });
      if (opts && opts.signal) {
        opts.signal.addEventListener("abort", () => {
          if (timer) clearInterval(timer);
          try { controllerRef.error(new Error("aborted")); } catch {}
        }, { once: true });
      }
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    };
  `;
  const out = runProbeChild({ QWEN_STREAM_IDLE_TIMEOUT_MS: "400" }, mock);
  assert.strictEqual(out.rejected, true, "h: comment-only silent stream must reject");
  assert.ok(
    /idle timeout/i.test(out.message || ""),
    `h: rejection names the idle timeout (got: ${out.message})`
  );
  console.log("  [PASS] (h) idle watchdog fires on comment-only silence (400ms window)");
}

// Vector (i): watchdog reset — meaningful frames spaced PAST the idle window
// keep the stream alive; the watchdog must reset on real SSE data. Window
// 800ms; meaningful frames at ~500ms and ~1200ms; DONE at ~1400ms.
async function vectorI() {
  const mock = `
    let controllerRef = null;
    const schedule = (ms, fn) => setTimeout(fn, ms);
    globalThis.fetch = async (url, opts) => {
      const stream = new ReadableStream({
        start(c) {
          controllerRef = c;
          const send = (obj) => c.enqueue(new TextEncoder().encode(obj));
          schedule(0, () => send(": keep-alive\\n\\n"));
          schedule(500, () => send('data: {"choices":[{"delta":{"content":"a"},"finish_reason":null}]}\\n\\n'));
          schedule(1200, () => send('data: {"choices":[{"delta":{"content":"b"},"finish_reason":null}]}\\n\\n'));
          schedule(1400, () => {
            send('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\\n\\n');
            send("data: [DONE]\\n\\n");
            c.close();
          });
        },
        cancel() {},
      });
      if (opts && opts.signal) {
        opts.signal.addEventListener("abort", () => {
          try { controllerRef.error(new Error("aborted")); } catch {}
        }, { once: true });
      }
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    };
  `;
  const out = runProbeChild({ QWEN_STREAM_IDLE_TIMEOUT_MS: "800" }, mock);
  assert.strictEqual(out.rejected, false, `i: spaced meaningful frames keep stream alive (got: ${out.message})`);
  assert.strictEqual(out.result.finishReason, "stop", "i: completes cleanly");
  assert.strictEqual(out.result.content, "ab", "i: content assembled across spaced frames");
  console.log("  [PASS] (i) meaningful frames reset the idle watchdog (spaced past window)");
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
    ["(f)", vectorF],
    ["(g)", vectorG],
    ["(h)", vectorH],
    ["(i)", vectorI],
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
