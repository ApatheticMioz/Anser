/**
 * M2 — Invisible AST & LaTeX Syntax Gates with Lean 8-Tool Action Space Test Suite
 *
 * Verifies:
 * 1. edit_file transparently validates syntax before writing to disk for TS, Python, JSON, LaTeX, and BibTeX.
 * 2. On syntax failure, throws SyntaxValidationError and keeps the on-disk file 100% pristine (zero bytes changed).
 * 3. On valid edits, successfully commits changes and returns syntax_verified: true.
 * 4. Unchecked extensions (.md, .txt) pass cleanly without false rejections (syntax_verified: false).
 * 5. Exactly 8 tools are exposed to Qwen in standard mode.
 * 6. Evo tools are mounted when evolutionary/benchmark testing is active.
 */

import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { Context } from "../src/harness/core/kernel.js";
import { SandboxFsService, sandboxFsPlugin, SyntaxValidationError } from "../src/harness/services/sandbox_fs.js";
import { shellExecutorPlugin } from "../src/harness/services/shell_executor.js";
import { astPlugin, AstService } from "../src/harness/services/ast_service.js";
import { evoPlugin } from "../src/harness/evo/evo_operator.js";

const TEST_DIR = path.resolve(process.cwd(), ".edit_syntax_tmp");

let passed = 0;
let failed = 0;

function ok(cond, name) {
  if (cond) {
    console.log(`  [PASS] ${name}`);
    passed++;
  } else {
    console.error(`  [FAIL] ${name}`);
    failed++;
  }
}

