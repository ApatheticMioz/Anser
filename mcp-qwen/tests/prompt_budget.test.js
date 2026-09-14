#!/usr/bin/env node
/**
 * M7 (P2, F1/F2) — Dispatch Prompt-Budget Telemetry Verification (fully OFFLINE).
 *
 * Context: the audit's failure cluster (27/45 dispatches over budget; monolithic
 * mega-prompt failures) correlates with dispatch prompts over ~1,500 chars. The
 * runner is the only component with the session event sink (anser_runner has
 * none — established M5b), so it is the right place to surface this. When the
 * finalTaskPrompt (the `prompt` that arrives as run({prompt})) exceeds
 * PROMPT_BUDGET_CHARS, the runner emits ONE advisory `prompt_over_budget`
 * event (fields: promptChars, budget) at the start of run().
 *
 * This suite proves the runner's M7 telemetry:
 *   (a) over-budget: a prompt longer than the budget emits EXACTLY ONE
 *       `prompt_over_budget` event (even across a multi-turn run) with the
 *       correct fields (promptChars === prompt.length, budget === the
 *       configured budget). Advisory-only: the session still completes and the
 *       prompt is passed to the model verbatim (never truncated).
 *   (b) under-budget: a prompt at or below the budget emits NO
 *       `prompt_over_budget` event.
 *   (c) boundary: a prompt EXACTLY equal to the budget emits NO event (the
 *       check is strictly greater-than, so a prompt that merely reaches the
 *       budget is not flagged).
 *   (d) env + default: the budget is overridable via QWEN_PROMPT_BUDGET_CHARS
 *       (a child process with the override reads the overridden value) and
 *       falls back to DEFAULT_PROMPT_BUDGET_CHARS (1500) when the env is
 *       absent (a child process with a clean env reads the default).
 *
 * No vLLM, no network. The LLM provider and event logger are injected via the
 * runner's constructor seams (this._llm / this._logger) — the same
 * mock-injection pattern as degenerate_final.test.js. config.js reads env at
 * import time, so the env-driven knob (vector d) is probed in a CHILD process
 * (the parent already imported it with the test override); the prompt length
 * is passed via argv so a long prompt never hits the OS arg-length limit.
 *
 * Run: node tests/prompt_budget.test.js
 */

import assert from "node:assert";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Set the budget BEFORE importing the runner so the config module picks it up
// at load time. 100 is a small value so the test prompts are short and the
// suite is fast; the exact value is irrelevant to the logic under test (the
// runner compares prompt.length against whatever the config resolved).
process.env.QWEN_PROMPT_BUDGET_CHARS = "100";

const { AnserRunner } = await import("../src/harness/runner.js");
const {
  PROMPT_BUDGET_CHARS,
  DEFAULT_PROMPT_BUDGET_CHARS,
} = await import("../src/config.js");

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
        // Keep promptTokens at 0 so the M5a context_depth_warning (65536)
        // never fires and cannot be confused with the M7 event under test.
        promptTokens: 0,
        completionTokens: (step.content || "").length,
        ttftMs: 1,
        totalMs: 1,
        tokensPerSec: 0,
        hadReasoning: step.hadReasoning ?? false,
      };
      // If the step explicitly carries a "finishReason" key (even if it is
      // undefined), honor it verbatim. Otherwise default to "stop".
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

// A NEUTRAL keep-alive tool call (read_file). It is neither a bash call
// (does not increment the M4 probe streak) nor a mutating tool (does not
// reset it), so it keeps the session alive across a second turn without
// disturbing any other watchdog. A non-existent path is fine: executeTool's
// try/catch converts the ENOENT throw into an {isError:true} result (never
// propagates), so the turn cleanly "has tool calls" and the session continues.
function makeReadCall(id, n) {
  return {
    id,
    type: "function",
    function: {
      name: "read_file",
      arguments: JSON.stringify({ path: `keepalive_${n}.txt` }),
    },
  };
}

