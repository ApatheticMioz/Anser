/**
 * E4: Adaptive Read-Size Governor (F6.1 runaway whole-file read prevention)
 *
 * When the context high-watermark (180k tokens) fires, the runner arms a
 * per-session read governor on the sandboxed FS service. Subsequent read_file
 * calls are then capped at 16KB (down from the 64KB default) instead of
 * pulling a whole file into an already-pressured context.
 *
 * Vectors:
 *   (a) ungoverned read returns the full content up to 64KB (no notice)
 *   (b) governed read (16KB) truncates to 16KB and appends the suffix-scoped
 *       notice; the notice is non-coercive advisory language
 *   (c) governor does NOT leak to a second SandboxFsService instance
 *   (d) governor only LOWERS the cap — a caller max_bytes below the governor
 *       cap wins (the governor never raises the cap)
 *   (e) runner integration: high-watermark arms the governor, and a
 *       subsequent read_file tool call is governed
 *
 * No vLLM, no network. The LLM provider and event logger are injected via
 * the runner's constructor seams; the direct readFile vectors use the
 * SandboxFsService class against a temp dir.
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Set the spill threshold HIGH so a 16KB governed read is NOT spilled to a
// scratch file (which would replace the in-band observation with a pointer and
// obscure the governor's notice). The governor's 16KB cap is what we're
// testing, not the E1 spill.
process.env.QWEN_TOOL_SPILL_BYTES = "100000";
// Keep the continuation budget small for the runner integration vector.
process.env.QWEN_MAX_CONTINUATION_TURNS = "3";
process.env.QWEN_EMPTY_STREAM_RETRIES = "2";

const { SandboxFsService } = await import(
  "../src/harness/services/sandbox_fs.js"
);
const { CastorRunner } = await import("../src/harness/runner.js");
const {
  READ_GOVERNOR_MAX_BYTES,
  CONTEXT_HIGH_WATERMARK_TOKENS,
} = await import("../src/config.js");

const GOVERNED_NOTICE =
  "[Output governed to 16KB due to context pressure. Use narrow start_line/end_line offsets or ast_search.]";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a temp dir with a text file of the given approximate size.
 * Each line is "line_<i>: " + "x".repeat(50) (~60 chars). Returns the
 * absolute path to the file and the temp dir (for cleanup).
 */
function makeTextFile(approxBytes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "read_gov_"));
  const lines = [];
  let total = 0;
  let i = 0;
  while (total < approxBytes) {
    const line = `line_${i}: ${"x".repeat(50)}`;
    lines.push(line);
    total += line.length + 1; // +1 for the newline
    i++;
  }
  const filePath = path.join(dir, "data.txt");
  fs.writeFileSync(filePath, lines.join("\n"), "utf8");
  return { dir, filePath, relPath: "data.txt", lines: lines.length };
}

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
      return [];
    },
  };
}

function countType(logger, type) {
  return logger.events.filter((e) => e.type === type).length;
}

