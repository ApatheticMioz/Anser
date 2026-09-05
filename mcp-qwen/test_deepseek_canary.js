/**
 * Fast Canary Pilot Validation for DeepSeek-AVO
 *
 * Verifies:
 * 1. AST structural search & rewrite with ast-grep
 * 2. Mandatory syntax validation gate (rejection of broken code without disk mutation)
 * 3. Traceback & failure condenser (compact <=100 token digest from noisy tracebacks)
 * 4. AVO candidate evaluation with failure digest feedback and clean rollback
 * 5. Dual platform cross-check
 */

import fs from "node:fs";
import path from "node:path";
import { AstService } from "./src/harness/services/ast_service.js";
import { condenseTraceback } from "./src/harness/avo/trace_repair.js";
import { Context } from "./src/harness/core/kernel.js";
import { astPlugin } from "./src/harness/services/ast_service.js";
import { avoPlugin } from "./src/harness/avo/avo_operator.js";
import { shellExecutorPlugin } from "./src/harness/services/shell_executor.js";
import { sandboxFsPlugin } from "./src/harness/services/sandbox_fs.js";

const TEST_DIR = path.join(process.cwd(), "mcp-qwen", ".canary_tmp");
fs.mkdirSync(TEST_DIR, { recursive: true });

async function runCanary() {
  console.log("=== Starting DeepSeek-AVO Canary Pilot ===");
  let passed = 0;
  let failed = 0;

  function assert(condition, name) {
    if (condition) {
      console.log(`[PASS] ${name}`);
      passed++;
    } else {
      console.error(`[FAIL] ${name}`);
      failed++;
    }
  }

  // --- Test 1: AST Search ---
  console.log("\n[Test 1: AST Structural Search]");
  const sampleJs = path.join(TEST_DIR, "sample.js");
  fs.writeFileSync(
    sampleJs,
    `
function add(a, b) {
  return a + b;
}

function multiply(x, y) {
  const product = x * y;
  return product;
}
`,
    "utf8"
  );

  const ast = new AstService({ root: process.cwd() });
  const searchRes = await ast.search({
    path: sampleJs,
    pattern: "function $NAME($$$ARGS) { $$$BODY }",
    lang: "js",
  });

  console.log("Matches:", JSON.stringify(searchRes.matches, null, 2));
  assert(searchRes.count === 2, `Found exactly 2 functions (got ${searchRes.count})`);
  assert(
    searchRes.matches.some((m) => m.metavariables.NAME === "add"),
    "Captured function 'add'"
  );
  assert(
    searchRes.matches.some((m) => m.metavariables.NAME === "multiply"),
    "Captured function 'multiply'"
  );

  // --- Test 2: AST Replace with Formatting Preservation ---
  console.log("\n[Test 2: AST Structural Replace]");
  const replaceRes = await ast.replace({
    path: sampleJs,
    pattern: "function add($A, $B) { return $A + $B; }",
    rewrite: "function add($A, $B) { /* optimized */ return ($A + $B) | 0; }",
    lang: "js",
  });

  assert(replaceRes.modified === true, "AST replacement modified the file");
  const mutatedContent = fs.readFileSync(sampleJs, "utf8");
  assert(
    mutatedContent.includes("/* optimized */ return (a + b) | 0;"),
    "Syntactic rewrite applied correctly with captured variables"
  );

  // --- Test 3: Compile-Check Gate (Rejection of Broken Syntax) ---
  console.log("\n[Test 3: Mandatory Syntax Validation Gate]");
  let rejected = false;
  try {
    await ast.replace({
      path: sampleJs,
      pattern: "function multiply($$$ARGS) { $$$BODY }",
      rewrite: "function multiply($$$ARGS) { return x * ; }", // invalid syntax
      lang: "js",
    });
  } catch (err) {
    if (err.message.includes("SyntaxValidationError")) {
      rejected = true;
    }
  }

  assert(rejected === true, "SyntaxValidationError triggered on malformed rewrite");
  const pristineContent = fs.readFileSync(sampleJs, "utf8");
  assert(
    pristineContent.includes("const product = x * y;"),
    "File disk content was rolled back and preserved pristine"
  );

  // --- Test 4: Traceback & Failure Condenser ---
  console.log("\n[Test 4: Traceback & Failure Condenser]");
  const noisyPytestStderr = `
============================= test session starts ==============================
rootdir: /mnt/d/LLM_Ecosystem
plugins: xdist-3.5.0
collected 1 item

test_core.py F                                                           [100%]

=================================== FAILURES ===================================
__________________________________ test_calc ___________________________________

    def test_calc():
>       assert calculate_score(10) == 100
E       AssertionError: assert 50 == 100
E        +  where 50 = calculate_score(10)

/mnt/d/LLM_Ecosystem/tests/test_core.py:15: AssertionError
----------------------------- Captured stderr call -----------------------------
Traceback (most recent call last):
  File "/usr/local/lib/python3.11/site-packages/pytest/__init__.py", line 42, in run
    runner()
  File "/mnt/d/LLM_Ecosystem/src/calculator.py", line 28, in calculate_score
    return base * 5
AssertionError: assert 50 == 100
=========================== short test summary info ============================
FAILED test_core.py::test_calc - AssertionError: assert 50 == 100
============================== 1 failed in 0.12s ===============================
`;

  const digest = condenseTraceback({
    stderr: noisyPytestStderr,
    exitCode: 1,
    workspaceRoot: "/mnt/d/LLM_Ecosystem",
  });

  assert(digest.failureType === "assertion_failure", "Detected assertion_failure");
  assert(digest.targetFile.includes("calculator.py"), "Filtered out site-packages to find calculator.py");
  assert(digest.targetLine === 28, "Identified line 28 in user repo");
  assert(digest.targetSymbol === "calculate_score", "Identified symbol calculate_score");
  assert(digest.summary.includes("[FailureDigest]"), "Generated compact [FailureDigest]");
  assert(digest.summary.length < 200, `Digest is bounded (${digest.summary.length} chars)`);

  // --- Test 5: Cordis AVO Closed-Loop Integration ---
  console.log("\n[Test 5: Cordis AVO Integration with Failure Digest]");
  const ctx = new Context(null, "canary_session");
  ctx.plugin(sandboxFsPlugin, { root: process.cwd() });
  ctx.plugin(shellExecutorPlugin, { cwd: process.cwd() });
  ctx.plugin(astPlugin, { root: process.cwd() });
  ctx.plugin(avoPlugin, { workspaceRoot: process.cwd() });

  const avo = ctx.get("avo");
  const proposeRes = await avo.proposeCandidate({
    hypothesis: "Test candidate for canary validation",
    files_to_modify: [sampleJs],
  });

  assert(proposeRes.candidate_id.startsWith("cand_"), `Proposed candidate: ${proposeRes.candidate_id}`);

  // Intentionally modify file
  fs.writeFileSync(sampleJs, "// mutated for candidate\n", "utf8");

  // Revert candidate
  const revertRes = await avo.revertCandidate({ candidate_id: proposeRes.candidate_id });
  assert(revertRes.status === "rejected", "Cleanly reverted candidate via snapshot");

  const restoredContent = fs.readFileSync(sampleJs, "utf8");
  assert(restoredContent.includes("/* optimized */"), "Workspace snapshot cleanly restored");

  // Cleanup
  fs.rmSync(TEST_DIR, { recursive: true, force: true });

  console.log("\n==========================================");
  console.log(`Canary Pilot Completed: ${passed} PASSED, ${failed} FAILED`);
  console.log("==========================================");
  if (failed > 0) process.exit(1);
}

runCanary().catch((err) => {
  console.error("Canary uncaught error:", err);
  process.exit(1);
});
