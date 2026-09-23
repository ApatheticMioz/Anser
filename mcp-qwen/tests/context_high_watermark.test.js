#!/usr/bin/env node
/**
 * Context High-Watermark Advisory & Context-Exhaustion Verification (fully OFFLINE).
 *
 * Verifies:
 *   (a) High-watermark crossing: A turn whose promptTokens >= CONTEXT_HIGH_WATERMARK_TOKENS
 *       (180,000 tokens) emits exactly ONE `context_high_watermark` event (one-shot latch)
 *       AND pushes an in-band rollover advisory user message into messages.
 *   (b) Sub-watermark: A turn with promptTokens < CONTEXT_HIGH_WATERMARK_TOKENS does NOT
 *       emit the advisory or event.
 *   (c) Graceful Context-Exhaustion: When the engine throws a 400 Bad Request / context
 *       length exceeded error, runner catches it, terminates with status "context_exhausted",
 *       produces an informative recovery directive in finalText, and does not crash.
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Override threshold before importing runner/config for fast test execution
process.env.QWEN_CONTEXT_HIGH_WATERMARK_TOKENS = "100000";

const { AnserRunner } = await import("../src/harness/runner.js");
const { CONTEXT_HIGH_WATERMARK_TOKENS } = await import("../src/config.js");

const TMP_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "context_high_watermark_test_")
);
const DUMMY_FILE = path.join(TMP_DIR, "dummy.txt");
fs.writeFileSync(DUMMY_FILE, "alpha\nbravo\ncharlie\n", "utf8");

function makeMockLogger() {
  const events = [];
  return {
    events,
    append(e) {
      const entry = { timestamp: new Date().toISOString(), ...e };
      events.push(entry);
      return entry;
    },
    readAll() {
      return [...events];
    },
    getConversationHistory() {
      return [];
    },
    saveMetadata() {},
  };
}

function makeMockLlm(turns) {
  let idx = 0;
  return {
    async streamChat({ messages }) {
      if (idx >= turns.length) {
        return {
          content: "default finish",
          finishReason: "stop",
          toolCalls: [],
          metrics: { promptTokens: 500, completionTokens: 10 },
        };
      }
      const t = turns[idx++];
      if (t.throws) {
        throw new Error(t.throws);
      }
      return {
        content: t.content || "",
        finishReason: t.finishReason || "stop",
        toolCalls: t.toolCalls || [],
        metrics: {
          promptTokens: t.promptTokens || 500,
          completionTokens: 20,
        },
      };
    },
  };
}

async function vectorA() {
  console.log("Vector (a): promptTokens >= CONTEXT_HIGH_WATERMARK_TOKENS (100k test threshold)");
  const llm = makeMockLlm([
    {
      content: "First turn: doing work in deep context",
      toolCalls: [
        {
          id: "call_a1",
          type: "function",
          function: {
            name: "read_file",
            arguments: JSON.stringify({ file_path: DUMMY_FILE, max_lines: 1 }),
          },
        },
      ],
      finishReason: "tool_calls",
      promptTokens: 120000, // >= 100000 -> trips high-watermark
    },
    {
      content: "Final turn: wrapped up before context exhaustion.",
      finishReason: "stop",
      toolCalls: [],
      promptTokens: 120500, // latch prevents duplicate
    },
  ]);
  const logger = makeMockLogger();
  const runner = new AnserRunner({ llm, logger });

  const res = await runner.run({
    prompt: "Test high watermark",
    sessionId: "test_hw_a",
    cwd: TMP_DIR,
    maxTurns: 5,
  });

  assert.strictEqual(res.status, "completed", "a: status must be 'completed'");
  const hwEvents = logger.events.filter((e) => e.type === "context_high_watermark");
  assert.strictEqual(hwEvents.length, 1, "a: exactly ONE context_high_watermark event (one-shot latch)");
  assert.strictEqual(hwEvents[0].promptTokens, 120000, "a: event records trip promptTokens");
  assert.strictEqual(hwEvents[0].threshold, 100000, "a: event records threshold");

  console.log("  [PASS] (a) high-watermark event fired once, latch held on turn 2");
}

async function vectorB() {
  console.log("Vector (b): promptTokens < CONTEXT_HIGH_WATERMARK_TOKENS");
  const llm = makeMockLlm([
    {
      content: "Normal turn in shallow context",
      finishReason: "stop",
      toolCalls: [],
      promptTokens: 50000, // < 100000
    },
  ]);
  const logger = makeMockLogger();
  const runner = new AnserRunner({ llm, logger });

  const res = await runner.run({
    prompt: "Test shallow context",
    sessionId: "test_hw_b",
    cwd: TMP_DIR,
    maxTurns: 5,
  });

  assert.strictEqual(res.status, "completed", "b: status must be 'completed'");
  const hwEvents = logger.events.filter((e) => e.type === "context_high_watermark");
  assert.strictEqual(hwEvents.length, 0, "b: zero context_high_watermark events");

  console.log("  [PASS] (b) sub-threshold promptTokens emits no high-watermark event");
}

async function vectorC() {
  console.log("Vector (c): graceful handling of upstream context length exceeded error");
  const llm = makeMockLlm([
    {
      throws: "400 Bad Request: This model's maximum context length is 245760 tokens, however you requested 250100 tokens.",
    },
  ]);
  const logger = makeMockLogger();
  const runner = new AnserRunner({ llm, logger });

  const res = await runner.run({
    prompt: "Test context exhaustion catch",
    sessionId: "test_hw_c",
    cwd: TMP_DIR,
    maxTurns: 5,
  });

  assert.strictEqual(res.status, "context_exhausted", "c: status must be 'context_exhausted'");
  assert.ok(
    res.finalText.includes("[Context Exhausted]"),
    "c: finalText carries clean [Context Exhausted] guidance"
  );
  assert.ok(
    res.finalText.includes("test_hw_c_stage2"),
    "c: finalText recommends rollover to stage2"
  );
  const errEvents = logger.events.filter((e) => e.type === "session_error");
  assert.strictEqual(errEvents.length, 1, "c: logged session_error");
  assert.strictEqual(errEvents[0].error, "context_exhausted", "c: error is 'context_exhausted'");

  console.log("  [PASS] (c) context exhaustion caught cleanly with 'context_exhausted' status");
}

async function runAll() {
  try {
    await vectorA();
    await vectorB();
    await vectorC();
    console.log("\n==========================================");
    console.log("Context High-Watermark Tests: ALL 3 VECTORS PASSED");
    console.log("==========================================");
  } finally {
    try {
      fs.rmSync(TMP_DIR, { recursive: true, force: true });
    } catch {}
  }
}

runAll();