// ---------------------------------------------------------------------------
// Vector (a): ungoverned read returns the full content up to 64KB.
// ---------------------------------------------------------------------------
async function vectorA() {
  const { dir, relPath } = makeTextFile(36 * 1024); // ~36KB, between 16KB and 64KB
  try {
    const svc = new SandboxFsService({ root: dir });
    // No governor armed (readGovernorMaxBytes is null).
    const res = await svc.readFile({ path: relPath });

    // The full content is returned (36KB < 64KB default cap, no governor).
    assert.ok(
      Buffer.byteLength(res.content, "utf8") > 16 * 1024,
      "a: ungoverned read should return the full ~36KB content (>16KB)"
    );
    assert.ok(
      Buffer.byteLength(res.content, "utf8") < 64 * 1024,
      "a: ungoverned read should be under the 64KB default cap"
    );
    // No governor notice.
    assert.ok(
      !res.content.includes(GOVERNED_NOTICE),
      "a: ungoverned read must NOT include the governor notice"
    );
    assert.equal(res.governed, undefined, "a: no 'governed' flag when ungoverned");
    console.log(
      `  [PASS] (a) ungoverned read returns full content (${Buffer.byteLength(res.content, "utf8")} bytes, no notice)`
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Vector (b): governed read (16KB) truncates to 16KB and appends the notice.
// ---------------------------------------------------------------------------
async function vectorB() {
  const { dir, relPath } = makeTextFile(36 * 1024); // ~36KB
  try {
    const svc = new SandboxFsService({ root: dir });
    // Arm the governor at 16KB.
    svc.setReadGovernor(READ_GOVERNOR_MAX_BYTES);
    const res = await svc.readFile({ path: relPath });

    // The content is capped to 16KB + the notice.
    const contentBytes = Buffer.byteLength(res.content, "utf8");
    assert.ok(
      contentBytes <= READ_GOVERNOR_MAX_BYTES + GOVERNED_NOTICE.length + 2,
      `b: governed read should be capped to 16KB + notice (got ${contentBytes} bytes)`
    );
    assert.ok(
      contentBytes > 16 * 1024,
      "b: governed read should be at least 16KB (the cap)"
    );
    // The notice is appended (suffix-scoped).
    assert.ok(
      res.content.includes(GOVERNED_NOTICE),
      "b: governed read must include the suffix-scoped notice"
    );
    // The notice is at the END of the content (suffix-scoped, not prefix).
    assert.ok(
      res.content.endsWith(GOVERNED_NOTICE),
      "b: the notice must be suffix-scoped (at the end of the content)"
    );
    // The 'governed' flag is set.
    assert.equal(res.governed, true, "b: 'governed' flag must be true");
    assert.equal(
      res.governedMaxBytes,
      READ_GOVERNOR_MAX_BYTES,
      "b: governedMaxBytes must be the governor cap"
    );
    console.log(
      `  [PASS] (b) governed read capped to 16KB + notice (${contentBytes} bytes)`
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Vector (c): governor does NOT leak to a second SandboxFsService instance.
// ---------------------------------------------------------------------------
async function vectorC() {
  const { dir, relPath } = makeTextFile(36 * 1024);
  try {
    const svc1 = new SandboxFsService({ root: dir });
    const svc2 = new SandboxFsService({ root: dir });

    // Arm the governor on svc1 only.
    svc1.setReadGovernor(READ_GOVERNOR_MAX_BYTES);

    const res1 = await svc1.readFile({ path: relPath });
    const res2 = await svc2.readFile({ path: relPath });

    // svc1 is governed.
    assert.ok(
      res1.content.includes(GOVERNED_NOTICE),
      "c: svc1 (governed) must include the notice"
    );
    // svc2 is NOT governed (the governor didn't leak).
    assert.ok(
      !res2.content.includes(GOVERNED_NOTICE),
      "c: svc2 (ungoverned) must NOT include the notice"
    );
    assert.equal(
      res2.governed,
      undefined,
      "c: svc2 must not have the 'governed' flag"
    );
    console.log(
      "  [PASS] (c) governor does not leak to a second SandboxFsService instance"
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Vector (d): governor only LOWERS the cap — a caller max_bytes below the
// governor cap wins (the governor never raises the cap).
// ---------------------------------------------------------------------------
async function vectorD() {
  const { dir, relPath } = makeTextFile(36 * 1024); // ~36KB
  try {
    const svc = new SandboxFsService({ root: dir });
    // Arm the governor at 16KB, but the caller passes a LOWER max_bytes (8KB).
    svc.setReadGovernor(READ_GOVERNOR_MAX_BYTES);
    const res = await svc.readFile({ path: relPath, max_bytes: 8 * 1024 });

    // The effective cap is min(8KB, 16KB) = 8KB (the caller's cap wins).
    const contentBytes = Buffer.byteLength(res.content, "utf8");
    assert.ok(
      contentBytes <= 8 * 1024 + 2,
      `d: effective cap should be the caller's 8KB (got ${contentBytes} bytes)`
    );
    // No notice, because the governor cap (16KB) did NOT actually govern
    // (the caller's 8KB was lower).
    assert.ok(
      !res.content.includes(GOVERNED_NOTICE),
      "d: no notice when the caller's max_bytes is below the governor cap"
    );
    assert.equal(
      res.governed,
      undefined,
      "d: no 'governed' flag when the caller's cap is lower"
    );
    console.log(
      `  [PASS] (d) governor only lowers the cap (caller 8KB < governor 16KB → 8KB wins, no notice)`
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Vector (e): runner integration — high-watermark arms the governor, and a
// subsequent read_file tool call is governed.
// ---------------------------------------------------------------------------
async function vectorE() {
  const { dir, relPath } = makeTextFile(36 * 1024); // ~36KB
  try {
    // Mock LLM:
    //   Turn 1: high promptTokens (triggers high-watermark → arms governor),
    //           no tool calls, content "thinking".
    //   Turn 2: read_file tool call → governed read (capped to 16KB + notice).
    //   Turn 3: clean stop.
    let call = 0;
    const mockLlm = {
      _lastMessages: null,
      async streamChat({ messages, onMetrics } = {}) {
        this._lastMessages = messages ? [...messages] : null;
        call++;
        const promptTokens = CONTEXT_HIGH_WATERMARK_TOKENS; // 180000
        const metrics = {
          promptTokens,
          completionTokens: 100,
          ttftMs: 10,
          totalMs: 50,
          tokensPerSec: 5,
          hadReasoning: false,
        };
        if (onMetrics) onMetrics(metrics);

        if (call === 1) {
          // Turn 1: high promptTokens (arms the governor), no tool calls,
          // "length" cutoff (so the loop continues to the read turn rather
          // than breaking on a clean stop).
          return {
            content: "Thinking about the file.",
            toolCalls: [],
            finishReason: "length",
            hadReasoning: false,
            metrics,
          };
        }
        if (call === 2) {
          // Turn 2: read_file tool call.
          return {
            content: "",
            toolCalls: [
              {
                id: "call_read_1",
                type: "function",
                function: {
                  name: "read_file",
                  arguments: JSON.stringify({ path: relPath }),
                },
              },
            ],
            finishReason: "tool_calls",
            hadReasoning: false,
            metrics,
          };
        }
        // Turn 3: clean stop.
        return {
          content: "Done reading.",
          toolCalls: [],
          finishReason: "stop",
          hadReasoning: false,
          metrics,
        };
      },
    };

    const logger = makeMockLogger();
    const runner = new CastorRunner({ llm: mockLlm, logger });

    const res = await runner.run({
      prompt: "Read the big file.",
      cwd: dir,
      sessionId: "read_gov_e",
      maxTurns: 10,
    });

    // The session should complete.
    assert.equal(res.status, "completed", "e: status should be completed");

    // The high-watermark event should be logged.
    assert.equal(
      countType(logger, "context_high_watermark"),
      1,
      "e: exactly one context_high_watermark event"
    );
    // The governor should be armed.
    assert.equal(
      countType(logger, "read_governor_armed"),
      1,
      "e: exactly one read_governor_armed event"
    );
    const armedEvent = logger.events.find((e) => e.type === "read_governor_armed");
    assert.equal(
      armedEvent.maxBytes,
      READ_GOVERNOR_MAX_BYTES,
      "e: read_governor_armed event carries the governor cap"
    );

    // The tool result (from turn 2) should be governed. Capture it from the
    // mock LLM's _lastMessages on turn 3 (which includes the tool result).
    const toolMsg = mockLlm._lastMessages?.find(
      (m) => m.role === "tool" && m.tool_call_id === "call_read_1"
    );
    assert.ok(toolMsg, "e: tool result message present in history");
    assert.ok(
      toolMsg.content.includes(GOVERNED_NOTICE),
      "e: governed read must include the notice in the tool result"
    );
    // The tool result is the JSON-serialized result object
    // ({path, total_lines, showing_range, content, governed, governedMaxBytes}),
    // so the raw string length includes JSON overhead beyond just the content.
    // Assert on the parsed `content` field, which is what the governor caps.
    const parsed = JSON.parse(toolMsg.content);
    assert.equal(parsed.governed, true, "e: parsed result must have governed=true");
    assert.equal(
      parsed.governedMaxBytes,
      READ_GOVERNOR_MAX_BYTES,
      "e: parsed result must carry the governor cap"
    );
    const contentBytes = Buffer.byteLength(parsed.content, "utf8");
    assert.ok(
      contentBytes <= READ_GOVERNOR_MAX_BYTES + GOVERNED_NOTICE.length + 2,
      `e: governed content should be capped to 16KB + notice (got ${contentBytes} bytes)`
    );
    assert.ok(
      contentBytes > 16 * 1024,
      "e: governed content should be at least 16KB (the cap)"
    );
    console.log(
      `  [PASS] (e) runner integration: high-watermark arms governor, read_file content governed (${contentBytes} bytes)`
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Run all vectors.
// ---------------------------------------------------------------------------
async function main() {
  console.log("=== E4: Adaptive Read-Size Governor (F6.1) ===\n");
  console.log(`READ_GOVERNOR_MAX_BYTES = ${READ_GOVERNOR_MAX_BYTES}`);
  console.log(`CONTEXT_HIGH_WATERMARK_TOKENS = ${CONTEXT_HIGH_WATERMARK_TOKENS}\n`);

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
      if (err.stack) console.error(err.stack);
    }
  }

  console.log(`\n==========================================================================`);
  console.log(`Read Governor Verification: ${passed} / ${vectors.length} vectors passed`);
  if (failed > 0) {
    console.log(`Verdict: ${failed} VECTOR(S) FAILED.`);
    process.exit(1);
  }
  console.log(`Verdict: ALL READ-GOVERNOR VECTORS PASSED.`);
  console.log(`==========================================================================`);
  process.exit(0);
}

main().catch((e) => {
  console.error("HARNESS FAILURE:", e);
  process.exit(1);
});
