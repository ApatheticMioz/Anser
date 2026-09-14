#!/usr/bin/env node
/**
 * M6b (P1, completes M6) — Depth-Aware Empty-Stream Retry Budget + Backoff
 * Verification (fully OFFLINE).
 *
 * Proves src/harness/runner.js:
 *   (1) SHALLOW-depth exhaustion: a shallow prompt (promptChars < the depth
 *       threshold) that always returns empty generations exhausts the BASE
 *       budget (2) and reports the honest status "engine_empty_response" after
 *       exactly 2 retries (3 turns). The budget is respected — no infinite
 *       retries.
 *   (2) DEEP-depth allows a 3rd retry: a deep prompt (promptChars >= the depth
 *       threshold) that returns empty 3 times then recovers gets the DEEP
 *       budget (4), so the 3rd retry is allowed and the session completes.
 *       (This is the audit §5.2 fix: a flat budget of 2 exhausted before a
 *       transient cluster cleared at high context.)
 *   (3) Backoff grows 2s->4s: with the DEFAULT backoff (base 2000ms, cap
 *       30000ms), the recorded backoffMs in the empty_stream_retry event grows
 *       2000 (retry 1) -> 4000 (retry 2).
 *   (4) Defaults: with no QWEN_* overrides the config reads base=2, deep=4,
 *       depth=525000, backoff base=2000, cap=30000.
 *
 * No vLLM, no network. The LLM provider and event logger are injected via the
 * runner's constructor seams (this._llm / this._logger) — the same
 * mock-injection pattern as degenerate_final.test.js. config.js reads env at
 * import time, so every env-driven knob is probed in a CHILD process (the
 * parent already imported it with default values); the prompt length and the
 * turn script are passed via argv (NOT embedded in the -e code) so the
 * ~524k-char deep prompt never hits the OS single-argument length limit.
 *
 * NOTE: vector (3) uses the real default backoff (base 2000ms) so the recorded
 * backoffMs is genuinely 2000/4000; it therefore sleeps ~6s (2s + 4s). The
 * other vectors shrink the backoff to milliseconds for speed.
 *
 * Run: node tests/deep_retry_budget.test.js
 */

import assert from "node:assert";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const RUNNER_REL = path.join("..", "src", "harness", "runner.js");
const CONFIG_REL = path.join("..", "src", "config.js");

