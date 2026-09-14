#!/usr/bin/env node
/**
 * qwen_tasks_exporter.test.js — Offline test for scripts/qwen_tasks_analysis.mjs
 * (M8, F17/F18).
 *
 * The exporter is a repo-level tool (lives in the repo-root `scripts/`, OUTSIDE
 * the self-contained mcp-qwen npm package). mcp-qwen's tests import only from
 * `../src/` and never reach the repo root, so wiring this into mcp-qwen's
 * `npm test` chain would cross the package boundary. Per the M8 instruction,
 * this is therefore a STANDALONE test, run directly:
 *
 *     node tests/qwen_tasks_exporter.test.js
 *
 * It is documented in scripts/README.md. No vLLM, no network, no deps.
 *
 * The test builds a tiny fixture in a temp dir:
 *   - session "shared-s1"  : 2 dispatches (task_a earlier, task_b later) that
 *                             share ONE session, with a synthetic events.jsonl
 *                             (4 assistant_message turns + recovery/tool/end
 *                             events).
 *   - session "noevents-s1": 1 dispatch with NO events file (the "unknown"
 *                             case).
 *
 * It runs the exporter as a child process and asserts the three CORRECTED
 * semantics:
 *   (1) promptTokens = MAX per-turn promptTokens (final context depth), never
 *       0; null when the engine never reported a non-zero value or there are
 *       no events.
 *   (2) Session-cumulative fields (turns, completionTokens, thinkingTokens,
 *       tools, totalBash, ttftMedMs, continuations, emptyStreamRetries,
 *       engineEmptyResponses) are stamped ONLY on the LAST dispatch row of a
 *       session; other rows carry null (no double-counting).
 *   (3) rateAvgTokS derives per-turn tokens/sec from (totalMs - ttftMs) when
 *       the engine's tokensPerSec is absent/0.
 *
 * Plus: per-dispatch fields differ per row; the no-events session yields null
 * (not 0) for every session-derived field; output is field-compatible (25
 * fields, fixed order) with the committed 2026-09-13 analysis.
 */

import assert from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXPORTER = path.resolve(__dirname, "..", "scripts", "qwen_tasks_analysis.mjs");

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

// 4 assistant_message turns with a monotonically growing promptTokens (the
// "final context depth" the corrected promptTokens must capture as the MAX).
// turns 1 and 3 have tokensPerSec=0 to exercise the (3) derivation; turns 2
// and 4 carry engine tokensPerSec.
const EVENTS = [
  {
    timestamp: "2026-09-12T10:00:00.000Z",
    sessionId: "shared-s1",
    type: "session_start",
    harness: "Anser",
    version: "2026.1",
    cwd: "D:\\LLM_Ecosystem",
    prompt: "dispatch one prompt",
  },
  {
    timestamp: "2026-09-12T10:00:01.000Z",
    sessionId: "shared-s1",
    type: "assistant_message",
    content: "",
    finishReason: "tool_calls",
    metrics: {
      promptTokens: 1000,
      completionTokens: 50,
      reasoningTokens: 10,
      ttftMs: 100,
      totalMs: 1000,
      tokensPerSec: 0, // -> derived: 50 / 0.9s = 55.56
    },
  },
  {
    timestamp: "2026-09-12T10:00:01.100Z",
    sessionId: "shared-s1",
    type: "tool_call",
    name: "bash",
    args: { command: "ls -la" },
  },
  {
    timestamp: "2026-09-12T10:00:02.000Z",
    sessionId: "shared-s1",
    type: "assistant_message",
    content: "",
    finishReason: "tool_calls",
    metrics: {
      promptTokens: 2000,
      completionTokens: 100,
      reasoningTokens: 20,
      ttftMs: 200,
      totalMs: 2000,
      tokensPerSec: 5, // engine value, used as-is
    },
  },
  {
    timestamp: "2026-09-12T10:00:02.100Z",
    sessionId: "shared-s1",
    type: "tool_call",
    name: "read_file",
    args: { path: "/tmp/a.txt" },
  },
  {
    timestamp: "2026-09-12T10:00:03.000Z",
    sessionId: "shared-s1",
    type: "assistant_message",
    content: "",
    finishReason: "tool_calls",
    metrics: {
      promptTokens: 3000,
      completionTokens: 150,
      reasoningTokens: 30,
      ttftMs: 300,
      totalMs: 3000,
      tokensPerSec: 0, // -> derived: 150 / 2.7s = 55.56
    },
  },
  {
    timestamp: "2026-09-12T10:00:03.100Z",
    sessionId: "shared-s1",
    type: "tool_call",
    name: "bash",
    args: { command: "pwd" },
  },
  {
    timestamp: "2026-09-12T10:00:04.000Z",
    sessionId: "shared-s1",
    type: "assistant_message",
    content: "final answer",
    finishReason: "stop",
    metrics: {
      promptTokens: 4000,
      completionTokens: 200,
      reasoningTokens: 40,
      ttftMs: 400,
      totalMs: 4000,
      tokensPerSec: 8, // engine value, used as-is
    },
  },
  {
    timestamp: "2026-09-12T10:00:04.100Z",
    sessionId: "shared-s1",
    type: "tool_call",
    name: "write_file",
    args: { path: "/tmp/out.txt", content: "x" },
  },
  {
    timestamp: "2026-09-12T10:00:05.000Z",
    sessionId: "shared-s1",
    type: "continuation_injected",
  },
  {
    timestamp: "2026-09-12T10:00:05.100Z",
    sessionId: "shared-s1",
    type: "empty_stream_retry",
  },
  {
    timestamp: "2026-09-12T10:00:05.200Z",
    sessionId: "shared-s1",
    type: "engine_empty_response",
  },
  {
    timestamp: "2026-09-12T10:00:06.000Z",
    sessionId: "shared-s1",
    type: "session_end",
    status: "completed",
    turnsTaken: 4,
    continuationsInjected: 1,
    durationMs: 6000,
    totalCompletionTokens: 500,
  },
];

