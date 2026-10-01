/**
 * P5 AST Engine Equivalence & Directory-Search Test Suite
 *
 * Validates:
 * 1. napi-vs-CLI search equivalence (js + ts): deep-equal normalized results
 * 2. napi-vs-CLI replace equivalence: byte-identical output
 * 3. Directory search: node_modules ignored, per-file matches, global 50-cap
 * 4. Syntax-gate/rollback regression on the napi path
 *
 * Uses the offline-skip pattern: if the napi binding or the CLI binary is
 * unavailable in this environment, the equivalence vectors are skipped (not
 * failed) so the suite stays green in minimal environments.
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { AstService } from "../src/harness/services/ast_service.js";
import { IS_WINDOWS } from "../src/config.js";

const TEST_DIR = path.resolve(process.cwd(), ".ast_engine_tmp");

// ---------------------------------------------------------------------------
// Offline-skip detection
// ---------------------------------------------------------------------------
async function detectNapi() {
  try {
    const mod = await import("@ast-grep/napi");
    const engine = mod && mod.default ? mod.default : mod;
    return engine && typeof engine.parse === "function" && typeof engine.pattern === "function"
      ? engine
      : null;
  } catch {
    return null;
  }
}

function detectCli() {
  const bin = IS_WINDOWS
    ? path.join(process.cwd(), "node_modules", "@ast-grep", "cli-win32-x64-msvc", "ast-grep.exe")
    : path.join(process.cwd(), "node_modules", "@ast-grep", "cli-linux-x64-gnu", "ast-grep");
  return fs.existsSync(bin) ? bin : null;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const JS_FIXTURE = `function add(a, b) {
  return a + b;
}

function multiply(x, y) {
  const product = x * y;
  return product;
}
`;

const TS_FIXTURE = `function greet(name: string): string {
  return "Hello, " + name;
}

function add(a: number, b: number): number {
  return a + b;
}
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function normalizeMatches(matches) {
  return matches.map((m) => ({
    file: m.file,
    line: m.line,
    column: m.column,
    text: m.text,
    // Canonicalize metavariables by sorting keys so the comparison is
    // independent of each engine's object key insertion order.
    metavariables: Object.fromEntries(
      Object.entries(m.metavariables || {}).sort(([a], [b]) => a.localeCompare(b))
    ),
  }));
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------
async function runTests() {
  console.log("=== P5 AST Engine Equivalence & Directory-Search Tests ===\n");
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  function assertOk(condition, name) {
    if (condition) {
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

  const napi = await detectNapi();
  const cli = await detectCli();
  const napiAvailable = napi !== null;
  const cliAvailable = cli !== null;
  const bothAvailable = napiAvailable && cliAvailable;

  console.log(`  napi: ${napiAvailable ? "available" : "unavailable"}`);
  console.log(`  CLI:  ${cliAvailable ? "available" : "unavailable"}\n`);

  fs.mkdirSync(TEST_DIR, { recursive: true });

  // -------------------------------------------------------------------------
  // Test 1: napi-vs-CLI search equivalence (js)
  // -------------------------------------------------------------------------
  console.log("[Test 1] napi-vs-CLI search equivalence (js)");
  {
    if (!bothAvailable) {
      skip("js search equivalence", napiAvailable ? "CLI unavailable" : "napi unavailable");
    } else {
      const file = path.join(TEST_DIR, "eq_js.js");
      fs.writeFileSync(file, JS_FIXTURE, "utf8");
      const ast = new AstService({ root: process.cwd() });

      const napiRes = await ast.search({ path: file, pattern: "function $NAME($$$ARGS) { $$$BODY }", lang: "js" });
      const cliMatches = ast.cliSearch(file, "js", "function $NAME($$$ARGS) { $$$BODY }");

      const napiNorm = normalizeMatches(napiRes.matches);
      const cliNorm = normalizeMatches(cliMatches);

      assertOk(
        napiRes.count === 2,
        `napi found 2 functions (got ${napiRes.count})`
      );
      assertOk(
        cliMatches.length === 2,
        `CLI found 2 functions (got ${cliMatches.length})`
      );
      assertOk(
        deepEqual(napiNorm, cliNorm),
        "napi and CLI produce deep-equal normalized matches"
      );
      if (!deepEqual(napiNorm, cliNorm)) {
        console.error("    napi:", JSON.stringify(napiNorm));
        console.error("    cli: ", JSON.stringify(cliNorm));
      }
    }
  }

  // -------------------------------------------------------------------------
  // Test 2: napi-vs-CLI search equivalence (ts)
  // -------------------------------------------------------------------------
  console.log("\n[Test 2] napi-vs-CLI search equivalence (ts)");
  {
    if (!bothAvailable) {
      skip("ts search equivalence", napiAvailable ? "CLI unavailable" : "napi unavailable");
    } else {
      const file = path.join(TEST_DIR, "eq_ts.ts");
      fs.writeFileSync(file, TS_FIXTURE, "utf8");
      const ast = new AstService({ root: process.cwd() });

      const napiRes = await ast.search({ path: file, pattern: "function $NAME($$$ARGS): $RET { $$$BODY }", lang: "ts" });
      const cliMatches = ast.cliSearch(file, "ts", "function $NAME($$$ARGS): $RET { $$$BODY }");

      const napiNorm = normalizeMatches(napiRes.matches);
      const cliNorm = normalizeMatches(cliMatches);

      assertOk(
        napiRes.count === 2,
        `napi found 2 ts functions (got ${napiRes.count})`
      );
      assertOk(
        cliMatches.length === 2,
        `CLI found 2 ts functions (got ${cliMatches.length})`
      );
      assertOk(
        deepEqual(napiNorm, cliNorm),
        "napi and CLI produce deep-equal normalized matches (ts)"
      );
      if (!deepEqual(napiNorm, cliNorm)) {
        console.error("    napi:", JSON.stringify(napiNorm));
        console.error("    cli: ", JSON.stringify(cliNorm));
      }
    }
  }

  // -------------------------------------------------------------------------
  // Test 3: napi-vs-CLI replace equivalence
  // -------------------------------------------------------------------------
  console.log("\n[Test 3] napi-vs-CLI replace equivalence");
  {
    if (!bothAvailable) {
      skip("replace equivalence", napiAvailable ? "CLI unavailable" : "napi unavailable");
    } else {
      const file = path.join(TEST_DIR, "eq_replace.js");
      const original = "function add(a, b) {\n  return a + b;\n}\n\nfunction mul(x, y) {\n  return x * y;\n}\n";
      const pattern = "function add($A, $B) { return $A + $B; }";
      const rewrite = "function add($A, $B) { /* optimized */ return ($A + $B) | 0; }";

      // napi path
      fs.writeFileSync(file, original, "utf8");
      const ast = new AstService({ root: process.cwd() });
      const napiRes = await ast.replace({ path: file, pattern, rewrite, lang: "js" });
      const napiOut = fs.readFileSync(file, "utf8");

      // CLI path
      fs.writeFileSync(file, original, "utf8");
      const cliRes = ast.cliReplace(file, original, "js", pattern, rewrite);
      const cliOut = fs.readFileSync(file, "utf8");

      assertOk(napiRes.modified === true, "napi replace modified the file");
      assertOk(cliRes.modified === true, "CLI replace modified the file");
      assertOk(
        napiOut === cliOut,
        "napi and CLI produce byte-identical replacement output"
      );
      if (napiOut !== cliOut) {
        console.error("    napi:", JSON.stringify(napiOut));
        console.error("    cli: ", JSON.stringify(cliOut));
      }
    }
  }

  // -------------------------------------------------------------------------
  // Test 4: Directory search (node_modules ignored, per-file matches)
  // -------------------------------------------------------------------------
  console.log("\n[Test 4] Directory search (node_modules ignored, per-file matches)");
  {
    const dir = path.join(TEST_DIR, "tree");
    fs.mkdirSync(path.join(dir, "node_modules", "pkg"), { recursive: true });
    fs.mkdirSync(path.join(dir, "sub"), { recursive: true });
    fs.writeFileSync(path.join(dir, "a.js"), "function one() { return 1; }\nfunction two() { return 2; }\n");
    fs.writeFileSync(path.join(dir, "sub", "b.js"), "function three() { return 3; }\n");
    fs.writeFileSync(path.join(dir, "node_modules", "pkg", "c.js"), "function IGNORED() { return 99; }\n");

    const ast = new AstService({ root: process.cwd() });
    const res = await ast.search({ path: dir, pattern: "function $NAME() { $$$BODY }" });

    const files = new Set(res.matches.map((m) => path.relative(dir, m.file)));
    assertOk(
      res.count === 3,
      `found 3 matches across directory (got ${res.count})`
    );
    assertOk(
      files.has("a.js"),
      "a.js matches present"
    );
    assertOk(
      files.has(path.join("sub", "b.js")),
      "sub/b.js matches present"
    );
    assertOk(
      !files.has(path.join("node_modules", "pkg", "c.js")),
      "node_modules is ignored"
    );
    assertOk(
      res.matches.every((m) => m.metavariables.NAME !== "IGNORED"),
      "no IGNORED function from node_modules"
    );
  }

  // -------------------------------------------------------------------------
  // Test 5: Directory search global 50-match cap
  // -------------------------------------------------------------------------
  console.log("\n[Test 5] Directory search global 50-match cap");
  {
    const dir = path.join(TEST_DIR, "cap");
    fs.mkdirSync(dir, { recursive: true });
    // 10 files x 6 functions = 60 total matches
    for (let i = 0; i < 10; i++) {
      let content = "";
      for (let j = 0; j < 6; j++) {
        content += `function f${i}_${j}() { return ${i * 6 + j}; }\n`;
      }
      fs.writeFileSync(path.join(dir, `file${i}.js`), content);
    }

    const ast = new AstService({ root: process.cwd() });
    const res = await ast.search({ path: dir, pattern: "function $NAME() { $$$BODY }" });

    assertOk(
      res.count === 50,
      `global cap at 50 (got ${res.count})`
    );
    assertOk(
      res.matches.length === 50,
      `matches array capped at 50 (got ${res.matches.length})`
    );
  }

  // -------------------------------------------------------------------------
  // Test 6: Syntax-gate/rollback regression (napi path)
  // -------------------------------------------------------------------------
  console.log("\n[Test 6] Syntax-gate/rollback regression (napi path)");
  {
    if (!napiAvailable) {
      skip("napi syntax-gate/rollback", "napi unavailable");
    } else {
      const file = path.join(TEST_DIR, "gate.js");
      const original = "function add(a, b) {\n  return a + b;\n}\n\nfunction mul(x, y) {\n  return x * y;\n}\n";
      fs.writeFileSync(file, original, "utf8");

      const ast = new AstService({ root: process.cwd() });
      let rejected = false;
      try {
        await ast.replace({
          path: file,
          pattern: "function mul($$$ARGS) { $$$BODY }",
          rewrite: "function mul($$$ARGS) { return x * ; }", // invalid syntax
          lang: "js",
        });
      } catch (err) {
        if (err.message.includes("SyntaxValidationError")) rejected = true;
      }

      const after = fs.readFileSync(file, "utf8");
      assertOk(rejected, "SyntaxValidationError triggered on malformed rewrite");
      assertOk(
        after === original,
        "file left pristine after rollback"
      );
    }
  }

  // -------------------------------------------------------------------------
  // Cleanup & summary
  // -------------------------------------------------------------------------
  fs.rmSync(TEST_DIR, { recursive: true, force: true });

  console.log("\n==========================================");
  console.log(`AST Engine Tests: ${passed} PASSED, ${failed} FAILED, ${skipped} SKIPPED`);
  console.log("==========================================");
  if (failed > 0) process.exit(1);
}

runTests().catch((err) => {
  console.error("AST Engine test suite uncaught error:", err);
  process.exit(1);
});
