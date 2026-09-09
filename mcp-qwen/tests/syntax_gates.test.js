/**
 * P6 — Universal Syntax Gates Regression Suite
 *
 * Proves that AstService.validateSyntax covers EVERY language the AST engine
 * can rewrite, with HONEST DEGRADATION when a checker is unavailable:
 *
 *   - ts/tsx/mts/cts  -> typescript.transpileModule (Error diagnostic => invalid)
 *   - js/jsx/mjs/cjs  -> node --check on a temp file whose extension matches
 *                        the module system (ESM nuance: valid ESM must pass,
 *                        broken ESM/CJS must be rejected)
 *   - json            -> in-process JSON.parse
 *   - python          -> python -c "import ast; ast.parse(...)"
 *   - go              -> gofmt -e (probed once; degrades honestly if absent)
 *   - rust            -> rustfmt --check (probed once; degrades honestly if absent)
 *
 * Core invariants asserted:
 *   1. A valid file of a checked language is accepted (checked:true, valid:true).
 *   2. A syntax-broken file of a checked language is REJECTED and the on-disk
 *      file is restored byte-identical (pristine rollback).
 *   3. When a checker is unavailable (forced via the setSyntaxProbeOverride
 *      seam, or genuinely absent), the gate returns checked:false and the
 *      ast_replace tool result states the rewrite was NOT syntax-verified —
 *      it is NEVER reported as "valid".
 *   4. Unknown languages (c, cpp, html, css, ...) degrade honestly.
 *
 * The suite is offline where possible: it only shells out to node/python and
 * (when present) gofmt/rustfmt. go/rust vectors are skip-guarded when the
 * binary is genuinely absent AND cannot be forced through the seam.
 *
 * NOTE on the ast-grep CLI: the CLI search/replace path (used for json/python/
 * go/rust) has a pre-existing Windows file-read race where a freshly-written
 * file is occasionally reported as "no matches" (exit 1 / empty stderr). That
 * is a P5 CLI behavior, NOT a syntax-gate defect. The full-replace flow helper
 * below retries a bounded number of times on that specific benign "not found"
 * outcome so the gate's own behavior (the thing under test) is exercised
 * deterministically.
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { AstService, setSyntaxProbeOverride } from "../src/harness/services/ast_service.js";
import { IS_WINDOWS } from "../src/config.js";

const TEST_DIR = path.resolve(process.cwd(), ".syntax_gates_tmp");

let passed = 0;
let failed = 0;
let skipped = 0;

function ok(cond, name) {
  if (cond) {
    console.log(`  [PASS] ${name}`);
    passed++;
  } else {
    console.error(`  [FAIL] ${name}`);
    failed++;
  }
}

function skip(name, reason) {
  console.log(`  [SKIP] ${name} (${reason})`);
  skipped++;
}

/** True when the named binary is present and runs successfully. */
function binaryAvailable(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: "ignore", timeout: 5000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function pythonBin() {
  return IS_WINDOWS ? "python" : "python3";
}

/**
 * Runs ast.replace and returns { threw, error, result, after } where `after`
 * is the on-disk content following the call.
 *
 * `orig` (when provided) is re-written before each attempt so the helper can
 * retry a bounded number of times on the benign ast-grep CLI "not found"
 * outcome (a pre-existing Windows file-read race, not a gate defect). A real
 * SyntaxValidationError is returned immediately (never retried).
 */
async function runReplace(ast, file, pattern, rewrite, lang, orig, maxAttempts = 4) {
  let last = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (orig !== undefined) fs.writeFileSync(file, orig, "utf8");
    let threw = false;
    let error = null;
    let result = null;
    try {
      result = await ast.replace({ path: file, pattern, rewrite, lang });
    } catch (e) {
      threw = true;
      error = e;
    }
    let after = "";
    try {
      after = fs.readFileSync(file, "utf8");
    } catch {
      after = null;
    }
    last = { threw, error, result, after };
    // A real rejection (SyntaxValidationError) is the outcome under test — stop.
    if (threw && /SyntaxValidationError/.test(error.message)) return last;
    // A benign "not found" (CLI file-read race) -> retry with a fresh write.
    if (!threw && result && result.modified === false && /not found/i.test(result.message)) {
      continue;
    }
    // Any other outcome (success, or a non-syntax error) is final.
    return last;
  }
  return last;
}

