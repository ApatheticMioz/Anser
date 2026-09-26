#!/usr/bin/env node
/**
 * Cooperative Landing & Turn Ceiling Advisory Verification (fully OFFLINE).
 *
 * Verifies:
 * 1. Cooperative landing at turn ceiling:
 *    - When turnsTaken reaches maxTurns - 1, the next turn is flagged as ceiling turn.
 *    - Tools are stripped (tools: []).
 *    - Mandatory synthesis advisory is injected into messages.
 *    - turn_ceiling_synthesis event is appended to session logger.
 *    - Final runner status is "completed_budget_exhausted".
 *    - isSuccessStatus("completed_budget_exhausted") returns true.
 *    - buildResultText appends the prominent [!WARNING] turn limit disclaimer.
 * 2. High turn count advisory (Turn 80):
 *    - When session reaches >= 80 turns, buildResultText appends [!NOTE] advisory
 *      and [SessionTurnLimitRecommendation: ...] marker.
 *    - Preserves additive guarantee (starts with original deliverable).
 *    - Returns exact unchanged text below 80 turns.
 * 3. Status server socket persistence:
 *    - attemptStatusReListen enforces exclusive: true (SO_EXCLUSIVEADDRUSE).
 *    - Returns false cleanly on EADDRINUSE without unhandled errors.
 *
 * Run: node tests/cooperative_landing.test.js
 */

import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { AnserRunner } from "../src/harness/runner.js";
import { isSuccessStatus, buildResultText } from "../src/anser_runner.js";
import {
  attemptStatusReListen,
  statusHttpServer,
} from "../src/task_registry.js";
import { STATUS_PORT } from "../src/config.js";

let passed = 0;
let failed = 0;

function check(label, fn) {
  try {
    fn();
    passed++;
    console.log(`  [PASS] ${label}`);
  } catch (err) {
    failed++;
    console.error(`  [FAIL] ${label}: ${err.message}`);
  }
}

async function checkAsync(label, fn) {
  try {
    await fn();
    passed++;
    console.log(`  [PASS] ${label}`);
  } catch (err) {
    failed++;
    console.error(`  [FAIL] ${label}: ${err.message}`);
  }
}

console.log("=== Cooperative Landing & Turn Ceiling Verification (offline) ===\n");

// ---------------------------------------------------------------------------
// Section 1: isSuccessStatus mapping
// ---------------------------------------------------------------------------
check("isSuccessStatus treats completed_budget_exhausted as success", () => {
  assert.equal(isSuccessStatus("completed_budget_exhausted"), true);
  assert.equal(isSuccessStatus("completed"), true);
  assert.equal(isSuccessStatus("completed_ceiling"), true);
  assert.equal(isSuccessStatus("turn_limit_reached"), false);
  assert.equal(isSuccessStatus("failed"), false);
});

// ---------------------------------------------------------------------------
// Section 2: buildResultText advisory banners
// ---------------------------------------------------------------------------
check("buildResultText appends [!WARNING] banner on completed_budget_exhausted", () => {
  const base = "Here is my final research synthesis on distributed kv caches.";
  const out = buildResultText(base, 100, "completed_budget_exhausted");

  assert.ok(out.startsWith(base), "must preserve deliverable prefix");
  assert.ok(out.includes("> [!WARNING] **Turn Limit Reached (Budget Exhausted)**"));
  assert.ok(out.includes("Take this deliverable with a grain of salt"));
  assert.ok(out.includes("SessionTurnLimitRecommendation"), "must also include rollover tag at turn 100");
});

check("buildResultText appends [!NOTE] banner on Turn 80 advisory", () => {
  const base = "Finished component refactor.";
  const out = buildResultText(base, 80, "completed");

  assert.ok(out.startsWith(base), "must preserve deliverable prefix");
  assert.ok(out.includes("> [!NOTE] **High Turn Count Advisory (Turn 80)**"));
  assert.ok(out.includes("SessionTurnLimitRecommendation"));
  assert.ok(!out.includes("[!WARNING]"), "must not include warning banner when not budget exhausted");
});

check("buildResultText is a clean no-op below 80 turns", () => {
  const base = "Normal deliverable at turn 5.";
  const out = buildResultText(base, 5, "completed");
  assert.equal(out, base);
});

check("buildResultText fails safe when sessionTurns is absent or null", () => {
  const base = "Legacy deliverable.";
  assert.equal(buildResultText(base, null), base);
  assert.equal(buildResultText(base, undefined), base);
});