// ---------------------------------------------------------------------------
// Child-process probe. The child:
//   - reads the prompt length (__LEN__<n>) and the turn script
//     (__SCRIPT__<name>) from argv,
//   - builds a mock LLM that returns the scripted sequence of turn results,
//   - runs the runner with the injected mock LLM + logger,
//   - prints exactly one JSON line:
//       { status, turnsTaken, llmCalls, retries: [{retryNumber, maxRetries,
//         backoffMs, reason, promptChars}] }.
// config.js reads env at import time, so every env-driven knob is probed in
// the child. The child's env is a CLEAN copy (all QWEN_* stripped) plus the
// specific overrides passed in, so no inherited QWEN_* can leak in.
// ---------------------------------------------------------------------------
function runProbeChild(env, contentLength, script) {
  const runnerUrl = pathToFileURL(path.join(__dirname, RUNNER_REL)).href;
  const childCode = `
    const runnerUrl = process.argv.find((a) => a && a.endsWith("runner.js"));
    const lenArg = process.argv.find((a) => a && a.startsWith("__LEN__"));
    const scriptArg = process.argv.find((a) => a && a.startsWith("__SCRIPT__"));
    const contentLength = parseInt(lenArg ? lenArg.slice(7) : "0", 10);
    // "__SCRIPT__" is 10 chars (2 + 6 + 2); slice(10) strips it exactly.
    const script = scriptArg ? scriptArg.slice(10) : "always_empty";

    // Mock LLM: returns a scripted sequence of turn results. The "empty" step
    // has NO real finish_reason (undefined) -> the P2b empty-generation path.
    // The "recovery" step is a clean stop-with-content turn.
    let call = 0;
    const empty = { content: "", toolCalls: [], finishReason: undefined };
    const recovery = { content: "Recovered after the empty stream.", finishReason: "stop" };
    const seq = {
      always_empty: [empty, empty, empty, empty, empty, empty],
      empty_empty_empty_recovery: [empty, empty, empty, recovery],
      empty_empty_recovery: [empty, empty, recovery],
    }[script] || [empty];
    const llm = {
      _calls: 0,
      async streamChat({ messages } = {}) {
        this._calls++;
        const step = seq[Math.min(call, seq.length - 1)];
        call++;
        return {
          content: step.content ?? "",
          toolCalls: step.toolCalls ?? [],
          finishReason: step.finishReason,
          hadReasoning: false,
          metrics: {
            promptTokens: 0,
            completionTokens: (step.content || "").length,
            ttftMs: 1,
            totalMs: 1,
            tokensPerSec: 0,
            hadReasoning: false,
          },
        };
      },
    };
    // In-memory mock logger (same surface the runner uses).
    const logger = {
      events: [],
      append(event) {
        const entry = { timestamp: new Date().toISOString(), ...event };
        this.events.push(entry);
        return entry;
      },
      readAll() { return this.events; },
      getConversationHistory() { return []; },
    };
    const { AnserRunner } = await import(runnerUrl);
    const runner = new AnserRunner({ llm, logger });
    const res = await runner.run({
      prompt: "x".repeat(contentLength),
      sessionId: "deep_retry_budget",
      maxTurns: 1000, // high so the retry bound, not maxTurns, governs
    });
    const retries = logger.events
      .filter((e) => e.type === "empty_stream_retry")
      .map((e) => ({
        retryNumber: e.retryNumber,
        maxRetries: e.maxRetries,
        backoffMs: e.backoffMs,
        reason: e.reason,
        promptChars: e.promptChars,
      }));
    console.log(JSON.stringify({
      status: res.status,
      turnsTaken: res.turnsTaken,
      llmCalls: llm._calls,
      retries,
    }));
    process.exit(0);
  `;
  // Clean env: strip any QWEN_* overrides so only the specific knobs passed in
  // apply (config.js reads env at import time in the child).
  const cleanEnv = { ...process.env };
  for (const k of Object.keys(cleanEnv)) {
    if (k.startsWith("QWEN_")) delete cleanEnv[k];
  }
  const res = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", childCode, runnerUrl, `__LEN__${contentLength}`, `__SCRIPT__${script}`],
    { encoding: "utf8", env: { ...cleanEnv, ...env }, timeout: 60_000 }
  );
  if (res.status !== 0) {
    throw new Error(`probe child failed: ${res.stderr || res.stdout}`);
  }
  const line = res.stdout.trim().split("\n").filter(Boolean).pop();
  return JSON.parse(line);
}

// Shared env for the fast vectors: base budget 2, deep budget 4, depth
// threshold 525000, and a TINY backoff (base 1ms, cap 100ms) so the actual
// sleep is milliseconds (the recorded backoffMs still follows the formula).
const FAST_ENV = {
  QWEN_EMPTY_STREAM_RETRIES: "2",
  QWEN_EMPTY_STREAM_RETRIES_DEEP: "4",
  QWEN_EMPTY_STREAM_RETRY_DEPTH_CHARS: "525000",
  QWEN_EMPTY_STREAM_RETRY_BACKOFF_BASE_MS: "1",
  QWEN_EMPTY_STREAM_RETRY_BACKOFF_CAP_MS: "100",
};