async function runTests() {
  console.log("=== P6 Universal Syntax Gates Tests ===\n");

  fs.mkdirSync(TEST_DIR, { recursive: true });
  const ast = new AstService({ root: process.cwd() });

  // Track every override we set so we can guarantee cleanup.
  const overridesSet = new Set();
  const setOverride = (name, val) => {
    setSyntaxProbeOverride(name, val);
    overridesSet.add(name);
  };
  const clearOverrides = () => {
    for (const name of overridesSet) setSyntaxProbeOverride(name, undefined);
    overridesSet.clear();
  };

  try {
    // -------------------------------------------------------------------------
    // Test 1: TypeScript gate (transpileModule)
    // -------------------------------------------------------------------------
    console.log("[Test 1] TypeScript gate (transpileModule)");
    {
      const file = path.join(TEST_DIR, "ts_valid.ts");
      const valid = "function add(a: number, b: number): number {\n  return a + b;\n}\n";
      fs.writeFileSync(file, valid, "utf8");
      const r = ast.validateSyntax(file, valid, "ts");
      ok(r.checked === true && r.valid === true, "valid TS accepted (checked+valid)");

      // A syntax error that transpileModule reports as an Error diagnostic.
      const broken = "function add(a: number, b: number): number {\n  return a + ;\n}\n";
      const rb = ast.validateSyntax(file, broken, "ts");
      ok(
        rb.checked === true && rb.valid === false && typeof rb.error === "string" && rb.error.length > 0,
        "broken TS rejected with an error message"
      );

      // Full replace flow: broken rewrite -> SyntaxValidationError + pristine rollback.
      const file2 = path.join(TEST_DIR, "ts_replace.ts");
      const orig = "function add(a: number, b: number): number {\n  return a + b;\n}\n";
      const res = await runReplace(
        ast,
        file2,
        "function add($A: number, $B: number): number { return $A + $B; }",
        "function add($A: number, $B: number): number { return $A + ; }",
        "ts",
        orig
      );
      ok(res.threw && /SyntaxValidationError/.test(res.error.message), "broken TS rewrite throws SyntaxValidationError");
      ok(res.after === orig, "TS file restored byte-identical after rollback");
    }

    // -------------------------------------------------------------------------
    // Test 2: JavaScript gate — ESM + CJS (the module-system nuance)
    // -------------------------------------------------------------------------
    console.log("\n[Test 2] JavaScript gate (ESM + CJS)");
    {
      // Valid ESM must PASS (the nuance: a bare .js with import/export).
      const esmValid = "import fs from \"node:fs\";\nexport const x = 1;\n";
      const rEsm = ast.validateSyntax(path.join(TEST_DIR, "e.js"), esmValid, "js");
      ok(rEsm.checked === true && rEsm.valid === true, "valid ESM (.js) accepted");

      // Valid CJS must PASS.
      const cjsValid = "const fs = require(\"node:fs\");\nmodule.exports = { x: 1 };\n";
      const rCjs = ast.validateSyntax(path.join(TEST_DIR, "c.js"), cjsValid, "js");
      ok(rCjs.checked === true && rCjs.valid === true, "valid CJS (.js) accepted");

      // Broken ESM must be REJECTED (the case a naive `node --check` on a .js
      // file would silently pass).
      const esmBroken = "import { from \"node:fs\";\n";
      const rEsmB = ast.validateSyntax(path.join(TEST_DIR, "e.js"), esmBroken, "js");
      ok(rEsmB.checked === true && rEsmB.valid === false, "broken ESM (.js) rejected");

      // Broken CJS must be REJECTED.
      const cjsBroken = "const x = ;\n";
      const rCjsB = ast.validateSyntax(path.join(TEST_DIR, "c.js"), cjsBroken, "js");
      ok(rCjsB.checked === true && rCjsB.valid === false, "broken CJS (.js) rejected");

      // Full replace flow on an ESM file: broken rewrite -> rollback.
      const file = path.join(TEST_DIR, "esm_replace.mjs");
      const orig = "import fs from \"node:fs\";\nexport function add(a, b) {\n  return a + b;\n}\n";
      const res = await runReplace(
        ast,
        file,
        "function add($A, $B) { return $A + $B; }",
        "function add($A, $B) { return $A + ; }",
        "js",
        orig
      );
      ok(res.threw && /SyntaxValidationError/.test(res.error.message), "broken ESM rewrite throws SyntaxValidationError");
      ok(res.after === orig, "ESM file restored byte-identical after rollback");
    }

    // -------------------------------------------------------------------------
    // Test 3: JSON gate (in-process JSON.parse)
    // -------------------------------------------------------------------------
    console.log("\n[Test 3] JSON gate (JSON.parse)");
    {
      const valid = "{\n  \"a\": 1,\n  \"b\": 2\n}\n";
      const rValid = ast.validateSyntax(path.join(TEST_DIR, "j.json"), valid, "json");
      ok(rValid.checked === true && rValid.valid === true, "valid JSON accepted");

      const broken = "{\n  \"a\": 1,\n  \"b\": 2,\n}\n"; // trailing comma
      const rBroken = ast.validateSyntax(path.join(TEST_DIR, "j.json"), broken, "json");
      ok(rBroken.checked === true && rBroken.valid === false, "broken JSON (trailing comma) rejected");

      // Full replace flow: valid rewrite commits + verified; broken rewrite rolls back.
      const file = path.join(TEST_DIR, "json_replace.json");
      const orig = "{\n  \"a\": 1,\n  \"b\": 2\n}\n";
      const okRes = await runReplace(ast, file, "1", "99", "json", orig);
      ok(
        !okRes.threw && okRes.result && okRes.result.modified === true && okRes.result.syntax_verified === true,
        "valid JSON rewrite committed and syntax_verified=true"
      );

      const badRes = await runReplace(ast, file, "1", "1,", "json", orig);
      ok(badRes.threw && /SyntaxValidationError/.test(badRes.error.message), "broken JSON rewrite throws SyntaxValidationError");
      ok(badRes.after === orig, "JSON file restored byte-identical after rollback");
    }

    // -------------------------------------------------------------------------
    // Test 4: Python gate (python -c "import ast; ast.parse(...)")
    // -------------------------------------------------------------------------
    console.log("\n[Test 4] Python gate (ast.parse)");
    {
      const pyAvail = binaryAvailable(pythonBin(), ["--version"]);
      if (!pyAvail) {
        skip("python gate", "python interpreter unavailable in this environment");
      } else {
        const valid = "def add(a, b):\n    return a + b\n";
        const rValid = ast.validateSyntax(path.join(TEST_DIR, "p.py"), valid, "python");
        ok(rValid.checked === true && rValid.valid === true, "valid Python accepted");

        const broken = "def add(a, b):\n    return a +\n";
        const rBroken = ast.validateSyntax(path.join(TEST_DIR, "p.py"), broken, "python");
        ok(rBroken.checked === true && rBroken.valid === false, "broken Python rejected");

        // Full replace flow: broken rewrite -> rollback.
        const file = path.join(TEST_DIR, "py_replace.py");
        const orig = "def add(a, b):\n    return a + b\n";
        const res = await runReplace(
          ast,
          file,
          "def add($A, $B): return $A + $B",
          "def add($A, $B): return $A + ;",
          "python",
          orig
        );
        ok(res.threw && /SyntaxValidationError/.test(res.error.message), "broken Python rewrite throws SyntaxValidationError");
        ok(res.after === orig, "Python file restored byte-identical after rollback");
      }
    }

    // -------------------------------------------------------------------------
    // Test 5: Go gate (gofmt -e) — availability-aware
    // -------------------------------------------------------------------------
    console.log("\n[Test 5] Go gate (gofmt -e)");
    {
      const valid = "package main\n\nfunc main() {\n\tprintln(\"hi\")\n}\n";
      const rValid = ast.validateSyntax(path.join(TEST_DIR, "g.go"), valid, "go");
      if (rValid.checked) {
        ok(rValid.valid === true, "valid Go accepted (gofmt present)");

        const broken = "package main\n\nfunc main( {\n\tprintln(\"hi\")\n}\n";
        const rBroken = ast.validateSyntax(path.join(TEST_DIR, "g.go"), broken, "go");
        ok(rBroken.checked === true && rBroken.valid === false, "broken Go rejected (gofmt present)");
      } else {
        // Genuinely absent -> honest degradation (checked:false, never "valid").
        ok(rValid.valid === false && /gofmt/.test(rValid.reason), "absent gofmt degrades honestly (checked:false)");
        skip("go broken-rejection", "gofmt absent; honest-degradation path asserted instead");
      }
    }

    // -------------------------------------------------------------------------
    // Test 6: Rust gate (rustfmt --check) — availability-aware
    // -------------------------------------------------------------------------
    console.log("\n[Test 6] Rust gate (rustfmt --check)");
    {
      const valid = "fn main() {\n    println!(\"hi\");\n}\n";
      const rValid = ast.validateSyntax(path.join(TEST_DIR, "r.rs"), valid, "rust");
      if (rValid.checked) {
        ok(rValid.valid === true, "valid Rust accepted (rustfmt present)");

        const broken = "fn main( {\n    println!(\"hi\");\n}\n";
        const rBroken = ast.validateSyntax(path.join(TEST_DIR, "r.rs"), broken, "rust");
        ok(rBroken.checked === true && rBroken.valid === false, "broken Rust rejected (rustfmt present)");
      } else {
        ok(rValid.valid === false && /rustfmt/.test(rValid.reason), "absent rustfmt degrades honestly (checked:false)");
        skip("rust broken-rejection", "rustfmt absent; honest-degradation path asserted instead");
      }
    }

    // -------------------------------------------------------------------------
    // Test 7: Honest degradation via the dependency-injection seam.
    // Force a checker "unavailable" and assert the gate reports checked:false
    // and the ast_replace tool result states NOT-verified — never "valid".
    // -------------------------------------------------------------------------
    console.log("\n[Test 7] Honest degradation (forced-unavailable via seam)");
    {
      // Python forced unavailable (python is present here, so this is a real
      // override of an otherwise-available checker).
      setOverride("python", false);
      const pyValid = "def add(a, b):\n    return a + b\n";
      const rPy = ast.validateSyntax(path.join(TEST_DIR, "p.py"), pyValid, "python");
      ok(rPy.checked === false && rPy.valid === false, "forced-unavailable python -> checked:false (never 'valid')");

      // Full replace flow: the rewrite is committed but the result must state
      // it was NOT syntax-verified.
      const file = path.join(TEST_DIR, "py_unverified.py");
      const orig = "def add(a, b):\n    return a + b\n";
      const res = await runReplace(
        ast,
        file,
        "def add($A, $B): return $A + $B",
        "def add($A, $B): return $A + $B + 0",
        "python",
        orig
      );
      ok(!res.threw && res.result && res.result.modified === true, "forced-unavailable python rewrite still commits (no false rejection)");
      ok(res.result && res.result.syntax_verified === false, "tool result reports syntax_verified=false");
      ok(res.result && /NOT verified/i.test(res.result.message), "tool result message states NOT syntax-verified");
      ok(res.result && !/Syntax validated/i.test(res.result.message), "tool result does NOT claim 'Syntax validated'");

      // TypeScript forced unavailable.
      setOverride("typescript", false);
      const tsValid = "function add(a: number, b: number): number {\n  return a + b;\n}\n";
      const rTs = ast.validateSyntax(path.join(TEST_DIR, "t.ts"), tsValid, "ts");
      ok(rTs.checked === false && rTs.valid === false, "forced-unavailable typescript -> checked:false (never 'valid')");

      clearOverrides();
    }

    // -------------------------------------------------------------------------
    // Test 8: Unknown languages degrade honestly (no registered checker).
    // -------------------------------------------------------------------------
    console.log("\n[Test 8] Unknown-language honest degradation");
    {
      for (const lang of ["cpp", "c", "html", "css"]) {
        const r = ast.validateSyntax(path.join(TEST_DIR, "x." + lang), "int x;\n", lang);
        ok(r.checked === false && r.valid === false && /no syntax checker/.test(r.reason),
          `${lang} degrades honestly (checked:false, no checker)`);
      }
    }

    // -------------------------------------------------------------------------
    // Test 9: Pristine rollback on EVERY rejection vector (byte-identical).
    // -------------------------------------------------------------------------
    console.log("\n[Test 9] Pristine rollback on every rejection vector");
    {
      const vectors = [
        {
          lang: "js",
          ext: "js",
          orig: "function add(a, b) {\n  return a + b;\n}\n",
          pattern: "function add($A, $B) { return $A + $B; }",
          rewrite: "function add($A, $B) { return $A + ; }",
        },
        {
          lang: "ts",
          ext: "ts",
          orig: "function add(a: number, b: number): number {\n  return a + b;\n}\n",
          pattern: "function add($A: number, $B: number): number { return $A + $B; }",
          rewrite: "function add($A: number, $B: number): number { return $A + ; }",
        },
        {
          lang: "json",
          ext: "json",
          orig: "{\n  \"a\": 1,\n  \"b\": 2\n}\n",
          pattern: "1",
          rewrite: "1,",
        },
      ];
      for (const v of vectors) {
        const file = path.join(TEST_DIR, `rollback.${v.ext}`);
        const res = await runReplace(ast, file, v.pattern, v.rewrite, v.lang, v.orig);
        ok(res.threw && /SyntaxValidationError/.test(res.error.message), `${v.lang}: broken rewrite rejected`);
        ok(res.after === v.orig, `${v.lang}: file byte-identical after rollback`);
      }
    }
  } finally {
    clearOverrides();
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {}
  }

  console.log("\n==========================================");
  console.log(`Syntax Gates Tests: ${passed} PASSED, ${failed} FAILED, ${skipped} SKIPPED`);
  console.log("==========================================");
  if (failed > 0) process.exit(1);
}

runTests().catch((err) => {
  console.error("Syntax gates test suite uncaught error:", err);
  process.exit(1);
});