async function run() {
  console.log("=== M2 Edit-File Syntax Gates & 8-Tool Action Space Tests ===\n");

  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });

  const ctx = new Context(null, "test_session");
  ctx.plugin(astPlugin, { root: TEST_DIR });
  ctx.plugin(shellExecutorPlugin, { cwd: TEST_DIR });
  ctx.plugin(sandboxFsPlugin, { root: TEST_DIR });

  const fsService = ctx.get("fs");

  // -------------------------------------------------------------------------
  // 1. Tool count and names in standard mode (Lean 8-Tool Action Space)
  // -------------------------------------------------------------------------
  console.log("[Test 1] 8 Core Tools in Standard Mode");
  {
    const tools = ctx.listTools();
    const toolNames = tools.map((t) => t.function.name).sort();
    const expected = [
      "apply_patch",
      "ast_search",
      "bash",
      "edit_file",
      "list_dir",
      "read_file",
      "search_code",
      "write_file",
    ].sort();

    ok(toolNames.length === 8, `Tool count is exactly 8 (got ${toolNames.length})`);
    assert.deepEqual(toolNames, expected);
    ok(true, "Tools match exact 8 canonical tools");
    ok(!toolNames.includes("exec_command"), "exec_command alias is pruned");
    ok(!toolNames.includes("ast_replace"), "ast_replace is pruned from LLM tools");
    ok(!toolNames.includes("ast_replace_batch"), "ast_replace_batch is pruned from LLM tools");
  }

  // -------------------------------------------------------------------------
  // 2. Evo tools dynamically mounted when evo active
  // -------------------------------------------------------------------------
  console.log("\n[Test 2] Conditional Evo Plugin Mounting");
  {
    const evoCtx = new Context(null, "evo_session");
    evoCtx.plugin(astPlugin, { root: TEST_DIR });
    evoCtx.plugin(shellExecutorPlugin, { cwd: TEST_DIR });
    evoCtx.plugin(sandboxFsPlugin, { root: TEST_DIR });
    evoCtx.plugin(evoPlugin, { workspaceRoot: TEST_DIR });

    const tools = evoCtx.listTools();
    const toolNames = tools.map((t) => t.function.name);
    ok(toolNames.length === 13, `Evo tool count is 13 (got ${toolNames.length})`);
    ok(toolNames.includes("evo_propose_candidate"), "Includes evo_propose_candidate");
    ok(toolNames.includes("evo_evaluate_candidate"), "Includes evo_evaluate_candidate");
  }

  // -------------------------------------------------------------------------
  // 3. TypeScript Syntax Gate & Pristine Rollback
  // -------------------------------------------------------------------------
  console.log("\n[Test 3] TypeScript In-Memory Syntax Gate");
  {
    const tsFile = path.join(TEST_DIR, "math.ts");
    const originalTs = "export function calc(x: number): number {\n  return x * 2;\n}\n";
    fs.writeFileSync(tsFile, originalTs, "utf8");

    // Invalid edit: syntax error
    let threw = false;
    try {
      await fsService.editFile({
        path: tsFile,
        target_content: "return x * 2;",
        replacement_content: "return x * ;",
      });
    } catch (err) {
      threw = true;
      ok(err instanceof SyntaxValidationError || err.name === "SyntaxValidationError", "Throws SyntaxValidationError on broken TS");
    }
    ok(threw, "editFile rejected broken TypeScript edit");

    // Assert disk was untouched
    const afterBroken = fs.readFileSync(tsFile, "utf8");
    ok(afterBroken === originalTs, "On-disk TypeScript file remained 100% pristine after rejection");

    // Valid edit
    const validRes = await fsService.editFile({
      path: tsFile,
      target_content: "return x * 2;",
      replacement_content: "return x * 4;",
    });
    ok(validRes.success === true, "Valid TypeScript edit succeeds");
    ok(validRes.syntax_verified === true, "TypeScript edit reports syntax_verified: true");
    const afterValid = fs.readFileSync(tsFile, "utf8");
    ok(afterValid.includes("return x * 4;"), "On-disk TypeScript file successfully updated");
  }

  // -------------------------------------------------------------------------
  // 4. Python Syntax Gate & Pristine Rollback
  // -------------------------------------------------------------------------
  console.log("\n[Test 4] Python In-Memory Syntax Gate");
  {
    const pyFile = path.join(TEST_DIR, "calc.py");
    const originalPy = "def compute(a, b):\n    return a + b\n";
    fs.writeFileSync(pyFile, originalPy, "utf8");

    // Invalid edit: indentation error
    let threw = false;
    try {
      await fsService.editFile({
        path: pyFile,
        target_content: "    return a + b",
        replacement_content: "return a + b",
      });
    } catch (err) {
      threw = true;
      ok(err instanceof SyntaxValidationError || err.name === "SyntaxValidationError", "Throws SyntaxValidationError on broken Python indentation");
    }
    ok(threw, "editFile rejected broken Python edit");

    const afterBroken = fs.readFileSync(pyFile, "utf8");
    ok(afterBroken === originalPy, "On-disk Python file remained 100% pristine after rejection");

    // Valid edit
    const validRes = await fsService.editFile({
      path: pyFile,
      target_content: "return a + b",
      replacement_content: "return a + b + 1",
    });
    ok(validRes.success === true, "Valid Python edit succeeds");
    ok(validRes.syntax_verified === true, "Python edit reports syntax_verified: true");
    const afterValid = fs.readFileSync(pyFile, "utf8");
    ok(afterValid.includes("return a + b + 1"), "On-disk Python file successfully updated");
  }

  // -------------------------------------------------------------------------
  // 5. JSON Syntax Gate & Pristine Rollback
  // -------------------------------------------------------------------------
  console.log("\n[Test 5] JSON In-Memory Syntax Gate");
  {
    const jsonFile = path.join(TEST_DIR, "config.json");
    const originalJson = '{\n  "version": 1,\n  "enabled": true\n}\n';
    fs.writeFileSync(jsonFile, originalJson, "utf8");

    // Invalid edit: trailing comma
    let threw = false;
    try {
      await fsService.editFile({
        path: jsonFile,
        target_content: '"enabled": true',
        replacement_content: '"enabled": true,',
      });
    } catch (err) {
      threw = true;
      ok(err instanceof SyntaxValidationError || err.name === "SyntaxValidationError", "Throws SyntaxValidationError on broken JSON");
    }
    ok(threw, "editFile rejected broken JSON edit");

    const afterBroken = fs.readFileSync(jsonFile, "utf8");
    ok(afterBroken === originalJson, "On-disk JSON file remained 100% pristine after rejection");

    // Valid edit
    const validRes = await fsService.editFile({
      path: jsonFile,
      target_content: '"enabled": true',
      replacement_content: '"enabled": false',
    });
    ok(validRes.success === true, "Valid JSON edit succeeds");
    ok(validRes.syntax_verified === true, "JSON edit reports syntax_verified: true");
  }

  // -------------------------------------------------------------------------
  // 6. LaTeX Syntax Gate & Pristine Rollback (.tex)
  // -------------------------------------------------------------------------
  console.log("\n[Test 6] LaTeX In-Memory Syntax Gate");
  {
    const texFile = path.join(TEST_DIR, "paper.tex");
    const originalTex =
      "\\documentclass{article}\n" +
      "% Comment with % and { }\n" +
      "\\begin{document}\n" +
      "Hello world!\n" +
      "\\begin{equation}\n" +
      "E = mc^2\n" +
      "\\end{equation}\n" +
      "\\end{document}\n";
    fs.writeFileSync(texFile, originalTex, "utf8");

    // Invalid edit: mismatched environment (close equation with document)
    let threw = false;
    try {
      await fsService.editFile({
        path: texFile,
        target_content: "\\end{equation}",
        replacement_content: "\\end{figure}",
      });
    } catch (err) {
      threw = true;
      ok(err instanceof SyntaxValidationError || err.name === "SyntaxValidationError", "Throws SyntaxValidationError on mismatched LaTeX environment");
      ok(/Mismatched LaTeX environment/.test(err.message), "Error message identifies mismatched environment");
    }
    ok(threw, "editFile rejected mismatched LaTeX environment");

    let afterBroken = fs.readFileSync(texFile, "utf8");
    ok(afterBroken === originalTex, "On-disk LaTeX file remained 100% pristine after mismatched environment rejection");

    // Invalid edit: unclosed brace
    threw = false;
    try {
      await fsService.editFile({
        path: texFile,
        target_content: "Hello world!",
        replacement_content: "Hello \\textbf{world!",
      });
    } catch (err) {
      threw = true;
      ok(err instanceof SyntaxValidationError || err.name === "SyntaxValidationError", "Throws SyntaxValidationError on unclosed brace");
      ok(/Unclosed brace/.test(err.message), "Error message identifies unclosed brace");
    }
    ok(threw, "editFile rejected unclosed brace in LaTeX");

    afterBroken = fs.readFileSync(texFile, "utf8");
    ok(afterBroken === originalTex, "On-disk LaTeX file remained 100% pristine after unclosed brace rejection");

    // Valid edit
    const validRes = await fsService.editFile({
      path: texFile,
      target_content: "Hello world!",
      replacement_content: "Hello \\textbf{world}!",
    });
    ok(validRes.success === true, "Valid LaTeX edit succeeds");
    ok(validRes.syntax_verified === true, "LaTeX edit reports syntax_verified: true");
    const afterValid = fs.readFileSync(texFile, "utf8");
    ok(afterValid.includes("\\textbf{world}!"), "On-disk LaTeX file successfully updated");
  }

  // -------------------------------------------------------------------------
  // 7. BibTeX Syntax Gate & Pristine Rollback (.bib)
  // -------------------------------------------------------------------------
  console.log("\n[Test 7] BibTeX In-Memory Syntax Gate");
  {
    const bibFile = path.join(TEST_DIR, "refs.bib");
    const originalBib =
      "@article{vaswani2017,\n" +
      "  author = {Vaswani, Ashish},\n" +
      "  title = {Attention Is All You Need},\n" +
      "  year = {2017}\n" +
      "}\n";
    fs.writeFileSync(bibFile, originalBib, "utf8");

    // Invalid edit: missing citation key
    let threw = false;
    try {
      await fsService.editFile({
        path: bibFile,
        target_content: "@article{vaswani2017,",
        replacement_content: "@article{,",
      });
    } catch (err) {
      threw = true;
      ok(err instanceof SyntaxValidationError || err.name === "SyntaxValidationError", "Throws SyntaxValidationError on missing citation key");
    }
    ok(threw, "editFile rejected missing citation key in BibTeX");

    let afterBroken = fs.readFileSync(bibFile, "utf8");
    ok(afterBroken === originalBib, "On-disk BibTeX file remained 100% pristine after missing key rejection");

    // Invalid edit: unclosed entry brace
    threw = false;
    try {
      await fsService.editFile({
        path: bibFile,
        target_content: "  year = {2017}\n}\n",
        replacement_content: "  year = {2017}\n",
      });
    } catch (err) {
      threw = true;
      ok(err instanceof SyntaxValidationError || err.name === "SyntaxValidationError", "Throws SyntaxValidationError on unclosed entry");
    }
    ok(threw, "editFile rejected unclosed BibTeX entry");

    afterBroken = fs.readFileSync(bibFile, "utf8");
    ok(afterBroken === originalBib, "On-disk BibTeX file remained 100% pristine after unclosed entry rejection");

    // Valid edit
    const validRes = await fsService.editFile({
      path: bibFile,
      target_content: "Vaswani, Ashish",
      replacement_content: "Vaswani, Ashish and Shazeer, Noam",
    });
    ok(validRes.success === true, "Valid BibTeX edit succeeds");
    ok(validRes.syntax_verified === true, "BibTeX edit reports syntax_verified: true");
    const afterValid = fs.readFileSync(bibFile, "utf8");
    ok(afterValid.includes("Shazeer, Noam"), "On-disk BibTeX file successfully updated");
  }

  // -------------------------------------------------------------------------
  // 8. Plaintext / Markdown Passthrough (Honest degradation, no false positives)
  // -------------------------------------------------------------------------
  console.log("\n[Test 8] Plaintext Passthrough");
  {
    const mdFile = path.join(TEST_DIR, "README.md");
    const originalMd = "# Title\n\nSome unclosed { brace is fine in markdown.\n";
    fs.writeFileSync(mdFile, originalMd, "utf8");

    const res = await fsService.editFile({
      path: mdFile,
      target_content: "Some unclosed { brace is fine in markdown.",
      replacement_content: "Some { other { unbalanced braces are also fine.",
    });

    ok(res.success === true, "Markdown edit succeeds without false rejection");
    ok(res.syntax_verified === false, "Markdown reports syntax_verified: false (no checker registered)");
    const after = fs.readFileSync(mdFile, "utf8");
    ok(after.includes("unbalanced braces"), "Markdown file successfully written to disk");
  }

  // Cleanup
  fs.rmSync(TEST_DIR, { recursive: true, force: true });

  console.log("\n==========================================");
  console.log(`M2 Syntax Gates Tests: ${passed} PASSED, ${failed} FAILED`);
  console.log("==========================================");

  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error("Unhandled error in test runner:", err);
  process.exit(1);
});