// ---------------------------------------------------------------------------
// Vector (1): SHALLOW-depth exhaustion. A shallow prompt (promptChars < depth
// threshold) that always returns empty generations exhausts the BASE budget
// (2) and reports "engine_empty_response" after exactly 2 retries (3 turns).
// The budget is respected — no infinite retries.
// ---------------------------------------------------------------------------
async function vectorShallowExhaustion() {
  const out = runProbeChild(FAST_ENV, 100, "always_empty"); // promptChars ~1642 < 525000
  assert.strictEqual(
    out.status,
    "engine_empty_response",
    "1: status must be engine_empty_response (honest failure), NOT a false 'completed'"
  );
  // The BASE budget (2) was consumed: exactly 2 retries.
  assert.strictEqual(out.retries.length, 2, "1: exactly 2 retries (base budget)");
  // Bounded: turns = bound + 1 (the final turn that hits the bound and breaks).
  assert.strictEqual(out.turnsTaken, 3, "1: 3 turns (2 retries + 1 exhaustion)");
  // Budget respected: maxRetries reports the base budget (2), not the deep one.
  assert.strictEqual(out.retries[0].maxRetries, 2, "1: maxRetries = base budget (2)");
  // Backoff grows exponentially (base 1ms): 1, 2.
  assert.strictEqual(out.retries[0].backoffMs, 1, "1: retry 1 backoffMs = 1 (base)");
  assert.strictEqual(out.retries[1].backoffMs, 2, "1: retry 2 backoffMs = 2 (2x base)");
  // Shallow: promptChars < depth threshold.
  assert.ok(
    out.retries[0].promptChars < 525000,
    `1: promptChars (${out.retries[0].promptChars}) < depth threshold (shallow)`
  );
  console.log(
    `  [PASS] (1) shallow exhaustion: ${out.retries.length} retries (base budget ${out.retries[0].maxRetries}), ${out.turnsTaken} turns, backoff [${out.retries.map((r) => r.backoffMs).join(",")}]`
  );
}

// ---------------------------------------------------------------------------
// Vector (2): DEEP-depth allows a 3rd retry. A deep prompt (promptChars >=
// depth threshold) that returns empty 3 times then recovers gets the DEEP
// budget (4), so the 3rd retry is allowed and the session completes.
// ---------------------------------------------------------------------------
async function vectorDeepThirdRetry() {
  const out = runProbeChild(FAST_ENV, 524000, "empty_empty_empty_recovery"); // promptChars ~525542 >= 525000
  assert.strictEqual(
    out.status,
    "completed",
    "2: status must be completed (recovered on the 3rd retry)"
  );
  // The DEEP budget (4) allows a 3rd retry: exactly 3 retries before recovery.
  assert.strictEqual(out.retries.length, 3, "2: exactly 3 retries (deep budget allows the 3rd)");
  // 4 turns: 3 empty (retried) + 1 recovery.
  assert.strictEqual(out.turnsTaken, 4, "2: 4 turns (3 retries + 1 recovery)");
  // Budget respected: maxRetries reports the DEEP budget (4), not the base (2).
  assert.strictEqual(out.retries[0].maxRetries, 4, "2: maxRetries = deep budget (4)");
  // Backoff grows exponentially (base 1ms): 1, 2, 4.
  assert.strictEqual(out.retries[0].backoffMs, 1, "2: retry 1 backoffMs = 1");
  assert.strictEqual(out.retries[1].backoffMs, 2, "2: retry 2 backoffMs = 2");
  assert.strictEqual(out.retries[2].backoffMs, 4, "2: retry 3 backoffMs = 4");
  // Deep: promptChars >= depth threshold.
  assert.ok(
    out.retries[0].promptChars >= 525000,
    `2: promptChars (${out.retries[0].promptChars}) >= depth threshold (deep)`
  );
  console.log(
    `  [PASS] (2) deep allows 3rd retry: ${out.retries.length} retries (deep budget ${out.retries[0].maxRetries}), ${out.turnsTaken} turns, backoff [${out.retries.map((r) => r.backoffMs).join(",")}]`
  );
}