// ---------------------------------------------------------------------------
// Section 3: Cooperative landing turn ceiling in AnserRunner
// ---------------------------------------------------------------------------
await checkAsync("AnserRunner strips tools and mandates synthesis on ceiling turn", async () => {
  let callCount = 0;
  const toolsSeen = [];
  const messagesSeen = [];

  const mockLlm = {
    async streamChat({ messages, tools }) {
      callCount++;
      toolsSeen.push(tools ? [...tools] : []);
      messagesSeen.push([...messages]);

      // Turn 1, 2, 3: request tool calls
      if (callCount < 4) {
        return {
          content: `Step ${callCount} in progress.`,
          toolCalls: [
            {
              id: `call_${callCount}`,
              type: "function",
              function: {
                name: "read_file",
                arguments: JSON.stringify({ path: `file_${callCount}.txt` }),
              },
            },
          ],
          finishReason: "tool_calls",
        };
      }

      // Turn 4 (Ceiling turn): tools MUST be stripped (empty array)
      return {
        content: "Final deliverable synthesized after tools were stripped.",
        toolCalls: [],
        finishReason: "stop",
      };
    },
  };

  const loggedEvents = [];
  const mockLogger = {
    append(event) {
      loggedEvents.push(event);
      return event;
    },
    readAll() {
      return loggedEvents;
    },
    getConversationHistory() {
      return [];
    },
  };

  const runner = new AnserRunner({ cwd: process.cwd() });
  runner._llm = mockLlm;
  runner._logger = mockLogger;

  const result = await runner.run({
    prompt: "Perform deep architectural sweep across files.",
    cwd: process.cwd(),
    sessionId: "test_coop_landing",
    maxTurns: 4,
  });

  assert.equal(callCount, 4, "must execute exactly 4 turns (3 tool turns + 1 ceiling synthesis turn)");
  assert.equal(result.status, "completed_budget_exhausted", "status must be completed_budget_exhausted");
  assert.equal(result.finalText, "Final deliverable synthesized after tools were stripped.");

  // Assert tools were present on turns 1-3, but STRIPPED on turn 4
  assert.ok(toolsSeen[0].length > 0, "turn 1 should have tools");
  assert.ok(toolsSeen[1].length > 0, "turn 2 should have tools");
  assert.ok(toolsSeen[2].length > 0, "turn 3 should have tools");
  assert.equal(toolsSeen[3].length, 0, "turn 4 (ceiling turn) MUST have tools stripped (empty array)");

  // Assert user advisory was injected into messages on turn 4
  const finalMessages = messagesSeen[3];
  const lastUserMsg = finalMessages.filter((m) => m.role === "user").slice(-1)[0];
  assert.ok(
    lastUserMsg.content.includes("[MANDATORY SYNTHESIS - TURN CEILING REACHED (4/4)]"),
    "mandatory synthesis prompt must be injected into user messages"
  );

  // Assert logger recorded turn_ceiling_synthesis event
  const ceilingEvent = loggedEvents.find((e) => e.type === "turn_ceiling_synthesis");
  assert.ok(ceilingEvent, "must emit turn_ceiling_synthesis event");
  assert.equal(ceilingEvent.turnsTaken, 4);
  assert.equal(ceilingEvent.maxTurns, 4);
});

// Adversarial Vector A: Length continuation on ceiling turn must still complete as completed_budget_exhausted
await checkAsync("Adversarial A: Length cutoff during ceiling synthesis triggers continuation and concludes as completed_budget_exhausted", async () => {
  let callCount = 0;
  const mockLlm = {
    async streamChat({ tools }) {
      callCount++;
      if (callCount === 1) {
        // Turn 1: normal tool call
        return {
          content: "Starting exploration.",
          toolCalls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{}" } }],
          finishReason: "tool_calls",
        };
      }
      if (callCount === 2) {
        // Turn 2 (Ceiling turn): tools stripped, but generation cut off by length
        assert.equal(tools.length, 0, "tools must be stripped on ceiling turn");
        return {
          content: "Partial synthesis cut off by",
          toolCalls: [],
          finishReason: "length",
        };
      }
      if (callCount === 3) {
        // Continuation turn: resumes and concludes
        return {
          content: " token ceiling, now fully delivered.",
          toolCalls: [],
          finishReason: "stop",
        };
      }
      throw new Error(`Unexpected call ${callCount}`);
    },
  };

  const runner = new AnserRunner({ cwd: process.cwd() });
  runner._llm = mockLlm;
  runner._logger = {
    append(e) { return e; },
    readAll() { return []; },
    getConversationHistory() { return []; },
  };

  const result = await runner.run({
    prompt: "Exhaust budget with length cutoff.",
    cwd: process.cwd(),
    sessionId: "adv_a_length",
    maxTurns: 2,
  });

  assert.equal(result.status, "completed_budget_exhausted");
  assert.equal(result.finalText, " token ceiling, now fully delivered.");
});

