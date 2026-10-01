#!/usr/bin/env node
/**
 * FX4 — EVO Lineage Integrity (fully OFFLINE)
 *
 * Covers the four confirmed defects in the EVO lineage DAG domain, using the
 * repo's established offline pattern (isolated QWEN_STATE_DIR temp dir,
 * fresh mkdtemp workspace per test, check() counters, hard exit code). No
 * real vLLM, no real WSL, and the production .evo/lineage.json is never
 * touched — every test operates on a private temp workspace.
 *
 *   D4   (singleton + read-modify-write)
 *        (a) LineageDag.forWorkspace(root) returns the SAME instance for the
 *            same root and DIFFERENT instances for different roots.
 *        (b) No last-writer-wins: two writers (the engine-side singleton and a
 *            second direct instance simulating the old operator-side writer)
 *            each add a node; ALL nodes survive in the final file.
 *   D15  (version gate)
 *        (a) a lineage.json with a FUTURE/unknown version -> load throws a
 *            LineageVersionError naming BOTH versions.
 *        (b) a current-version file loads fine and preserves its nodes.
 *   D1   (honest NEUTRAL)
 *        (a) a legacy `candidates` file with status "NEUTRAL" loads as
 *            "neutral", never "rejected"/"failed".
 *        (b) the EvoLineageEngine `state` getter maps a neutral node to
 *            "NEUTRAL", never "FAILED".
 *   D2   (honest unknown commit)
 *        (a) getCurrentCommit() in a non-git temp dir returns null (not the
 *            fabricated "uncommitted_init").
 *        (b) recordCandidate() records commitSha: null for that unknown
 *            parentage (the call-site shape).
 *
 * Run: node tests/lineage_integrity.test.js
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Isolate ALL on-disk state in a fresh temp dir BEFORE any src import so
// config.js pins QWEN_STATE_DIR to the private dir. The production .evo/
// lineage.json and ~/.qwen are never read or written.
// ---------------------------------------------------------------------------
const TMP_STATE = fs.mkdtempSync(path.join(os.tmpdir(), "fx4_state_"));
process.env.QWEN_STATE_DIR = TMP_STATE;
process.env.HOME = TMP_STATE;
process.env.QWEN_WSL_HOME = TMP_STATE;
process.env.QWEN_WIN_HOME = TMP_STATE;

const {
  LineageDag,
  LINEAGE_VERSION,
  KNOWN_LINEAGE_VERSIONS,
  LineageVersionError,
} = await import("../src/harness/evo/lineage_dag.js");
const { EvoLineageEngine } = await import("../src/evo_engine.js");

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`[PASS] ${name}`);
    passed++;
  } catch (err) {
    console.error(`[FAIL] ${name}: ${err.message}`);
    failed++;
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    console.log(`[PASS] ${name}`);
    passed++;
  } catch (err) {
    console.error(`[FAIL] ${name}: ${err.message}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function freshWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fx4_ws_"));
}
function writeLineage(dir, obj) {
  const evoDir = path.join(dir, ".evo");
  fs.mkdirSync(evoDir, { recursive: true });
  fs.writeFileSync(path.join(evoDir, "lineage.json"), JSON.stringify(obj, null, 2), "utf8");
}
function readLineage(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, ".evo", "lineage.json"), "utf8"));
}
function nodeIds(data) {
  return new Set((data.nodes || []).map((n) => n.id));
}

// ---------------------------------------------------------------------------
// D4(a): singleton identity
// ---------------------------------------------------------------------------
{
  const rootA = freshWorkspace();
  const rootB = freshWorkspace();
  check("D4a: forWorkspace(same root) returns the SAME instance", () => {
    const a1 = LineageDag.forWorkspace(rootA);
    const a2 = LineageDag.forWorkspace(rootA);
    assert.strictEqual(a1, a2, "two forWorkspace calls for the same root must share one instance");
  });
  check("D4a: forWorkspace(different roots) returns DIFFERENT instances", () => {
    const a = LineageDag.forWorkspace(rootA);
    const b = LineageDag.forWorkspace(rootB);
    assert.notStrictEqual(a, b, "different roots must yield different instances");
  });
  check("D4a: the singleton is the same object the engine uses", () => {
    const engine = new EvoLineageEngine(rootA);
    assert.strictEqual(engine.dag, LineageDag.forWorkspace(rootA), "EvoLineageEngine must share the per-workspace singleton");
  });
}

// ---------------------------------------------------------------------------
// D4(b): no last-writer-wins (two writers, all nodes survive)
// ---------------------------------------------------------------------------
await checkAsync("D4b: two writers -> all nodes survive (no clobber)", async () => {
  const root = freshWorkspace();
  // Writer 1: the engine-side singleton.
  const dag1 = LineageDag.forWorkspace(root);
  dag1.addCandidate({ id: "node_A", hypothesis: "writer1-A" });

  // Writer 2: a second direct instance (simulates the OLD operator-side
  // writer that had its own in-memory copy). It loads the file (sees A).
  const dag2 = new LineageDag({ workspaceRoot: root });
  assert.ok(dag2.nodes.has("node_A"), "writer2 loaded writer1's node A from disk");
  dag2.addCandidate({ id: "node_B", hypothesis: "writer2-B" });

  // Writer 1 is now STALE (its memory only has A). It adds C and persists.
  // The read-modify-write merge must re-read disk (A+B) and keep all three.
  dag1.addCandidate({ id: "node_C", hypothesis: "writer1-C" });

  const final = readLineage(root);
  const ids = nodeIds(final);
  assert.ok(ids.has("node_A"), "node_A must survive");
  assert.ok(ids.has("node_B"), "node_B (writer2) must survive — no last-writer-wins");
  assert.ok(ids.has("node_C"), "node_C must survive");
  assert.strictEqual(final.nodes.length, 4, "baseline + A + B + C, no node lost");
});

// ---------------------------------------------------------------------------
// D15: version gate
// ---------------------------------------------------------------------------
{
  const futureDir = freshWorkspace();
  writeLineage(futureDir, {
    version: "9999.9",
    rootId: "baseline",
    currentHeadId: "baseline",
    nodes: [{ id: "baseline", parentId: null, hypothesis: "b", filesModified: [], metrics: { fitness: 0, status: "accepted" }, timestamp: "2026-01-01T00:00:00.000Z" }],
  });
  check("D15a: future-version file -> load throws LineageVersionError naming both versions", () => {
    assert.throws(
      () => new LineageDag({ workspaceRoot: futureDir }),
      (err) => {
        assert.ok(err instanceof LineageVersionError, `expected LineageVersionError, got ${err.constructor.name}: ${err.message}`);
        assert.ok(err.message.includes("9999.9"), `message names the file version: ${err.message}`);
        assert.ok(err.message.includes(LINEAGE_VERSION), `message names the current version (${LINEAGE_VERSION}): ${err.message}`);
        return true;
      }
    );
  });

  const currentDir = freshWorkspace();
  writeLineage(currentDir, {
    version: LINEAGE_VERSION,
    rootId: "baseline",
    currentHeadId: "baseline",
    nodes: [
      { id: "baseline", parentId: null, hypothesis: "b", filesModified: [], metrics: { fitness: 0, status: "accepted" }, timestamp: "2026-01-01T00:00:00.000Z" },
      { id: "cand_x", parentId: "baseline", hypothesis: "x", filesModified: [], metrics: { fitness: 5, status: "accepted" }, timestamp: "2026-01-02T00:00:00.000Z" },
    ],
  });
  check("D15b: current-version file loads fine and preserves nodes", () => {
    const dag = new LineageDag({ workspaceRoot: currentDir });
    assert.ok(dag.nodes.has("baseline"), "baseline preserved");
    assert.ok(dag.nodes.has("cand_x"), "cand_x preserved");
    assert.strictEqual(dag.currentHeadId, "baseline", "head preserved");
  });

  check("D15c: KNOWN_LINEAGE_VERSIONS contains the current version", () => {
    assert.ok(KNOWN_LINEAGE_VERSIONS.has(LINEAGE_VERSION), "current version is in the known set");
  });
}

// ---------------------------------------------------------------------------
// D1: honest NEUTRAL (legacy candidates migration + state getter)
// ---------------------------------------------------------------------------
{
  const legacyDir = freshWorkspace();
  // Legacy flat `candidates` format (no `nodes`), with a NEUTRAL status.
  writeLineage(legacyDir, {
    version: LINEAGE_VERSION,
    rootId: "baseline",
    currentHeadId: "baseline",
    candidates: [
      { candidateId: "cand_neutral", parentCommit: "baseline", hypothesis: "n", filesModified: [], metricScore: null, status: "NEUTRAL", commitSha: null, errorLog: null, timestamp: "2026-01-03T00:00:00.000Z" },
      { candidateId: "cand_rejected", parentCommit: "baseline", hypothesis: "r", filesModified: [], metricScore: -1, status: "REJECTED", commitSha: null, errorLog: "boom", timestamp: "2026-01-04T00:00:00.000Z" },
    ],
  });
  check("D1a: legacy NEUTRAL candidate loads as 'neutral', not 'rejected'", () => {
    const dag = new LineageDag({ workspaceRoot: legacyDir });
    const n = dag.nodes.get("cand_neutral");
    assert.ok(n, "cand_neutral imported");
    assert.strictEqual(n.metrics.status, "neutral", `NEUTRAL must map to neutral, got ${n.metrics.status}`);
    assert.notStrictEqual(n.metrics.status, "rejected", "NEUTRAL must NOT be fabricated as rejected");
  });
  check("D1a: legacy REJECTED candidate still maps to 'rejected' (other mappings preserved)", () => {
    const dag = new LineageDag({ workspaceRoot: legacyDir });
    const r = dag.nodes.get("cand_rejected");
    assert.strictEqual(r.metrics.status, "rejected", "REJECTED must still map to rejected");
  });

  const neutralDir = freshWorkspace();
  writeLineage(neutralDir, {
    version: LINEAGE_VERSION,
    rootId: "baseline",
    currentHeadId: "baseline",
    nodes: [
      { id: "baseline", parentId: null, hypothesis: "b", filesModified: [], metrics: { fitness: 0, status: "accepted" }, timestamp: "2026-01-01T00:00:00.000Z" },
      { id: "cand_neutral2", parentId: "baseline", hypothesis: "n2", filesModified: [], metrics: { fitness: null, status: "neutral" }, timestamp: "2026-01-05T00:00:00.000Z" },
    ],
  });
  check("D1b: EvoLineageEngine.state maps a neutral node to 'NEUTRAL', not 'FAILED'", () => {
    const engine = new EvoLineageEngine(neutralDir);
    const cand = engine.state.candidates.find((c) => c.candidateId === "cand_neutral2");
    assert.ok(cand, "neutral candidate present in state view");
    assert.strictEqual(cand.status, "NEUTRAL", `neutral must surface as NEUTRAL, got ${cand.status}`);
    assert.notStrictEqual(cand.status, "FAILED", "neutral must NOT be fabricated as FAILED");
  });

  const headlessDir = freshWorkspace();
  // Historical legacy files carry candidates WITHOUT a currentHeadId field.
  // The migration must preserve its original semantics: the ACCEPTED
  // candidate becomes head (and a NEUTRAL one must NOT).
  writeLineage(headlessDir, {
    version: LINEAGE_VERSION,
    rootId: "baseline",
    candidates: [
      { candidateId: "cand_neutral_h", parentCommit: "baseline", hypothesis: "n", filesModified: [], metricScore: null, status: "NEUTRAL", commitSha: null, errorLog: null, timestamp: "2026-01-03T00:00:00.000Z" },
      { candidateId: "cand_accepted_h", parentCommit: "baseline", hypothesis: "a", filesModified: [], metricScore: 9, status: "ACCEPTED", commitSha: "abc123", errorLog: null, timestamp: "2026-01-06T00:00:00.000Z" },
    ],
  });
  check("D1c: headless legacy file -> accepted candidate becomes currentHeadId", () => {
    const dag = new LineageDag({ workspaceRoot: headlessDir });
    assert.strictEqual(dag.currentHeadId, "cand_accepted_h", `head must be the accepted candidate, got ${dag.currentHeadId}`);
  });
}

// ---------------------------------------------------------------------------
// D2: honest unknown commit
// ---------------------------------------------------------------------------
await checkAsync("D2a: getCurrentCommit() in a non-git temp dir returns null", async () => {
  const dir = freshWorkspace();
  const engine = new EvoLineageEngine(dir);
  const commit = await engine.getCurrentCommit();
  assert.strictEqual(commit, null, `expected null (genuinely unknown), got ${JSON.stringify(commit)}`);
  assert.notStrictEqual(commit, "uncommitted_init", "must not fabricate 'uncommitted_init'");
});

await checkAsync("D2b: recordCandidate() records commitSha: null for unknown parentage", async () => {
  const dir = freshWorkspace();
  const engine = new EvoLineageEngine(dir);
  const res = await engine.recordCandidate({
    hypothesis: "D2 unknown-commit candidate",
    testCommand: "node -e \"process.exit(0)\"",
    metricScore: null,
    stdout: "ok",
  });
  assert.ok(res.candidateId, "a candidate was recorded");
  const node = engine.dag.nodes.get(res.candidateId);
  assert.ok(node, "recorded node exists in the DAG");
  assert.strictEqual(node.metrics.commitSha, null, `commitSha must be null (unknown), got ${JSON.stringify(node.metrics.commitSha)}`);
  assert.notStrictEqual(node.metrics.commitSha, "uncommitted_init", "must not fabricate a commit hash");
  // The on-disk file must also carry the honest null.
  const onDisk = readLineage(dir).nodes.find((n) => n.id === res.candidateId);
  assert.strictEqual(onDisk.metrics.commitSha, null, "on-disk commitSha is null");
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log("");
console.log("==========================================");
console.log(`Lineage Integrity Tests: ${passed} PASSED, ${failed} FAILED`);
console.log("==========================================");
if (failed > 0) process.exit(1);
