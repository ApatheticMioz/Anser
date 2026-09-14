#!/usr/bin/env node
/**
 * M5a — Session-Rollover & Context-Depth Watchdog Verification (fully OFFLINE).
 *
 * Defect (issue #11 rec 3): the session's turn count is task-local in the
 * runner (turnsTaken), but the SESSION's cumulative turns span tasks — the
 * prior assistant_message events (from logger.readAll(), the same source
 * getConversationHistory() reads) plus this run's turnsTaken. A long-lived
 * session that keeps re-prefilling a deep context wastes the engine. The
 * runner now watches the CUMULATIVE count and the per-turn re-prefill size.
 *
 * This suite proves the runner's M5a watchdogs:
 *   (a) 60-crossing: a session whose cumulative turns cross SESSION_TURNS_WARN
 *       (60) emits exactly ONE `session_warning` event (one-shot latch).
 *   (b) 80-crossing: a session whose cumulative turns cross
 *       SESSION_TURNS_RECOMMEND (80) emits exactly ONE
 *       `session_turn_limit_recommended` event AND pushes exactly ONE in-band
 *       user-role advisory (SESSION_ROLLOVER_ADVISORY) into the conversation.
 *   (c) depth: a turn whose promptTokens >= CONTEXT_WARN_TOKENS (65536) emits
 *       exactly ONE `context_depth_warning` event (one-shot latch).
 *   (d) depth + probeStreak: the same depth warning, fired while the M4
 *       probeStreak counter is active (probeStreak > 0), carries
 *       `probeStreakActive: true` (the anti-rabbit-hole signal sum).
 *   (e) sub-threshold: a short, shallow run emits NONE of the M5a events.
 *
 * No vLLM, no network. The LLM provider and event logger are injected via the
 * runner's constructor seams (this._llm / this._logger). The prior session
 * history is injected through the mock logger's readAll() /
 * getConversationHistory() (the same surface the real EventLoggerService
 * exposes). The read_file tool is a REAL registered tool used as a neutral
 * keep-alive (it neither increments nor resets the M4 probe streak).
 *
 * Run: node tests/session_rollover.test.js
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Set the M5a thresholds BEFORE importing the runner so the config module
// picks them up at load time. These are the defaults; set explicitly for
// determinism.
process.env.QWEN_SESSION_WARN_TURNS = "60";
process.env.QWEN_SESSION_RECOMMEND_TURNS = "80";
process.env.QWEN_CONTEXT_WARN_TOKENS = "65536";

const { AnserRunner, SESSION_ROLLOVER_ADVISORY } = await import(
  "../src/harness/runner.js"
);
const {
  SESSION_TURNS_WARN,
  SESSION_TURNS_RECOMMEND,
  CONTEXT_WARN_TOKENS,
} = await import("../src/config.js");

// ---------------------------------------------------------------------------
// Isolated temp workspace (the sandbox root for the real file tools).
// ---------------------------------------------------------------------------
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "session_rollover_"));

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
        promptTokens: step.promptTokens ?? 0,
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
// getConversationHistory). `priorAssistant` seeds the PRIOR session's
// assistant_message events (the cross-task history the cumulative count is
// built from).
// ---------------------------------------------------------------------------
function makeMockLogger(priorAssistant = 0) {
  const events = [];
  for (let i = 0; i < priorAssistant; i++) {
    events.push({
      type: "assistant_message",
      content: `prior assistant turn ${i + 1}`,
      toolCalls: [],
      finishReason: "stop",
    });
  }
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
      // Mirror the real EventLoggerService: rebuild the conversation from the
      // event stream (user_message / assistant_message / tool_result).
      const messages = [];
      for (const ev of events) {
        if (ev.type === "user_message") {
          messages.push({ role: "user", content: ev.content });
        } else if (ev.type === "assistant_message") {
          const msg = { role: "assistant", content: ev.content || "" };
          if (ev.toolCalls && ev.toolCalls.length > 0) {
            msg.tool_calls = ev.toolCalls;
          }
          messages.push(msg);
        } else if (ev.type === "tool_result") {
          messages.push({
            role: "tool",
            tool_call_id: ev.toolCallId,
            content:
              typeof ev.result === "string"
                ? ev.result
                : JSON.stringify(ev.result ?? ev.error ?? ""),
          });
        }
      }
      return messages;
    },
  };
}

function countType(logger, type) {
  return logger.events.filter((e) => e.type === type).length;
}

// ---------------------------------------------------------------------------
// Tool-call builders.
// ---------------------------------------------------------------------------
// A NEUTRAL keep-alive tool call (read_file). It is neither a bash call
// (does not increment the M4 probe streak) nor a mutating tool (does not
// reset it), so it keeps the session alive without disturbing the streak.
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

// A non-mutating bash call (a "probe" — increments the M4 probe streak).
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

// ---------------------------------------------------------------------------
// Vector (a): 60-crossing. A session with 59 prior assistant turns runs 2
// turns this run -> cumulative 60 (warn) then 61. Exactly ONE
// session_warning event (one-shot latch); no recommend event; no advisory.
// ---------------------------------------------------------------------------
async function vectorA() {
  const llm = makeMockLlm([
    { content: "", toolCalls: [makeReadCall("call_a1", 1)], finishReason: "stop" },
    { content: "Done after the 60-crossing run.", finishReason: "stop" },
  ]);
  const logger = makeMockLogger(59); // 59 prior assistant turns
  const runner = new AnserRunner({ llm, logger });

  const res = await runner.run({
    prompt: "Continue the long session.",
    sessionId: "rollover_a",
    cwd: TMP_DIR,
    maxTurns: 20,
  });

  assert.strictEqual(
    res.status,
    "completed",
    "a: status must be 'completed' (advisory-only, not an error)"
  );
  // Exactly ONE session_warning event (the 60th cumulative turn tripped it).
  const warnings = logger.events.filter((e) => e.type === "session_warning");
  assert.strictEqual(
    warnings.length,
    1,
    `a: exactly ONE session_warning event (got ${warnings.length})`
  );
  // The event carries the cumulative count and the configured threshold.
  assert.strictEqual(
    warnings[0].sessionTurns,
    60,
    "a: session_warning records the cumulative turn count (60)"
  );
  assert.strictEqual(
    warnings[0].threshold,
    SESSION_TURNS_WARN,
    "a: session_warning records the configured threshold"
  );
  // No recommend event / advisory (the session never reached 80).
  assert.strictEqual(
    countType(logger, "session_turn_limit_recommended"),
    0,
    "a: NO session_turn_limit_recommended (session never reached 80)"
  );
  const advisoryMsgs = (llm._lastMessages || []).filter(
    (m) => m.role === "user" && m.content === SESSION_ROLLOVER_ADVISORY
  );
  assert.strictEqual(
    advisoryMsgs.length,
    0,
    "a: NO in-band rollover advisory (session never reached 80)"
  );
  console.log(
    "  [PASS] (a) 60-crossing -> exactly ONE session_warning event, no advisory"
  );
}

// ---------------------------------------------------------------------------
// Vector (b): 80-crossing. A session with 79 prior assistant turns runs 2
// turns this run -> cumulative 80 (recommend) then 81. Exactly ONE
// session_turn_limit_recommended event AND exactly ONE in-band user-role
// advisory (SESSION_ROLLOVER_ADVISORY).
// ---------------------------------------------------------------------------
async function vectorB() {
  const llm = makeMockLlm([
    { content: "", toolCalls: [makeReadCall("call_b1", 1)], finishReason: "stop" },
    { content: "Done after the 80-crossing run.", finishReason: "stop" },
  ]);
  const logger = makeMockLogger(79); // 79 prior assistant turns
  const runner = new AnserRunner({ llm, logger });

  const res = await runner.run({
    prompt: "Continue the long session.",
    sessionId: "rollover_b",
    cwd: TMP_DIR,
    maxTurns: 20,
  });

  assert.strictEqual(
    res.status,
    "completed",
    "b: status must be 'completed' (advisory-only, not an error)"
  );
  // Exactly ONE session_turn_limit_recommended event (the 80th cumulative
  // turn tripped it; the 81st did NOT re-fire — one-shot latch).
  const recommends = logger.events.filter(
    (e) => e.type === "session_turn_limit_recommended"
  );
  assert.strictEqual(
    recommends.length,
    1,
    `b: exactly ONE session_turn_limit_recommended event (got ${recommends.length})`
  );
  assert.strictEqual(
    recommends[0].sessionTurns,
    80,
    "b: event records the cumulative turn count (80)"
  );
  // Exactly ONE in-band user-role advisory in the conversation.
  const advisoryMsgs = (llm._lastMessages || []).filter(
    (m) => m.role === "user" && m.content === SESSION_ROLLOVER_ADVISORY
  );
  assert.strictEqual(
    advisoryMsgs.length,
    1,
    `b: exactly ONE in-band rollover advisory (got ${advisoryMsgs.length})`
  );
  console.log(
    "  [PASS] (b) 80-crossing -> ONE session_turn_limit_recommended event + exactly ONE in-band advisory"
  );
}

// ---------------------------------------------------------------------------
// Vector (c): depth. A short run (no session thresholds) whose first turn
// reports promptTokens >= CONTEXT_WARN_TOKENS (65536) emits exactly ONE
// context_depth_warning event (one-shot latch).
// ---------------------------------------------------------------------------
async function vectorC() {
  const llm = makeMockLlm([
    {
      content: "",
      toolCalls: [makeReadCall("call_c1", 1)],
      finishReason: "stop",
      promptTokens: 70000, // >= 65536 -> depth warning
    },
    {
      content: "Done after the deep-context run.",
      finishReason: "stop",
      promptTokens: 70000, // still deep, but the latch prevents a 2nd event
    },
  ]);
  const logger = makeMockLogger(0); // fresh session
  const runner = new AnserRunner({ llm, logger });

  const res = await runner.run({
    prompt: "Work in a deep context.",
    sessionId: "rollover_c",
    cwd: TMP_DIR,
    maxTurns: 20,
  });

  assert.strictEqual(
    res.status,
    "completed",
    "c: status must be 'completed'"
  );
  // Exactly ONE context_depth_warning event (one-shot latch).
  const depths = logger.events.filter((e) => e.type === "context_depth_warning");
  assert.strictEqual(
    depths.length,
    1,
    `c: exactly ONE context_depth_warning event (got ${depths.length})`
  );
  assert.strictEqual(
    depths[0].promptTokens,
    70000,
    "c: event records the promptTokens that tripped the threshold"
  );
  // No session events (the session is short — well under 60).
  assert.strictEqual(
    countType(logger, "session_warning"),
    0,
    "c: NO session_warning (session is short)"
  );
  assert.strictEqual(
    countType(logger, "session_turn_limit_recommended"),
    0,
    "c: NO session_turn_limit_recommended (session is short)"
  );
  console.log(
    "  [PASS] (c) depth >= 65536 -> exactly ONE context_depth_warning event"
  );
}

// ---------------------------------------------------------------------------
// Vector (d): depth + probeStreak. The same deep-context turn, but the model
// has just run a non-mutating bash call (the M4 probeStreak counter is
// active, probeStreak > 0) when the depth warning fires. The
// context_depth_warning event gains `probeStreakActive: true` (the
// anti-rabbit-hole signal sum).
// ---------------------------------------------------------------------------
async function vectorD() {
  const llm = makeMockLlm([
    // A non-mutating bash call -> probeStreak becomes 1 (active).
    { content: "", toolCalls: [makeBashCall("call_d1", 1)], finishReason: "stop" },
    // The next turn reports a deep context (>= 65536) while probeStreak is
    // still active (1) -> the depth warning carries probeStreakActive: true.
    {
      content: "Done after the deep + probing run.",
      finishReason: "stop",
      promptTokens: 70000,
    },
  ]);
  const logger = makeMockLogger(0); // fresh session
  const runner = new AnserRunner({ llm, logger });

  const res = await runner.run({
    prompt: "Probe, then go deep.",
    sessionId: "rollover_d",
    cwd: TMP_DIR,
    maxTurns: 20,
  });

  assert.strictEqual(
    res.status,
    "completed",
    "d: status must be 'completed'"
  );
  // Exactly ONE context_depth_warning event.
  const depths = logger.events.filter((e) => e.type === "context_depth_warning");
  assert.strictEqual(
    depths.length,
    1,
    `d: exactly ONE context_depth_warning event (got ${depths.length})`
  );
  // The escalation field is present and true (probeStreak was active).
  assert.strictEqual(
    depths[0].probeStreakActive,
    true,
    "d: context_depth_warning carries probeStreakActive:true (probeStreak was active)"
  );
  console.log(
    "  [PASS] (d) depth warning with probeStreak>0 -> context_depth_warning carries probeStreakActive:true"
  );
}

// ---------------------------------------------------------------------------
// Vector (e): sub-threshold. A short (3-turn) run with a shallow context
// (promptTokens well below 65536) emits NONE of the M5a events.
// ---------------------------------------------------------------------------
async function vectorE() {
  const llm = makeMockLlm([
    { content: "", toolCalls: [makeReadCall("call_e1", 1)], finishReason: "stop", promptTokens: 1000 },
    { content: "", toolCalls: [makeReadCall("call_e2", 2)], finishReason: "stop", promptTokens: 2000 },
    { content: "Done with a short, shallow run.", finishReason: "stop", promptTokens: 3000 },
  ]);
  const logger = makeMockLogger(0); // fresh session
  const runner = new AnserRunner({ llm, logger });

  const res = await runner.run({
    prompt: "A short task.",
    sessionId: "rollover_e",
    cwd: TMP_DIR,
    maxTurns: 20,
  });

  assert.strictEqual(
    res.status,
    "completed",
    "e: status must be 'completed'"
  );
  // None of the M5a events fire.
  assert.strictEqual(
    countType(logger, "session_warning"),
    0,
    "e: NO session_warning (session is short)"
  );
  assert.strictEqual(
    countType(logger, "session_turn_limit_recommended"),
    0,
    "e: NO session_turn_limit_recommended (session is short)"
  );
  assert.strictEqual(
    countType(logger, "context_depth_warning"),
    0,
    "e: NO context_depth_warning (context is shallow)"
  );
  // No in-band advisory either.
  const advisoryMsgs = (llm._lastMessages || []).filter(
    (m) => m.role === "user" && m.content === SESSION_ROLLOVER_ADVISORY
  );
  assert.strictEqual(
    advisoryMsgs.length,
    0,
    "e: NO in-band rollover advisory (session is short)"
  );
  console.log(
    "  [PASS] (e) sub-threshold run -> no M5a events, no advisory"
  );
}

// ---------------------------------------------------------------------------
// Run all vectors.
// ---------------------------------------------------------------------------
async function main() {
  console.log("=== M5a Session-Rollover & Context-Depth Watchdog (offline) ===");
  console.log(
    `SESSION_TURNS_WARN = ${SESSION_TURNS_WARN}, ` +
      `SESSION_TURNS_RECOMMEND = ${SESSION_TURNS_RECOMMEND}, ` +
      `CONTEXT_WARN_TOKENS = ${CONTEXT_WARN_TOKENS}\n`
  );

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

  console.log("\n==========================================");
  console.log(`Session-Rollover & Context-Depth: ${passed} PASSED, ${failed} FAILED`);
  console.log("==========================================");

  // Clean up the temp workspace.
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {}

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Session-rollover test uncaught error:", err);
  process.exit(1);
});