// Adversarial Vector B: maxTurns = 1 must NOT strip tools on turn 1
await checkAsync("Adversarial B: maxTurns=1 boundary does not strip tools on the single turn", async () => {
  let toolsCount = -1;
  const mockLlm = {
    async streamChat({ tools }) {
      toolsCount = tools ? tools.length : 0;
      return {
        content: "Single turn answer.",
        toolCalls: [],
        finishReason: "stop",
      };
    },
  };

  const runner = new AnserRunner({ cwd: process.cwd() });
  runner._llm = mockLlm;
  runner._logger = {
    append(e) { return e; },
    readAll() { return []; },
    getConversationHistory() { return []; },
  };

  const result = await runner.run({
    prompt: "Single turn inquiry.",
    cwd: process.cwd(),
    sessionId: "adv_b_single",
    maxTurns: 1,
  });

  assert.ok(toolsCount > 0, "tools must NOT be stripped when maxTurns === 1");
  assert.equal(result.status, "completed");
});

// Adversarial Vector C: Empty deliverable on turn limit aborts honestly as turn_limit_reached
await checkAsync("Adversarial C: Empty generation when maxTurns exhausted reports turn_limit_reached (fail-closed)", async () => {
  let callCount = 0;
  const mockLlm = {
    async streamChat() {
      callCount++;
      return {
        content: "",
        toolCalls: [{ id: `c_${callCount}`, type: "function", function: { name: "read_file", arguments: "{}" } }],
        finishReason: "tool_calls",
      };
    },
  };

  const runner = new AnserRunner({ cwd: process.cwd() });
  runner._llm = mockLlm;
  runner._logger = {
    append(e) { return e; },
    readAll() { return []; },
    getConversationHistory() { return []; },
  };

  // Force turnsTaken to reach maxTurns with empty text
  const result = await runner.run({
    prompt: "Never emits text.",
    cwd: process.cwd(),
    sessionId: "adv_c_empty",
    maxTurns: 2,
  });

  // Since on turn 2 tools are stripped, but mockLlm returns empty content and toolCalls: [],
  // isEmptyStop guard will retry emptyStreamRetries, and if exhausted reports engine_empty_response or turn_limit_reached
  assert.ok(
    result.status === "engine_empty_response" || result.status === "turn_limit_reached",
    `must report honest error status, got: ${result.status}`
  );
  assert.equal(isSuccessStatus(result.status), false, "empty failure must map to isSuccessStatus === false");
});

// Adversarial Vector D: Combined 80 turns + budget exhausted
check("Adversarial D: Combined 80 turns + budget exhausted produces warning and rollover marker without corruption", () => {
  const base = "Combined edge case deliverable.";
  const out = buildResultText(base, 80, "completed_budget_exhausted");

  assert.ok(out.startsWith(base));
  assert.ok(out.includes("> [!WARNING] **Turn Limit Reached (Budget Exhausted)**"));
  assert.ok(out.includes("[SessionTurnLimitRecommendation: session at 80 turns — roll to a fresh session_id before the next dispatch]"));
  // Notice that when budget exhausted, the [!WARNING] banner takes precedence over [!NOTE], but the machine-readable tag is preserved
  assert.ok(!out.includes("[!NOTE]"), "should not have both conflicting markdown alert headers");
});

// ---------------------------------------------------------------------------
// Section 4: Socket persistence (exclusive: true / SO_EXCLUSIVEADDRUSE)
// ---------------------------------------------------------------------------
await checkAsync("attemptStatusReListen binds with exclusive: true and handles collisions cleanly", async () => {
  // Find a free port
  const tempServer = http.createServer((_req, res) => res.end("occupant"));
  const freePort = await new Promise((resolve) => {
    tempServer.listen(0, "127.0.0.1", () => {
      resolve(tempServer.address().port);
    });
  });

  try {
    // Attempt re-listen on occupied port: must return false cleanly without crashing
    const wonOccupied = await attemptStatusReListen(freePort);
    assert.equal(wonOccupied, false, "re-listen on occupied port must return false");
  } finally {
    await new Promise((r) => tempServer.close(r));
  }

  // Attempt re-listen on now-free port: must succeed and win
  const wonFree = await attemptStatusReListen(freePort);
  assert.equal(wonFree, true, "re-listen on free port must return true");

  // Clean up
  await new Promise((r) => statusHttpServer.close(r));
});

console.log("\n==========================================");
console.log(`Cooperative Landing Tests: ${passed} PASSED, ${failed} FAILED`);
console.log("==========================================");

if (failed > 0) process.exit(1);