// ---------------------------------------------------------------------------
// Vector (a): over-budget. A prompt longer than the budget (200 > 100) emits
// EXACTLY ONE prompt_over_budget event with the correct fields, even across a
// multi-turn run (the event is emitted once, before the turn loop, so it
// cannot re-fire per turn). Advisory-only: the session completes and the
// prompt is passed to the model verbatim (never truncated).
// ---------------------------------------------------------------------------
async function vectorOverBudget() {
  const prompt = "x".repeat(200); // 200 chars > budget (100)
  const llm = makeMockLlm([
    // Turn 1: a neutral keep-alive tool call (the session continues).
    { content: "", toolCalls: [makeReadCall("call_a1", 1)], finishReason: "stop" },
    // Turn 2: the model concludes its turn.
    { content: "Done with the over-budget prompt.", finishReason: "stop" },
  ]);
  const logger = makeMockLogger();
  const runner = new AnserRunner({ llm, logger });

  const res = await runner.run({
    prompt,
    sessionId: "prompt_budget_a",
    maxTurns: 20,
  });

  // Advisory-only: the session still completes (the event never errors it).
  assert.strictEqual(
    res.status,
    "completed",
    "a: status must be 'completed' (advisory-only, not an error)"
  );
  // Exactly ONE prompt_over_budget event (emitted once, before the loop — it
  // does NOT re-fire on the second turn).
  const events = logger.events.filter((e) => e.type === "prompt_over_budget");
  assert.strictEqual(
    events.length,
    1,
    `a: exactly ONE prompt_over_budget event (got ${events.length})`
  );
  // The event carries the correct fields: the actual prompt length and the
  // configured budget.
  assert.strictEqual(
    events[0].promptChars,
    prompt.length,
    `a: event.promptChars must equal the prompt length (${prompt.length})`
  );
  assert.strictEqual(
    events[0].budget,
    PROMPT_BUDGET_CHARS,
    `a: event.budget must equal the configured budget (${PROMPT_BUDGET_CHARS})`
  );
  // The prompt is passed to the model VERBATIM (never truncated): the last
  // user-role message in the conversation is the original 200-char prompt.
  const userMsgs = (llm._lastMessages || []).filter((m) => m.role === "user");
  const promptMsgs = userMsgs.filter((m) => m.content === prompt);
  assert.strictEqual(
    promptMsgs.length,
    1,
    "a: the original prompt is passed to the model verbatim (not truncated)"
  );
  console.log(
    `  [PASS] (a) over-budget (${prompt.length} > ${PROMPT_BUDGET_CHARS}) -> exactly ONE prompt_over_budget event {promptChars:${events[0].promptChars}, budget:${events[0].budget}}, session 'completed', prompt verbatim`
  );
}

// ---------------------------------------------------------------------------
// Vector (b): under-budget. A prompt shorter than the budget (50 < 100) emits
// NO prompt_over_budget event.
// ---------------------------------------------------------------------------
async function vectorUnderBudget() {
  const prompt = "x".repeat(50); // 50 chars < budget (100)
  const llm = makeMockLlm([
    { content: "Done with the short prompt.", finishReason: "stop" },
  ]);
  const logger = makeMockLogger();
  const runner = new AnserRunner({ llm, logger });

  const res = await runner.run({
    prompt,
    sessionId: "prompt_budget_b",
    maxTurns: 20,
  });

  assert.strictEqual(
    res.status,
    "completed",
    "b: status must be 'completed'"
  );
  // No prompt_over_budget event: the prompt is under the budget.
  assert.strictEqual(
    countType(logger, "prompt_over_budget"),
    0,
    "b: NO prompt_over_budget event (prompt is under the budget)"
  );
  console.log(
    `  [PASS] (b) under-budget (${prompt.length} < ${PROMPT_BUDGET_CHARS}) -> NO prompt_over_budget event`
  );
}

// ---------------------------------------------------------------------------
// Vector (c): boundary. A prompt EXACTLY equal to the budget (100 == 100)
// emits NO event — the check is strictly greater-than, so a prompt that merely
// reaches the budget is not flagged.
// ---------------------------------------------------------------------------
async function vectorBoundary() {
  const prompt = "x".repeat(PROMPT_BUDGET_CHARS); // exactly == budget
  const llm = makeMockLlm([
    { content: "Done at the boundary.", finishReason: "stop" },
  ]);
  const logger = makeMockLogger();
  const runner = new AnserRunner({ llm, logger });

  const res = await runner.run({
    prompt,
    sessionId: "prompt_budget_c",
    maxTurns: 20,
  });

  assert.strictEqual(
    res.status,
    "completed",
    "c: status must be 'completed'"
  );
  // Exactly-at-budget is NOT over budget (strictly greater-than check).
  assert.strictEqual(
    countType(logger, "prompt_over_budget"),
    0,
    "c: NO prompt_over_budget event when prompt.length === budget (strictly >)"
  );
  console.log(
    `  [PASS] (c) boundary (prompt.length === budget ${PROMPT_BUDGET_CHARS}) -> NO event (strictly-greater check)`
  );
}