// Two dispatches sharing session "shared-s1". task_b is later (the LAST row).
const TASK_A = {
  id: "task_a_1000",
  sessionId: "shared-s1",
  cwd: "D:\\LLM_Ecosystem",
  prompt: "first dispatch prompt",
  createdAt: 1789216000000,
  startedAt: 1789216001000,
  finishedAt: 1789216006000,
  status: "completed",
  done: true,
  isError: false,
  toolCallsCount: 4,
  fileOps: ["bash:", "read_file:/tmp/a.txt", "bash:", "write_file:/tmp/out.txt"],
};

const TASK_B = {
  id: "task_b_2000",
  sessionId: "shared-s1",
  cwd: "D:\\LLM_Ecosystem",
  prompt: "second dispatch prompt (reused session)",
  createdAt: 1789216100000,
  startedAt: 1789216101000,
  finishedAt: 1789216106000,
  status: "completed",
  done: true,
  isError: false,
  toolCallsCount: 4,
  fileOps: ["bash:", "read_file:/tmp/a.txt", "bash:", "write_file:/tmp/out.txt"],
};

// One dispatch in a session with NO events file (the "unknown" case).
const TASK_C = {
  id: "task_c_3000",
  sessionId: "noevents-s1",
  cwd: "D:\\LLM_Ecosystem",
  prompt: "orphan dispatch, no events",
  createdAt: 1789216200000,
  startedAt: 1789216201000,
  finishedAt: 1789216206000,
  status: "failed",
  done: true,
  isError: true,
  toolCallsCount: 0,
  fileOps: [],
};

