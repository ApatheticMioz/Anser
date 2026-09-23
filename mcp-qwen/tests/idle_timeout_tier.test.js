/**
 * M6a (P1, F6/N3): Depth-Aware Stream-Idle Timeout Verification (fully OFFLINE)
 *
 * Proves src/harness/services/provider_vllm.js arms the per-request idle
 * watchdog with a DEPTH-AWARE window instead of a single flat 900s:
 *
 *   (1) SHALLOW stream uses the SHALLOW value: a small-prompt turn that goes
 *       silent rejects with the SHALLOW window and the error string names the
 *       "shallow tier" (the 900s-equivalent default, injected tiny here).
 *   (2) DEEP stream uses the DEEP value: a deep-prompt turn that goes silent
 *       rejects with the DEEP window and the error string names the "deep
 *       tier" — a healthy >15-min deep-thinking turn is no longer killed by
 *       the shallow 900s window.
 *   (3) BOUNDARY at exactly 100k tokens: with the DEFAULT depth threshold
 *       (100_000), a prompt whose estimated tokens are EXACTLY 100_000 arms
 *       the deep tier, while 99_999 arms the shallow tier (the `>=` boundary).
 *   (4) DEFAULTS: with no QWEN_* overrides the config reads shallow=900000,
 *       deep=1800000, depth=100000.
 *
 * The error string carries the fired tier (e.g. "stream idle timeout (deep
 * tier, 800ms)"), and metrics.streamIdleTier / metrics.streamIdleTimeoutMs
 * report the tier + window that actually armed.
 *
 * No vLLM, no network. globalThis.fetch is monkey-patched in a CHILD process
 * (config.js reads env at import time, so every env-driven knob is probed in
 * a child). The prompt length is passed via argv (NOT embedded in the -e code)
 * so the 350k-char boundary prompt never hits the OS single-argument length
 * limit.
 */

import assert from "node:assert";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PROVIDER_REL = path.join("..", "src", "harness", "services", "provider_vllm.js");
const CONFIG_REL = path.join("..", "src", "config.js");

// ---------------------------------------------------------------------------
// SSE fetch mocks (embedded verbatim into the child's -e code).
// ---------------------------------------------------------------------------

// Silent stream: comment-only keep-alive frames that never close. The
// provider's idle watchdog must fire (comments are NOT engine activity).
const SILENT_MOCK = `
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

// Completing stream: one content delta, a stop finish_reason, then [DONE].
// Used for the boundary vectors (the tier is read from metrics, not a
// rejection, so the stream must complete cleanly).
const COMPLETE_MOCK = `
  globalThis.fetch = async (url, opts) => {
    const sse =
      'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\\n\\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\\n\\n' +
      'data: [DONE]\\n\\n';
    const stream = new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close(); },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
