/**
 * P7 AST Batch-Replace Test Suite
 *
 * Validates the replaceBatch surface (directory / glob target) and its
 * dry_run preview, all OFFLINE (fixtures under a temp dir; the napi engine
 * is in-process, the CLI is a local node_modules binary):
 *
 *  1. dry_run no-mutation: a dry_run batch leaves every file byte-identical.
 *  2. real run summary numbers: files_scanned / files_matched / files_changed /
 *     replacements are exact; failures and syntax_unverified are empty.
 *  3. per-file syntax-gate rollback: one file whose rewrite is verified invalid
 *     is rolled back to pristine while a sibling file is changed; failures[] is
 *     populated and the batch does not abort.
 *  4. ignored-dirs skipped: files under an ignored directory (node_modules)
 *     are never scanned or modified.
 *
 * The rewrite used in test 3 is deliberately context-sensitive: the SAME
 * pattern/rewrite is valid when applied to a body that has no `return` but
 * produces a syntax error when applied to a body that already returns, so the
 * per-file gate can be exercised with a single batch call.
 */

import fs from "node:fs";
import path from "node:path";
import { AstService } from "../src/harness/services/ast_service.js";
import { IS_WINDOWS } from "../src/config.js";

const TEST_DIR = path.resolve(process.cwd(), ".ast_batch_tmp");

// ---------------------------------------------------------------------------
// Offline-skip detection (mirrors ast_engine.test.js)
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
// Body has NO return -> the rewrite "function $NAME($$$ARGS) { return $$$BODY; }"
// produces valid code.
const NORETURN_FILE = `function add(a, b) {
  a + b
}
`;

// Body already returns -> the SAME rewrite produces "return return a + b;;"
// which is a syntax error -> the per-file gate must roll this file back.
const WITHRETURN_FILE = `function add(a, b) {
  return a + b;
}
`;

// Two no-return functions (for the summary-numbers test).
const TWO_NORETURN_FILE = `function one() {
  1
}
function two() {
  2
}
`;

const PATTERN = "function $NAME($$$ARGS) { $$$BODY }";
const REWRITE = "function $NAME($$$ARGS) { return $$$BODY; }";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function readBuf(p) {
  return fs.readFileSync(p);
}