function buildFixture(root) {
  const tasksDir = path.join(root, "tasks");
  const sessionsDir = path.join(root, "sessions");
  const sharedEvents = path.join(sessionsDir, "shared-s1", "events.jsonl");
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.mkdirSync(path.dirname(sharedEvents), { recursive: true });
  fs.writeFileSync(path.join(tasksDir, "task_a_1000.json"), JSON.stringify(TASK_A, null, 2));
  fs.writeFileSync(path.join(tasksDir, "task_b_2000.json"), JSON.stringify(TASK_B, null, 2));
  fs.writeFileSync(path.join(tasksDir, "task_c_3000.json"), JSON.stringify(TASK_C, null, 2));
  fs.writeFileSync(sharedEvents, EVENTS.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return { tasksDir, sessionsDir };
}

// ---------------------------------------------------------------------------
// Run the exporter as a child process
// ---------------------------------------------------------------------------

function runExporter(tasksDir, sessionsDir, out) {
  const res = spawnSync(
    process.execPath,
    [EXPORTER, "--tasks-dir", tasksDir, "--sessions-dir", sessionsDir, "--out", out],
    { encoding: "utf8" }
  );
  if (res.status !== 0) {
    throw new Error(
      `exporter exited ${res.status}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`
    );
  }
  return JSON.parse(fs.readFileSync(out, "utf8"));
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-tasks-exporter-"));
  const { tasksDir, sessionsDir } = buildFixture(tmp);
  const out = path.join(tmp, "out.json");
  const rows = runExporter(tasksDir, sessionsDir, out);

  // --- shape: 3 rows, sorted by createdAt ---------------------------------
  assert.strictEqual(rows.length, 3, "expected 3 rows");
  const byId = Object.fromEntries(rows.map((r) => [r.taskId, r]));
  assert.deepStrictEqual(
    rows.map((r) => r.taskId),
    ["task_a_1000", "task_b_2000", "task_c_3000"],
    "rows sorted by createdAt"
  );

  // --- field compatibility: 25 fields, fixed order -------------------------
  const EXPECTED_FIELDS = [
    "taskId", "sessionId", "cwd", "createdAt", "durationSec", "status",
    "isError", "endStatus", "promptLen", "prompt", "toolCallsCount", "tools",
    "totalBash", "bashCommandsSummary", "filesWritten", "filesReadCount",
    "turns", "promptTokens", "completionTokens", "thinkingTokens",
    "ttftMedMs", "rateAvgTokS", "continuations", "emptyStreamRetries",
    "engineEmptyResponses",
  ];
  for (const r of rows) {
    assert.deepStrictEqual(Object.keys(r), EXPECTED_FIELDS, "field order/compat");
  }

  // --- (1) promptTokens = MAX per-turn, never 0, on every row -------------
  // max(1000,2000,3000,4000) = 4000. Present on BOTH shared-s1 rows.
  assert.strictEqual(byId["task_a_1000"].promptTokens, 4000, "promptTokens max (row a)");
  assert.strictEqual(byId["task_b_2000"].promptTokens, 4000, "promptTokens max (row b)");
  assert.ok(byId["task_a_1000"].promptTokens > 0, "promptTokens never 0");

  // --- (2) session-cumulative: null on the FIRST row, set on the LAST -----
  const CUM = [
    "turns", "completionTokens", "thinkingTokens", "tools", "totalBash",
    "ttftMedMs", "continuations", "emptyStreamRetries", "engineEmptyResponses",
  ];
  // task_a is the first dispatch of shared-s1 -> all cumulative null.
  for (const f of CUM) {
    assert.strictEqual(byId["task_a_1000"][f], null, `cumulative ${f} null on first row`);
  }
  // task_b is the LAST dispatch of shared-s1 -> all cumulative set.
  assert.strictEqual(byId["task_b_2000"].turns, 4, "turns on last row");
  assert.strictEqual(byId["task_b_2000"].completionTokens, 500, "completionTokens sum on last row");
  assert.strictEqual(byId["task_b_2000"].thinkingTokens, 100, "thinkingTokens sum on last row");
  assert.strictEqual(byId["task_b_2000"].totalBash, 2, "totalBash on last row");
  assert.deepStrictEqual(byId["task_b_2000"].tools, { bash: 2, read_file: 1, write_file: 1 }, "tools on last row");
  assert.strictEqual(byId["task_b_2000"].ttftMedMs, 300, "ttftMedMs (median) on last row");
  assert.strictEqual(byId["task_b_2000"].continuations, 1, "continuations on last row");
  assert.strictEqual(byId["task_b_2000"].emptyStreamRetries, 1, "emptyStreamRetries on last row");
  assert.strictEqual(byId["task_b_2000"].engineEmptyResponses, 1, "engineEmptyResponses on last row");

  // --- (3) rateAvgTokS with honest derivation ------------------------------
  // turn1 derived 50/0.9=55.5556, turn2 engine 5, turn3 derived 150/2.7=55.5556,
  // turn4 engine 8  -> mean = (55.5556+5+55.5556+8)/4 = 31.03 -> 31.0
  const expectedRate = Math.round(((50 / 0.9 + 5 + 150 / 2.7 + 8) / 4) * 10) / 10;
  assert.strictEqual(byId["task_a_1000"].rateAvgTokS, expectedRate, "rateAvgTokS derived (row a)");
  assert.strictEqual(byId["task_b_2000"].rateAvgTokS, expectedRate, "rateAvgTokS derived (row b)");

  // --- session-level descriptive fields present on every row ---------------
  for (const id of ["task_a_1000", "task_b_2000"]) {
    const r = byId[id];
    assert.strictEqual(r.endStatus, "completed", "endStatus on every row");
    assert.deepStrictEqual(r.bashCommandsSummary, ["ls -la", "pwd"], "bashCommandsSummary on every row");
    assert.deepStrictEqual(r.filesWritten, ["/tmp/out.txt"], "filesWritten on every row");
    assert.strictEqual(r.filesReadCount, 1, "filesReadCount (unique) on every row");
  }

  // --- per-dispatch fields differ per row ----------------------------------
  assert.strictEqual(byId["task_a_1000"].prompt, "first dispatch prompt");
  assert.strictEqual(byId["task_b_2000"].prompt, "second dispatch prompt (reused session)");
  assert.strictEqual(byId["task_a_1000"].promptLen, "first dispatch prompt".length);
  assert.strictEqual(byId["task_b_2000"].promptLen, "second dispatch prompt (reused session)".length);
  assert.strictEqual(byId["task_a_1000"].durationSec, 5, "durationSec (finished-started) row a");
  assert.strictEqual(byId["task_b_2000"].durationSec, 5, "durationSec (finished-started) row b");
  assert.strictEqual(byId["task_a_1000"].createdAt, new Date(1789216000000).toISOString());
  assert.strictEqual(byId["task_b_2000"].createdAt, new Date(1789216100000).toISOString());

  // --- no-events session: null (not 0) for every session-derived field -----
  const c = byId["task_c_3000"];
  assert.strictEqual(c.sessionId, "noevents-s1");
  assert.strictEqual(c.promptTokens, null, "no events -> promptTokens null, not 0");
  assert.strictEqual(c.turns, null, "no events -> turns null");
  assert.strictEqual(c.completionTokens, null, "no events -> completionTokens null");
  assert.strictEqual(c.thinkingTokens, null, "no events -> thinkingTokens null");
  assert.strictEqual(c.ttftMedMs, null, "no events -> ttftMedMs null");
  assert.strictEqual(c.rateAvgTokS, null, "no events -> rateAvgTokS null");
  assert.strictEqual(c.tools, null, "no events -> tools null");
  assert.strictEqual(c.totalBash, null, "no events -> totalBash null");
  assert.strictEqual(c.continuations, null, "no events -> continuations null");
  assert.strictEqual(c.emptyStreamRetries, null, "no events -> emptyStreamRetries null");
  assert.strictEqual(c.engineEmptyResponses, null, "no events -> engineEmptyResponses null");
  assert.strictEqual(c.endStatus, null, "no events -> endStatus null");
  // per-dispatch fields still present
  assert.strictEqual(c.status, "failed");
  assert.strictEqual(c.isError, true);
  assert.strictEqual(c.promptLen, "orphan dispatch, no events".length);

  // --- no double-counting: summing cumulative over all rows == one session --
  // (the original defect: summing the repeated constant gave ~3x inflation)
  const sumTurns = rows.reduce((s, r) => s + (r.turns || 0), 0);
  assert.strictEqual(sumTurns, 4, "summing turns over all rows counts the session once");
  const sumCompletion = rows.reduce((s, r) => s + (r.completionTokens || 0), 0);
  assert.strictEqual(sumCompletion, 500, "summing completionTokens over all rows counts the session once");

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("qwen_tasks_exporter.test.js: PASS (3 rows; max-promptTokens, last-row-only cumulative, derived rate, null-not-zero)");
}

main();