// ---------------------------------------------------------------------------
// Vector (d): env override + default. config.js reads env at import time, so
// the env-driven knob is probed in a CHILD process (the parent already
// imported it with the test override). Two probes:
//   (i)   with QWEN_PROMPT_BUDGET_CHARS="250" -> PROMPT_BUDGET_CHARS === 250
//         (the env override is honored).
//   (ii)  with a CLEAN env (no QWEN_*) -> PROMPT_BUDGET_CHARS ===
//         DEFAULT_PROMPT_BUDGET_CHARS (1500) (the default applies).
// ---------------------------------------------------------------------------
function probeConfigChild(env) {
  const configUrl = pathToFileURL(
    path.join(__dirname, "..", "src", "config.js")
  ).href;
  const childCode = `
    const configUrl = process.argv.find((a) => a && a.endsWith("config.js"));
    const cfg = await import(configUrl);
    console.log(JSON.stringify({
      budget: cfg.PROMPT_BUDGET_CHARS,
      default: cfg.DEFAULT_PROMPT_BUDGET_CHARS,
    }));
  `;
  // Clean env: strip any QWEN_* overrides so only the specific knob passed in
  // applies (config.js reads env at import time in the child).
  const cleanEnv = { ...process.env };
  for (const k of Object.keys(cleanEnv)) {
    if (k.startsWith("QWEN_")) delete cleanEnv[k];
  }
  const res = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", childCode, configUrl],
    { encoding: "utf8", env: { ...cleanEnv, ...env }, timeout: 30_000 }
  );
  if (res.status !== 0) {
    throw new Error(`config child failed: ${res.stderr || res.stdout}`);
  }
  const line = res.stdout.trim().split("\n").filter(Boolean).pop();
  return JSON.parse(line);
}

async function vectorEnvAndDefault() {
  // (i) env override is honored.
  const overridden = probeConfigChild({ QWEN_PROMPT_BUDGET_CHARS: "250" });
  assert.strictEqual(
    overridden.budget,
    250,
    `d(i): QWEN_PROMPT_BUDGET_CHARS=250 -> budget 250 (got ${overridden.budget})`
  );
  // (ii) clean env -> the default applies.
  const defaulted = probeConfigChild({});
  assert.strictEqual(
    defaulted.budget,
    DEFAULT_PROMPT_BUDGET_CHARS,
    `d(ii): clean env -> budget === DEFAULT_PROMPT_BUDGET_CHARS (${DEFAULT_PROMPT_BUDGET_CHARS}, got ${defaulted.budget})`
  );
  // The default is the audit's observed over-budget threshold.
  assert.strictEqual(
    DEFAULT_PROMPT_BUDGET_CHARS,
    1500,
    `d: DEFAULT_PROMPT_BUDGET_CHARS must be 1500 (got ${DEFAULT_PROMPT_BUDGET_CHARS})`
  );
  console.log(
    `  [PASS] (d) env override honored (250) + clean-env default (${DEFAULT_PROMPT_BUDGET_CHARS})`
  );
}

// ---------------------------------------------------------------------------
// Run all vectors.
// ---------------------------------------------------------------------------
async function main() {
  console.log("=== M7 Dispatch Prompt-Budget Telemetry (offline) ===");
  console.log(
    `PROMPT_BUDGET_CHARS = ${PROMPT_BUDGET_CHARS}, ` +
      `DEFAULT_PROMPT_BUDGET_CHARS = ${DEFAULT_PROMPT_BUDGET_CHARS}\n`
  );

  let passed = 0;
  let failed = 0;
  const vectors = [
    ["(a)", vectorOverBudget],
    ["(b)", vectorUnderBudget],
    ["(c)", vectorBoundary],
    ["(d)", vectorEnvAndDefault],
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

  console.log("\n==========================================");
  console.log(`Prompt-Budget Telemetry: ${passed} PASSED, ${failed} FAILED`);
  console.log("==========================================");

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Prompt-budget test uncaught error:", err);
  process.exit(1);
});
