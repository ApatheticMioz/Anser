/**
 * E1: FS-as-context tool-output spillover (fully OFFLINE)
 *
 * Proves the runner's spillToolOutput helper:
 *   (a) output <= threshold passes through untouched (no spill, no write)
 *   (b) output > threshold writes the FULL payload to <scratchDir>/tool_out_<id>.txt
 *       and returns a pointer block (head + tail preview + re-read hint)
 *   (c) a failed scratch write is surfaced as a loud ToolOutputSpillError
 *       (never a silent truncation) — zero-masking invariant
 *   (d) no fsService (unmounted) -> output returned unchanged (safe no-op)
 *   (e) integration: a real runner run with a >8KB bash observation spills to
 *       .scratch/ and the in-band message is a small pointer
 *
 * No vLLM, no network. The LLM provider and event logger are injected via the
 * runner's constructor seams (this._llm / this._logger).
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

// Set the spill threshold BEFORE importing the runner so config picks it up.
process.env.QWEN_TOOL_SPILL_BYTES = "8192";

const { AnserRunner, spillToolOutput } = await import("../src/harness/runner.js");

// ---------------------------------------------------------------------------
// Mock sandboxed FS service: writes to a real temp dir, records calls.
// ---------------------------------------------------------------------------
function makeMockFsService({ fail = false } = {}) {
  const root = fs.mkdtempSync(path.join(process.cwd(), ".scratch_spill_"));
  const calls = [];
  return {
    root,
    calls,
    async writeFile({ path: p, content }) {
      calls.push({ p, bytes: Buffer.byteLength(content, "utf8") });
      if (fail) throw new Error("DiskFullError: simulated write failure");
      const resolved = path.isAbsolute(p) ? p : path.join(root, p);
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, content, "utf8");
      return { path: resolved, bytes_written: Buffer.byteLength(content, "utf8"), success: true };
    },
  };
}

function makeMockLlm(script) {
  let call = 0;
  return {
    _lastMessages: null,
    async streamChat({ messages } = {}) {
      this._lastMessages = messages ? [...messages] : null;
      const step = script[Math.min(call, script.length - 1)];
      call++;
      return {
        content: step.content ?? "",
        toolCalls: step.toolCalls ?? [],
        finishReason: Object.prototype.hasOwnProperty.call(step, "finishReason") ? step.finishReason : "stop",
        hadReasoning: step.hadReasoning ?? false,
        metrics: {
          promptTokens: 0,
          completionTokens: (step.content || "").length,
          ttftMs: 1,
          totalMs: 1,
          tokensPerSec: 0,
          hadReasoning: step.hadReasoning ?? false,
        },
      };
    },
  };
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

// ---------------------------------------------------------------------------
// Vector (a): under threshold -> unchanged, no spill.
// ---------------------------------------------------------------------------
async function vectorA() {
  const fsService = makeMockFsService();
  const out = "x".repeat(100); // well under 8192
  const res = await spillToolOutput({
    output: out,
    thresholdBytes: 8192,
    id: "call_a",
    scratchDir: ".scratch",
    fsService,
  });
  assert.strictEqual(res.spilled, false, "a: no spill under threshold");
  assert.strictEqual(res.output, out, "a: output returned byte-identical");
  assert.strictEqual(fsService.calls.length, 0, "a: no write performed");
  console.log("  [PASS] (a) under-threshold output passes through untouched");
}

// ---------------------------------------------------------------------------
// Vector (b): over threshold -> full payload written, pointer returned.
// ---------------------------------------------------------------------------
async function vectorB() {
  const fsService = makeMockFsService();
  const out = "A".repeat(20000); // > 8192
  const res = await spillToolOutput({
    output: out,
    thresholdBytes: 8192,
    id: "call_b",
    scratchDir: ".scratch",
    fsService,
  });
  assert.strictEqual(res.spilled, true, "b: spill triggered over threshold");
  assert.ok(res.output.includes("[Tool output spilled to disk"), "b: pointer header present");
  assert.ok(res.output.includes("tool_out_call_b.txt"), "b: pointer names the spill file");
  assert.ok(res.output.includes("Head preview"), "b: head preview present");
  assert.ok(res.output.includes("Tail preview"), "b: tail preview present");
  assert.ok(res.output.includes("read_file"), "b: re-read hint present");
  // The in-band pointer is small (head 1KB + tail 1KB + metadata), not the full 20KB.
  assert.ok(Buffer.byteLength(res.output, "utf8") < 4096, "b: in-band pointer is small");
  // The FULL payload was written to disk, byte-identical.
  const spillPath = path.join(fsService.root, ".scratch", "tool_out_call_b.txt");
  assert.ok(fs.existsSync(spillPath), "b: spill file written");
  const written = fs.readFileSync(spillPath, "utf8");
  assert.strictEqual(written, out, "b: spill file holds the full payload byte-identically");
  console.log("  [PASS] (b) over-threshold output -> full payload to disk + small pointer");
}

// ---------------------------------------------------------------------------
// Vector (c): failed write -> loud ToolOutputSpillError, never silent truncation.
// ---------------------------------------------------------------------------
async function vectorC() {
  const fsService = makeMockFsService({ fail: true });
  const out = "B".repeat(20000);
  const res = await spillToolOutput({
    output: out,
    thresholdBytes: 8192,
    id: "call_c",
    scratchDir: ".scratch",
    fsService,
  });
  assert.strictEqual(res.spilled, false, "c: not marked spilled on failure");
  assert.ok(res.output.includes("ToolOutputSpillError"), "c: failure surfaced as explicit error");
  assert.ok(res.output.includes("DiskFullError"), "c: underlying cause named");
  // The full payload must NOT be silently truncated to the threshold.
  assert.ok(!res.output.startsWith("B".repeat(8192)), "c: no silent 8KB truncation");
  console.log("  [PASS] (c) failed spill write -> loud ToolOutputSpillError (zero-masking)");
}

// ---------------------------------------------------------------------------
// Vector (d): no fsService -> safe no-op (output unchanged).
// ---------------------------------------------------------------------------
async function vectorD() {
  const out = "C".repeat(20000);
  const res = await spillToolOutput({
    output: out,
    thresholdBytes: 8192,
    id: "call_d",
    scratchDir: ".scratch",
    fsService: undefined,
  });
  assert.strictEqual(res.spilled, false, "d: no spill without fsService");
  assert.strictEqual(res.output, out, "d: output returned unchanged");
  console.log("  [PASS] (d) absent fsService -> safe no-op");
}

// ---------------------------------------------------------------------------
// Vector (e): integration — a real runner run with a >8KB bash observation.
// ---------------------------------------------------------------------------
async function vectorE() {
  const toolCall = {
    id: "call_e_big",
    type: "function",
    function: {
      name: "bash",
      arguments: JSON.stringify({ command: "node -e \"console.log('Z'.repeat(50000))\"" }),
    },
  };
  const llm = makeMockLlm([
    { content: "", toolCalls: [toolCall], finishReason: "stop" },
    { content: "Done.", finishReason: "stop" },
  ]);
  const logger = makeMockLogger();
  const runner = new AnserRunner({ llm, logger });

  const res = await runner.run({
    prompt: "Run big command.",
    sessionId: "test_e",
    maxTurns: 5,
  });

  assert.strictEqual(res.status, "completed", "e: run completes");
  const toolMsg = llm._lastMessages?.find((m) => m.role === "tool" && m.tool_call_id === "call_e_big");
  assert.ok(toolMsg, "e: tool message present");
  assert.ok(toolMsg.content.includes("[Tool output spilled to disk"), "e: in-band message is a spill pointer");
  assert.ok(toolMsg.content.includes("tool_out_call_e_big.txt"), "e: pointer names the spill file");
  assert.ok(Buffer.byteLength(toolMsg.content, "utf8") < 4096, "e: in-band pointer is small");
  // The payload landed in the sandbox .scratch/ dir (cwd = process.cwd()).
  // NOTE: the shell executor has its OWN 48KB cap (shell_executor.js) that runs
  // BEFORE the spill, so bash output is pre-capped at ~48KB. The spill still
  // engages (48KB > 8KB threshold) and writes the (capped) payload to disk.
  const spillPath = path.join(process.cwd(), ".scratch", "tool_out_call_e_big.txt");
  assert.ok(fs.existsSync(spillPath), "e: spill file written to .scratch/");
  const spillBytes = Buffer.byteLength(fs.readFileSync(spillPath, "utf8"), "utf8");
  assert.ok(spillBytes > 8192, `e: spill file holds the (capped) payload (${spillBytes} bytes > 8KB threshold)`);
  assert.ok(fs.readFileSync(spillPath, "utf8").includes("Z"), "e: spill file contains the command output");
  // A tool_output_spilled event was logged.
  assert.ok(
    logger.events.some((e) => e.type === "tool_output_spilled" && e.toolCallId === "call_e_big"),
    "e: tool_output_spilled event logged"
  );
  fs.rmSync(spillPath, { force: true });
  console.log("  [PASS] (e) integration: >8KB bash observation -> spilled to .scratch/ + small pointer + event");
}

// ---------------------------------------------------------------------------
// Run all vectors.
// ---------------------------------------------------------------------------
async function main() {
  console.log("=== E1: FS-as-context tool-output spillover (offline) ===");
  const vectors = [
    ["(a)", vectorA],
    ["(b)", vectorB],
    ["(c)", vectorC],
    ["(d)", vectorD],
    ["(e)", vectorE],
  ];
  let passed = 0;
  let failed = 0;
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
  console.log(`Tool-Output Spill Verification: ${passed} / ${vectors.length} vectors passed`);
  if (failed > 0) {
    console.log(`Verdict: ${failed} VECTOR(S) FAILED.`);
    process.exit(1);
  }
  console.log(`Verdict: ALL SPILL VECTORS PASSED.`);
  console.log(`==========================================================================`);
  process.exit(0);
}

main().catch((e) => {
  console.error("HARNESS FAILURE:", e);
  process.exit(1);
});