`;

// ---------------------------------------------------------------------------
// Child-process probe. The child:
//   - reads the prompt length from argv (__LEN__<n>),
//   - builds messages = [{ role: "user", content: "x".repeat(n) }],
//   - runs streamChat against the mocked fetch,
//   - prints exactly one JSON line: { rejected, message?, result? }.
// config.js reads env at import time, so every env-driven knob is probed in
// the child (the parent already imported it with default values).
// ---------------------------------------------------------------------------
function runProbeChild(env, fetchMockBody, contentLength) {
  const providerUrl = pathToFileURL(path.join(__dirname, PROVIDER_REL)).href;
  const childCode = `
    const providerUrl = process.argv.find((a) => a && a.endsWith("provider_vllm.js"));
    const lenArg = process.argv.find((a) => a && a.startsWith("__LEN__"));
    const contentLength = parseInt(lenArg ? lenArg.slice(7) : "0", 10);
    ${fetchMockBody}
    const { VllmProviderService } = await import(providerUrl);
    const svc = new VllmProviderService();
    const messages = [{ role: "user", content: "x".repeat(contentLength) }];
    try {
      const res = await svc.streamChat({ messages });
      console.log(JSON.stringify({
        rejected: false,
        result: {
          content: res.content,
          finishReason: res.finishReason,
          streamIdleTier: res.metrics.streamIdleTier ?? null,
          streamIdleTimeoutMs: res.metrics.streamIdleTimeoutMs ?? null,
        },
      }));
    } catch (err) {
      console.log(JSON.stringify({ rejected: true, message: String(err && err.message) }));
    }
    process.exit(0);
  `;
  const res = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", childCode, providerUrl, `__LEN__${contentLength}`],
    { encoding: "utf8", env: { ...process.env, ...env }, timeout: 30_000 }
  );
  if (res.status !== 0) {
    throw new Error(`probe child failed: ${res.stderr || res.stdout}`);
  }
  const line = res.stdout.trim().split("\n").filter(Boolean).pop();
  return JSON.parse(line);
}

// ---------------------------------------------------------------------------
// contentLenForEstimate(target): the content length L such that the provider's
// chars-based estimate (ceil(JSON.stringify(messages).length / 3.5)) equals
// `target` EXACTLY. The provider measures promptChars over the full
// [{role,content}] JSON, so we account for that wrapper's overhead.
// ---------------------------------------------------------------------------
function contentLenForEstimate(target) {
  const overhead = JSON.stringify([{ role: "user", content: "" }]).length;
  // est == target  <=>  3.5*(target-1) < overhead+L <= 3.5*target
  const lo = Math.floor(3.5 * (target - 1) - overhead) + 1; // smallest L with est >= target
  return lo;
}

// ---------------------------------------------------------------------------
// Vector (1): SHALLOW stream uses the SHALLOW value.
// Small prompt (est ~10) + silent stream + tiny injected windows. The
// rejection must name the "shallow tier" and carry the SHALLOW window (400ms),
// NOT the deep window (800ms).
// ---------------------------------------------------------------------------
async function vectorShallowSilent() {
  const out = runProbeChild(
    {
      QWEN_STREAM_IDLE_TIMEOUT_MS: "400",
      QWEN_STREAM_IDLE_TIMEOUT_DEEP_MS: "800",
      QWEN_STREAM_IDLE_DEPTH_TOKENS: "100000",
    },
    SILENT_MOCK,
    2 // "xx" -> est ~10, well below the depth threshold -> shallow
  );
  assert.strictEqual(out.rejected, true, "1: silent shallow stream must reject");
  assert.ok(
    /shallow tier/.test(out.message || ""),
    `1: error names the shallow tier (got: ${out.message})`
  );
  assert.ok(
    /400ms/.test(out.message || ""),
    `1: error carries the SHALLOW 400ms window, not the deep 800ms (got: ${out.message})`
  );
  console.log("  [PASS] (1) shallow stream uses the shallow value (400ms, 'shallow tier')");
}

// ---------------------------------------------------------------------------
// Vector (2): DEEP stream uses the DEEP value.
// Deep prompt (est ~123 >= injected depth threshold 100) + silent stream. The
// rejection must name the "deep tier" and carry the DEEP window (800ms), NOT
// the shallow 400ms — this is the fix for the 3 observed deep-turn deaths.
// ---------------------------------------------------------------------------
async function vectorDeepSilent() {
  const out = runProbeChild(
    {
      QWEN_STREAM_IDLE_TIMEOUT_MS: "400",
      QWEN_STREAM_IDLE_TIMEOUT_DEEP_MS: "800",
      QWEN_STREAM_IDLE_DEPTH_TOKENS: "100",
    },
    SILENT_MOCK,
    400 // "x"*400 -> est ~123 >= 100 -> deep
  );
  assert.strictEqual(out.rejected, true, "2: silent deep stream must reject");
  assert.ok(
    /deep tier/.test(out.message || ""),
    `2: error names the deep tier (got: ${out.message})`
  );
  assert.ok(
    /800ms/.test(out.message || ""),
    `2: error carries the DEEP 800ms window, not the shallow 400ms (got: ${out.message})`
  );
  console.log("  [PASS] (2) deep stream uses the deep value (800ms, 'deep tier')");
}

// ---------------------------------------------------------------------------
// Vector (3): BOUNDARY at exactly 100k tokens (the DEFAULT depth threshold).
// With no QWEN_STREAM_IDLE_DEPTH_TOKENS override (default 100_000):
// Vector (3): BOUNDARY at exactly 35k tokens (the DEFAULT depth threshold).
// With no QWEN_STREAM_IDLE_DEPTH_TOKENS override (default 35_000):
//   - est == 35_000   -> deep tier  (>= boundary)
//   - est == 34_999   -> shallow tier
// The stream COMPLETES (so no rejection); the tier is read from
// metrics.streamIdleTier / metrics.streamIdleTimeoutMs.
// ---------------------------------------------------------------------------
async function vectorBoundary() {
  // Deep side: est exactly 35_000.
  const deepLen = contentLenForEstimate(35000);
  const deepOut = runProbeChild(
    {
      QWEN_STREAM_IDLE_TIMEOUT_MS: "400",
      QWEN_STREAM_IDLE_TIMEOUT_DEEP_MS: "800",
      // do NOT override QWEN_STREAM_IDLE_DEPTH_TOKENS -> default 35_000
    },
    COMPLETE_MOCK,
    deepLen
  );
  assert.strictEqual(
    deepOut.rejected,
    false,
    `3: deep-boundary stream must complete (got: ${deepOut.message})`
  );
  assert.strictEqual(
    deepOut.result.streamIdleTier,
    "deep",
    `3: est==35000 (== threshold) -> deep tier (got: ${deepOut.result.streamIdleTier})`
  );
  assert.strictEqual(
    deepOut.result.streamIdleTimeoutMs,
    800,
    `3: deep-boundary armed the deep window (got: ${deepOut.result.streamIdleTimeoutMs})`
  );

  // Shallow side: est 34_999 (one below the threshold).
  const shallowLen = contentLenForEstimate(34999);
  const shallowOut = runProbeChild(
    {
      QWEN_STREAM_IDLE_TIMEOUT_MS: "400",
      QWEN_STREAM_IDLE_TIMEOUT_DEEP_MS: "800",
    },
    COMPLETE_MOCK,
    shallowLen
  );
  assert.strictEqual(
    shallowOut.rejected,
    false,
    `3: shallow-boundary stream must complete (got: ${shallowOut.message})`
  );
  assert.strictEqual(
    shallowOut.result.streamIdleTier,
    "shallow",
    `3: est==34999 (< threshold) -> shallow tier (got: ${shallowOut.result.streamIdleTier})`
  );
  assert.strictEqual(
    shallowOut.result.streamIdleTimeoutMs,
    400,
    `3: shallow-boundary armed the shallow window (got: ${shallowOut.result.streamIdleTimeoutMs})`
  );
  console.log(
    `  [PASS] (3) boundary at exactly 35k tokens (est==35000 -> deep, est==34999 -> shallow)`
  );
}

// ---------------------------------------------------------------------------
// Vector (4): DEFAULTS. With no QWEN_* overrides the config reads
// shallow=1200000, deep=2400000, depth=35000.
// ---------------------------------------------------------------------------
async function vectorDefaults() {
  const configUrl = pathToFileURL(path.join(__dirname, CONFIG_REL)).href;
  const childCode = `
    const configUrl = process.argv.find((a) => a && a.endsWith("config.js"));
    const cfg = await import(configUrl);
    console.log(JSON.stringify({
      shallow: cfg.STREAM_IDLE_TIMEOUT_MS,
      deep: cfg.STREAM_IDLE_TIMEOUT_MS_DEEP,
      depth: cfg.STREAM_IDLE_DEPTH_TOKENS,
    }));
  `;
  // Clean env: strip any QWEN_* overrides so the defaults apply.
  const cleanEnv = { ...process.env };
  for (const k of Object.keys(cleanEnv)) {
    if (k.startsWith("QWEN_")) delete cleanEnv[k];
  }
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", childCode, configUrl], {
    encoding: "utf8",
    env: cleanEnv,
    timeout: 30_000,
  });
  if (res.status !== 0) {
    throw new Error(`defaults child failed: ${res.stderr || res.stdout}`);
  }
  const line = res.stdout.trim().split("\n").filter(Boolean).pop();
  const out = JSON.parse(line);
  assert.strictEqual(out.shallow, 1200000, `4: default shallow = 1200000 (got: ${out.shallow})`);
  assert.strictEqual(out.deep, 2400000, `4: default deep = 2400000 (got: ${out.deep})`);
  assert.strictEqual(out.depth, 35000, `4: default depth threshold = 35000 (got: ${out.depth})`);
  console.log("  [PASS] (4) defaults: shallow=1200000, deep=2400000, depth=35000");
}

// ---------------------------------------------------------------------------
// Run all vectors.
// ---------------------------------------------------------------------------
async function main() {
  console.log("=== M6a Depth-Aware Stream-Idle Timeout Verification (offline) ===");
  let passed = 0;
  let failed = 0;
  const vectors = [
    ["(1)", vectorShallowSilent],
    ["(2)", vectorDeepSilent],
    ["(3)", vectorBoundary],
    ["(4)", vectorDefaults],
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
  console.log(`Idle-Timeout-Tier Verification: ${passed} / ${vectors.length} vectors passed`);
  if (failed > 0) {
    console.log(`Verdict: ${failed} VECTOR(S) FAILED.`);
    process.exit(1);
  }
  console.log(`Verdict: ALL IDLE-TIMEOUT-TIER VECTORS PASSED.`);
  console.log(`==========================================================================`);
  process.exit(0);
}

main().catch((e) => {
  console.error("HARNESS FAILURE:", e);
  process.exit(1);
});