// ---------------------------------------------------------------------------
// Vector (3): Backoff grows 2s->4s. With the DEFAULT backoff (base 2000ms,
// cap 30000ms), the recorded backoffMs in the empty_stream_retry event grows
// 2000 (retry 1) -> 4000 (retry 2). This uses the real default backoff, so it
// sleeps ~6s (2s + 4s).
// ---------------------------------------------------------------------------
async function vectorBackoffGrows() {
  const out = runProbeChild(
    {
      QWEN_EMPTY_STREAM_RETRIES: "2",
      QWEN_EMPTY_STREAM_RETRIES_DEEP: "4",
      QWEN_EMPTY_STREAM_RETRY_DEPTH_CHARS: "525000",
      // do NOT override the backoff -> default base 2000ms, cap 30000ms
    },
    100, // shallow prompt
    "empty_empty_recovery"
  );
  assert.strictEqual(out.status, "completed", "3: status must be completed (recovered on the 2nd retry)");
  assert.strictEqual(out.retries.length, 2, "3: exactly 2 retries");
  // Backoff grows 2s->4s (base 2000ms): 2000, 4000.
  assert.strictEqual(out.retries[0].backoffMs, 2000, "3: retry 1 backoffMs = 2000 (2s)");
  assert.strictEqual(out.retries[1].backoffMs, 4000, "3: retry 2 backoffMs = 4000 (4s)");
  console.log(
    `  [PASS] (3) backoff grows 2s->4s: [${out.retries.map((r) => r.backoffMs).join(",")}]`
  );
}

// ---------------------------------------------------------------------------
// Vector (4): Defaults. With no QWEN_* overrides the config reads base=2,
// deep=4, depth=525000, backoff base=2000, cap=30000.
// ---------------------------------------------------------------------------
async function vectorDefaults() {
  const configUrl = pathToFileURL(path.join(__dirname, CONFIG_REL)).href;
  const childCode = `
    const configUrl = process.argv.find((a) => a && a.endsWith("config.js"));
    const cfg = await import(configUrl);
    console.log(JSON.stringify({
      base: cfg.EMPTY_STREAM_RETRIES,
      deep: cfg.EMPTY_STREAM_RETRIES_DEEP,
      depth: cfg.EMPTY_STREAM_RETRY_DEPTH_CHARS,
      backoffBase: cfg.EMPTY_STREAM_RETRY_BACKOFF_BASE_MS,
      backoffCap: cfg.EMPTY_STREAM_RETRY_BACKOFF_CAP_MS,
    }));
  `;
  // Clean env: strip any QWEN_* overrides so the defaults apply.
  const cleanEnv = { ...process.env };
  for (const k of Object.keys(cleanEnv)) {
    if (k.startsWith("QWEN_")) delete cleanEnv[k];
  }
  const res = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", childCode, configUrl],
    { encoding: "utf8", env: cleanEnv, timeout: 30_000 }
  );
  if (res.status !== 0) {
    throw new Error(`defaults child failed: ${res.stderr || res.stdout}`);
  }
  const line = res.stdout.trim().split("\n").filter(Boolean).pop();
  const out = JSON.parse(line);
  assert.strictEqual(out.base, 2, `4: default base = 2 (got: ${out.base})`);
  assert.strictEqual(out.deep, 4, `4: default deep = 4 (got: ${out.deep})`);
  assert.strictEqual(out.depth, 525000, `4: default depth = 525000 (got: ${out.depth})`);
  assert.strictEqual(out.backoffBase, 2000, `4: default backoff base = 2000 (got: ${out.backoffBase})`);
  assert.strictEqual(out.backoffCap, 30000, `4: default backoff cap = 30000 (got: ${out.backoffCap})`);
  console.log("  [PASS] (4) defaults: base=2, deep=4, depth=525000, backoff base=2000, cap=30000");
}

// ---------------------------------------------------------------------------
// Run all vectors.
// ---------------------------------------------------------------------------
async function main() {
  console.log("=== M6b Depth-Aware Empty-Stream Retry Budget + Backoff (offline) ===\n");
  let passed = 0;
  let failed = 0;
  const vectors = [
    ["(1)", vectorShallowExhaustion],
    ["(2)", vectorDeepThirdRetry],
    ["(3)", vectorBackoffGrows],
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
  console.log(`Deep-Retry-Budget Verification: ${passed} / ${vectors.length} vectors passed`);
  if (failed > 0) {
    console.log(`Verdict: ${failed} VECTOR(S) FAILED.`);
    process.exit(1);
  }
  console.log(`Verdict: ALL DEEP-RETRY-BUDGET VECTORS PASSED.`);
  console.log(`==========================================================================`);
  process.exit(0);
}

main().catch((e) => {
  console.error("HARNESS FAILURE:", e);
  process.exit(1);
});