function writeFixture(rel, content) {
  const full = path.join(TEST_DIR, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf8");
  return full;
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------
async function runTests() {
  console.log("=== P7 AST Batch-Replace Tests ===\n");
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
  const anyEngine = napi !== null || cli !== null;
  console.log(`  napi: ${napi ? "available" : "unavailable"}`);
  console.log(`  CLI:  ${cli ? "available" : "unavailable"}\n`);

  if (!anyEngine) {
    console.log("  No AST engine available; skipping all batch tests.\n");
    console.log(`AST Batch Tests: ${passed} PASSED, ${failed} FAILED, ${skipped + 5} SKIPPED`);
    return;
  }

  fs.mkdirSync(TEST_DIR, { recursive: true });
  const ast = new AstService({ root: process.cwd() });

  // -------------------------------------------------------------------------
  // Test 1: dry_run no-mutation (byte-identical)
  // -------------------------------------------------------------------------
  console.log("[Test 1] dry_run batch leaves every file byte-identical");
  {
    const dir = path.join(TEST_DIR, "dry");
    const f1 = writeFixture(path.join("dry", "a.js"), NORETURN_FILE);
    const f2 = writeFixture(path.join("dry", "b.js"), TWO_NORETURN_FILE);
    const snap1 = readBuf(f1);
    const snap2 = readBuf(f2);

    const res = await ast.replaceBatch({ path: dir, pattern: PATTERN, rewrite: REWRITE, dry_run: true });

    assertOk(res.dry_run === true, "summary.dry_run is true");
    assertOk(res.files_scanned === 2, `files_scanned === 2 (got ${res.files_scanned})`);
    assertOk(res.files_matched === 2, `files_matched === 2 (got ${res.files_matched})`);
    assertOk(res.files_would_change === 2, `files_would_change === 2 (got ${res.files_would_change})`);
    assertOk(res.files_changed === 0, `files_changed === 0 (got ${res.files_changed})`);
    assertOk(res.failures.length === 0, `no failures (got ${res.failures.length})`);
    assertOk(
      readBuf(f1).equals(snap1) && readBuf(f2).equals(snap2),
      "both files byte-identical after dry_run"
    );
  }

  // -------------------------------------------------------------------------
  // Test 2: real run summary numbers
  // -------------------------------------------------------------------------
  console.log("\n[Test 2] real batch run summary numbers");
  {
    const dir = path.join(TEST_DIR, "real");
    const f1 = writeFixture(path.join("real", "a.js"), TWO_NORETURN_FILE);
    const f2 = writeFixture(path.join("real", "b.js"), TWO_NORETURN_FILE);

    const res = await ast.replaceBatch({ path: dir, pattern: PATTERN, rewrite: REWRITE });

    assertOk(res.dry_run === false, "summary.dry_run is false");
    assertOk(res.files_scanned === 2, `files_scanned === 2 (got ${res.files_scanned})`);
    assertOk(res.files_matched === 2, `files_matched === 2 (got ${res.files_matched})`);
    assertOk(res.files_changed === 2, `files_changed === 2 (got ${res.files_changed})`);
    assertOk(res.replacements === 4, `replacements === 4 (got ${res.replacements})`);
    assertOk(res.files_would_change === 0, `files_would_change === 0 (got ${res.files_would_change})`);
    assertOk(res.failures.length === 0, `no failures (got ${res.failures.length})`);
    assertOk(res.syntax_unverified.length === 0, `no syntax_unverified (got ${res.syntax_unverified.length})`);
    assertOk(
      fs.readFileSync(f1, "utf8").includes("return 1;") &&
        fs.readFileSync(f2, "utf8").includes("return 2;"),
      "both files actually rewritten on disk"
    );
  }

  // -------------------------------------------------------------------------
  // Test 3: per-file syntax-gate rollback (one bad file, one good file)
  // -------------------------------------------------------------------------
  console.log("\n[Test 3] per-file syntax-gate rollback (one bad file, one good file)");
  {
    const dir = path.join(TEST_DIR, "gate");
    const good = writeFixture(path.join("gate", "good.js"), NORETURN_FILE);
    const bad = writeFixture(path.join("gate", "bad.js"), WITHRETURN_FILE);
    const snapGood = readBuf(good);
    const snapBad = readBuf(bad);

    const res = await ast.replaceBatch({ path: dir, pattern: PATTERN, rewrite: REWRITE });

    assertOk(res.files_scanned === 2, `files_scanned === 2 (got ${res.files_scanned})`);
    assertOk(res.files_matched === 2, `files_matched === 2 (got ${res.files_matched})`);
    assertOk(res.files_changed === 1, `files_changed === 1 (got ${res.files_changed})`);
    assertOk(res.failures.length === 1, `failures.length === 1 (got ${res.failures.length})`);
    assertOk(
      res.failures.some((f) => f.file === bad && /Syntax|malformed|invalid/i.test(f.error)),
      "failures[] contains the bad file with a syntax error"
    );
    assertOk(
      readBuf(bad).equals(snapBad),
      "bad file rolled back to pristine (byte-identical)"
    );
    assertOk(
      !readBuf(good).equals(snapGood),
      "good file was changed (batch did not abort)"
    );
    assertOk(
      fs.readFileSync(good, "utf8").includes("return a + b;"),
      "good file contains the valid rewrite"
    );
  }

  // -------------------------------------------------------------------------
  // Test 4: ignored-dirs skipped
  // -------------------------------------------------------------------------
  console.log("\n[Test 4] ignored directories are skipped");
  {
    const dir = path.join(TEST_DIR, "ignored");
    const a = writeFixture(path.join("ignored", "a.js"), NORETURN_FILE);
    const c = writeFixture(path.join("ignored", "node_modules", "pkg", "c.js"), NORETURN_FILE);
    const snapC = readBuf(c);

    const res = await ast.replaceBatch({ path: dir, pattern: PATTERN, rewrite: REWRITE });

    assertOk(res.files_scanned === 1, `files_scanned === 1 (node_modules excluded; got ${res.files_scanned})`);
    assertOk(res.files_changed === 1, `files_changed === 1 (got ${res.files_changed})`);
    assertOk(
      readBuf(c).equals(snapC),
      "node_modules file left untouched"
    );
    assertOk(
      fs.readFileSync(a, "utf8").includes("return a + b;"),
      "top-level file was rewritten"
    );
  }

  // -------------------------------------------------------------------------
  // Test 5: single-file delegation (dry_run no-mutation + gate failure -> failures[])
  // -------------------------------------------------------------------------
  console.log("\n[Test 5] single-file delegation (dry_run no-mutation + gate failure)");
  {
    // 5a: dry_run on a single file leaves it byte-identical.
    const f = writeFixture(path.join("single", "one.js"), NORETURN_FILE);
    const snap = readBuf(f);
    const dry = await ast.replaceBatch({ path: f, pattern: PATTERN, rewrite: REWRITE, dry_run: true });
    assertOk(dry.dry_run === true, "single-file dry_run flag true");
    assertOk(dry.files_scanned === 1, `single-file files_scanned === 1 (got ${dry.files_scanned})`);
    assertOk(dry.files_would_change === 1, `single-file files_would_change === 1 (got ${dry.files_would_change})`);
    assertOk(dry.files_changed === 0, `single-file files_changed === 0 (got ${dry.files_changed})`);
    assertOk(readBuf(f).equals(snap), "single-file dry_run left file byte-identical");

    // 5b: a real single-file run whose rewrite is verified invalid is recorded
    // in failures[] (not thrown) and the file is rolled back to pristine.
    const g = writeFixture(path.join("single", "gate.js"), WITHRETURN_FILE);
    const snapG = readBuf(g);
    const bad = await ast.replaceBatch({ path: g, pattern: PATTERN, rewrite: REWRITE });
    assertOk(bad.files_scanned === 1, `single-file gate files_scanned === 1 (got ${bad.files_scanned})`);
    assertOk(bad.files_changed === 0, `single-file gate files_changed === 0 (got ${bad.files_changed})`);
    assertOk(bad.failures.length === 1, `single-file gate failures.length === 1 (got ${bad.failures.length})`);
    assertOk(
      bad.failures.some((x) => x.file === g && /Syntax|malformed|invalid/i.test(x.error)),
      "single-file gate failure recorded in failures[]"
    );
    assertOk(readBuf(g).equals(snapG), "single-file gate failure rolled back to pristine");
  }

  // -------------------------------------------------------------------------
  // Cleanup & summary
  // -------------------------------------------------------------------------
  fs.rmSync(TEST_DIR, { recursive: true, force: true });

  console.log("\n==========================================");
  console.log(`AST Batch Tests: ${passed} PASSED, ${failed} FAILED, ${skipped} SKIPPED`);
  console.log("==========================================");
  if (failed > 0) process.exit(1);
}

runTests().catch((err) => {
  console.error("AST Batch test suite uncaught error:", err);
  process.exit(1);
});
