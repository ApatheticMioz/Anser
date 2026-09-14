#!/usr/bin/env node
/**
 * M4 — Probe-Budget Watchdog Verification (fully OFFLINE).
 *
 * Defect (F4/F12/F14, issue #11 recs 1+2): on open-ended layout targets the
 * model ran 30+ consecutive inline-python measurement bash calls (~90 min)
 * instead of making the edit. The single-pass mutation directive worked when
 * hand-injected but was not harness-enforced.
 *
 * This suite proves the runner's probe-budget watchdog:
 *   (a) 5 consecutive non-mutating bash calls (PROBE_BUDGET=4) -> exactly ONE
 *       advisory injected into the conversation + one `probe_budget_warning`
 *       event; the session still completes (advisory-only, not an error).
 *   (b) mutate-then-bash pattern (write_file between bash calls) -> NO warning
 *       (the mutating tool resets the streak).
 *   (c) verification bash separated by edits (edit_file between bash calls)
 *       -> NO warning (the edit resets the streak).
 *   (d) re-arm: after a warning is injected the counter resets, so a SECOND
 *       run of 5 consecutive bash calls triggers a SECOND warning (the
 *       watchdog re-arms for the next run of N, it does not latch).
 *
 * No vLLM, no network. The LLM provider and event logger are injected via the
 * runner's constructor seams (this._llm / this._logger). The bash / write_file
 * / edit_file tools are the REAL registered tools (the mock LLM merely scripts
 * which tool calls the model emits; the runner executes them for real).
 *
 * Run: node tests/probe_budget.test.js
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Set the probe budget BEFORE importing the runner so the config module picks
// it up at load time. 4 is the default; set explicitly for determinism.
process.env.QWEN_PROBE_BUDGET = "4";

const { AnserRunner, PROBE_BUDGET_ADVISORY } = await import(
  "../src/harness/runner.js"
);
const { PROBE_BUDGET } = await import("../src/config.js");

// ---------------------------------------------------------------------------
// Isolated temp workspace (the sandbox root for the real file tools).
// ---------------------------------------------------------------------------
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "probe_budget_"));

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

// ---------------------------------------------------------------------------
// Tool-call builders.
// ---------------------------------------------------------------------------
// A non-mutating bash call (a "probe"). `echo` is the simplest command that
// works in WSL, Git-Bash, and cmd.exe alike.
function makeBashCall(id, n) {
  return {
    id,
    type: "function",
    function: {
      name: "bash",
      arguments: JSON.stringify({ command: `echo probe-${n}` }),
    },
  };
}

// A mutating write_file call (resets the probe streak).
function makeWriteCall(id, file, content) {
  return {
    id,
    type: "function",
    function: {
      name: "write_file",
      arguments: JSON.stringify({ path: file, content }),
    },
  };
}

// A mutating edit_file call (resets the probe streak).
function makeEditCall(id, file, target, replacement) {
  return {
    id,
    type: "function",
    function: {
      name: "edit_file",
      arguments: JSON.stringify({
        path: file,
        target_content: target,
        replacement_content: replacement,
      }),
    },
  };
}

// ---------------------------------------------------------------------------
// Vector (a): 5 consecutive non-mutating bash calls (PROBE_BUDGET=4) ->
// exactly ONE advisory injected + one probe_budget_warning event; the session
// still completes (advisory-only, not an error / not a cancellation).
// ---------------------------------------------------------------------------
async function vectorA() {
  const llm = makeMockLlm([
    { content: "", toolCalls: [makeBashCall("call_a1", 1)], finishReason: "stop" },
    { content: "", toolCalls: [makeBashCall("call_a2", 2)], finishReason: "stop" },
    { content: "", toolCalls: [makeBashCall("call_a3", 3)], finishReason: "stop" },
    { content: "", toolCalls: [makeBashCall("call_a4", 4)], finishReason: "stop" },
    // 5th consecutive non-mutating bash call -> streak=5 > PROBE_BUDGET(4)
    // -> advisory injected + event, streak re-armed to 0.
    { content: "", toolCalls: [makeBashCall("call_a5", 5)], finishReason: "stop" },
    // The model concludes its turn (clean stop, no tool calls).
    { content: "Done after the probe run.", finishReason: "stop" },
  ]);
  const logger = makeMockLogger();
  const runner = new AnserRunner({ llm, logger });

  const res = await runner.run({
    prompt: "Measure the layout.",
    sessionId: "probe_a",
    cwd: TMP_DIR,
    maxTurns: 20,
  });

  // The session must still complete (advisory-only, not an error).
  assert.strictEqual(
    res.status,
    "completed",
    "a: status must be 'completed' (advisory does not fail the session)"
  );
  // Exactly ONE probe_budget_warning event (the 5th bash call tripped it).
  const warnings = logger.events.filter((e) => e.type === "probe_budget_warning");
  assert.strictEqual(
    warnings.length,
    1,
    `a: exactly ONE probe_budget_warning event (got ${warnings.length})`
  );
  // The event carries the telemetry fields.
  assert.strictEqual(
    warnings[0].consecutiveNonMutatingBash,
    5,
    "a: event records the streak that tripped the budget (5)"
  );
  assert.strictEqual(
    warnings[0].budget,
    PROBE_BUDGET,
    "a: event records the configured budget"
  );
  // The advisory was injected into the conversation as a user-role message.
  const advisoryMsgs = (llm._lastMessages || []).filter(
    (m) => m.role === "user" && m.content === PROBE_BUDGET_ADVISORY
  );
  assert.strictEqual(
    advisoryMsgs.length,
    1,
    "a: exactly one advisory user-message in the conversation"
  );
  console.log(
    `  [PASS] (a) 5 consecutive non-mutating bash calls -> 1 advisory + 1 probe_budget_warning event, session 'completed'`
  );
}

// ---------------------------------------------------------------------------
// Vector (b): mutate-then-bash pattern (write_file between bash calls) ->
// NO warning (the mutating tool resets the streak each time).
// ---------------------------------------------------------------------------
async function vectorB() {
  const file = path.join(TMP_DIR, "b_target.txt");
  const llm = makeMockLlm([
    { content: "", toolCalls: [makeBashCall("call_b1", 1)], finishReason: "stop" },
    // write_file resets the streak to 0.
    {
      content: "",
      toolCalls: [makeWriteCall("call_b2", "b_target.txt", "v1\n")],
      finishReason: "stop",
    },
    { content: "", toolCalls: [makeBashCall("call_b3", 2)], finishReason: "stop" },
    // write_file resets the streak to 0 again.
    {
      content: "",
      toolCalls: [makeWriteCall("call_b4", "b_target.txt", "v2\n")],
      finishReason: "stop",
    },
    { content: "", toolCalls: [makeBashCall("call_b5", 3)], finishReason: "stop" },
    // write_file resets the streak to 0 again.
    {
      content: "",
      toolCalls: [makeWriteCall("call_b6", "b_target.txt", "v3\n")],
      finishReason: "stop",
    },
    { content: "Done after the mutate-then-bash run.", finishReason: "stop" },
  ]);
  const logger = makeMockLogger();
  const runner = new AnserRunner({ llm, logger });

  const res = await runner.run({
    prompt: "Iterate on the file.",
    sessionId: "probe_b",
    cwd: TMP_DIR,
    maxTurns: 20,
  });

  assert.strictEqual(
    res.status,
    "completed",
    "b: status must be 'completed'"
  );
  // No warning: the write_file calls reset the streak before it can reach the
  // budget.
  assert.strictEqual(
    countType(logger, "probe_budget_warning"),
    0,
    "b: NO probe_budget_warning (mutating tool resets the streak)"
  );
  // The file was actually written (the real write_file tool ran).
  assert.ok(
    fs.existsSync(file),
    "b: the write_file tool actually wrote the target file"
  );
  console.log(
    "  [PASS] (b) mutate-then-bash (write_file between bash) -> NO warning"
  );
}

// ---------------------------------------------------------------------------
// Vector (c): verification bash separated by edits (edit_file between bash
// calls) -> NO warning (the edit resets the streak each time).
// ---------------------------------------------------------------------------
async function vectorC() {
  // Seed the file that edit_file will modify.
  const file = path.join(TMP_DIR, "c_target.txt");
  fs.writeFileSync(file, "alpha\nbeta\ngamma\n", "utf8");

  const llm = makeMockLlm([
    { content: "", toolCalls: [makeBashCall("call_c1", 1)], finishReason: "stop" },
    // edit_file resets the streak to 0.
    {
      content: "",
      toolCalls: [makeEditCall("call_c2", "c_target.txt", "alpha", "ALPHA")],
      finishReason: "stop",
    },
    { content: "", toolCalls: [makeBashCall("call_c3", 2)], finishReason: "stop" },
    // edit_file resets the streak to 0 again.
    {
      content: "",
      toolCalls: [makeEditCall("call_c4", "c_target.txt", "beta", "BETA")],
      finishReason: "stop",
    },
    { content: "", toolCalls: [makeBashCall("call_c5", 3)], finishReason: "stop" },
    // edit_file resets the streak to 0 again.
    {
      content: "",
      toolCalls: [makeEditCall("call_c6", "c_target.txt", "gamma", "GAMMA")],
      finishReason: "stop",
    },
    { content: "Done after the edit-then-verify run.", finishReason: "stop" },
  ]);
  const logger = makeMockLogger();
  const runner = new AnserRunner({ llm, logger });

  const res = await runner.run({
    prompt: "Edit and verify.",
    sessionId: "probe_c",
    cwd: TMP_DIR,
    maxTurns: 20,
  });

  assert.strictEqual(
    res.status,
    "completed",
    "c: status must be 'completed'"
  );
  // No warning: the edit_file calls reset the streak before it can reach the
  // budget.
  assert.strictEqual(
    countType(logger, "probe_budget_warning"),
    0,
    "c: NO probe_budget_warning (edit_file resets the streak)"
  );
  // The edits actually landed (the real edit_file tool ran).
  const edited = fs.readFileSync(file, "utf8");
  assert.ok(
    edited.includes("ALPHA") && edited.includes("BETA") && edited.includes("GAMMA"),
    "c: the edit_file tool actually applied the edits"
  );
  console.log(
    "  [PASS] (c) verification bash separated by edits (edit_file between bash) -> NO warning"
  );
}

// ---------------------------------------------------------------------------
// Vector (d): re-arm — after a warning is injected the counter resets, so a
// SECOND run of 5 consecutive bash calls triggers a SECOND warning (the
// watchdog re-arms for the next run of N; it does not latch).
// ---------------------------------------------------------------------------
async function vectorD() {
  const llm = makeMockLlm([
    // First run of 5 consecutive non-mutating bash calls.
    { content: "", toolCalls: [makeBashCall("call_d1", 1)], finishReason: "stop" },
    { content: "", toolCalls: [makeBashCall("call_d2", 2)], finishReason: "stop" },
    { content: "", toolCalls: [makeBashCall("call_d3", 3)], finishReason: "stop" },
    { content: "", toolCalls: [makeBashCall("call_d4", 4)], finishReason: "stop" },
    // 5th -> streak=5 > 4 -> WARNING #1, streak re-armed to 0.
    { content: "", toolCalls: [makeBashCall("call_d5", 5)], finishReason: "stop" },
    // Second run of 5 consecutive non-mutating bash calls (streak re-armed).
    { content: "", toolCalls: [makeBashCall("call_d6", 6)], finishReason: "stop" },
    { content: "", toolCalls: [makeBashCall("call_d7", 7)], finishReason: "stop" },
    { content: "", toolCalls: [makeBashCall("call_d8", 8)], finishReason: "stop" },
    { content: "", toolCalls: [makeBashCall("call_d9", 9)], finishReason: "stop" },
    // 10th -> streak=5 > 4 -> WARNING #2, streak re-armed to 0.
    { content: "", toolCalls: [makeBashCall("call_d10", 10)], finishReason: "stop" },
    { content: "Done after two probe runs.", finishReason: "stop" },
  ]);
  const logger = makeMockLogger();
  const runner = new AnserRunner({ llm, logger });

  const res = await runner.run({
    prompt: "Measure twice.",
    sessionId: "probe_d",
    cwd: TMP_DIR,
    maxTurns: 30,
  });

  assert.strictEqual(
    res.status,
    "completed",
    "d: status must be 'completed'"
  );
  // Two warnings: one per run of 5 consecutive non-mutating bash calls.
  const warnings = logger.events.filter((e) => e.type === "probe_budget_warning");
  assert.strictEqual(
    warnings.length,
    2,
    `d: exactly TWO probe_budget_warning events (re-arm) — got ${warnings.length}`
  );
  // Both advisories were injected into the conversation.
  const advisoryMsgs = (llm._lastMessages || []).filter(
    (m) => m.role === "user" && m.content === PROBE_BUDGET_ADVISORY
  );
  assert.strictEqual(
    advisoryMsgs.length,
    2,
    "d: exactly two advisory user-messages in the conversation"
  );
  console.log(
    "  [PASS] (d) re-arm: two runs of 5 consecutive bash calls -> TWO warnings (counter re-arms, does not latch)"
  );
}

// ---------------------------------------------------------------------------
// Run all vectors.
// ---------------------------------------------------------------------------
async function main() {
  console.log("=== M4 Probe-Budget Watchdog Verification (offline) ===");
  console.log(`PROBE_BUDGET = ${PROBE_BUDGET}`);
  console.log(`ADVISORY = ${JSON.stringify(PROBE_BUDGET_ADVISORY)}\n`);

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

  console.log("\n==========================================");
  console.log(`Probe-Budget Watchdog: ${passed} PASSED, ${failed} FAILED`);
  console.log("==========================================");

  // Clean up the temp workspace.
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {}

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Probe-budget test uncaught error:", err);
  process.exit(1);
});
