/**
 * P4f edit_file Ambiguity-Guard Test Suite
 *
 * Validates the production-corruption guard in SandboxFsService.editFile:
 * 1. Single-occurrence edit applies and writes correctly.
 * 2. 0-occurrence edit -> explicit "not found" error, file bytes unchanged.
 * 3. 2-occurrence target without replace_all -> refusal naming count=2, file unchanged.
 * 4. Same target with replace_all:true -> both occurrences replaced.
 * 5. CRLF file with LF-only target -> line-ending mismatch error, file unchanged.
 * 6. Unique multi-line target spanning lines still works.
 *
 * Fully offline: uses a temp directory under the workspace, no network.
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { SandboxFsService } from "../src/harness/services/sandbox_fs.js";

// Use the canonical (real) workspace root to avoid junction/symlink
// resolution mismatches (e.g. D:\mnt\d -> D:\ on Windows).
const CANONICAL_CWD = fs.realpathSync(process.cwd());
const TEST_DIR = path.join(CANONICAL_CWD, ".edit_file_guard_tmp");

function makeService() {
  return new SandboxFsService({ root: TEST_DIR });
}

async function expectError(promise, name, substrings) {
  let err = null;
  try {
    await promise;
  } catch (e) {
    err = e;
  }
  assert.ok(err, `${name}: expected an error but call succeeded`);
  for (const s of substrings) {
    assert.ok(
      err.message.includes(s),
      `${name}: error message should include ${JSON.stringify(s)} but was: ${err.message}`
    );
  }
  return err;
}

async function runTests() {
  console.log("=== P4f edit_file Ambiguity-Guard Tests ===\n");
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

  fs.mkdirSync(TEST_DIR, { recursive: true });

  // -------------------------------------------------------------------------
  // Test 1: single-occurrence edit applies and writes correctly
  // -------------------------------------------------------------------------
  console.log("[Test 1] Single-occurrence edit");
  {
    const svc = makeService();
    const file = path.join(TEST_DIR, "single.txt");
    const original = "alpha\nbeta\ngamma\n";
    fs.writeFileSync(file, original, "utf8");

    const res = await svc.editFile({
      path: "single.txt",
      target_content: "beta",
      replacement_content: "BETA",
    });
    const after = fs.readFileSync(file, "utf8");
    ok(res.success === true, "returns success");
    ok(res.occurrences_replaced === 1, "reports 1 occurrence replaced");
    ok(after === "alpha\nBETA\ngamma\n", "file content correctly updated");
  }

  // -------------------------------------------------------------------------
  // Test 2: 0-occurrence edit -> explicit error, file bytes unchanged
  // -------------------------------------------------------------------------
  console.log("\n[Test 2] Zero-occurrence edit");
  {
    const svc = makeService();
    const file = path.join(TEST_DIR, "zero.txt");
    const original = "one\ntwo\nthree\n";
    fs.writeFileSync(file, original, "utf8");

    const err = await expectError(
      svc.editFile({
        path: "zero.txt",
        target_content: "does-not-exist",
        replacement_content: "x",
      }),
      "zero-occurrence",
      ["not found"]
    );
    const after = fs.readFileSync(file, "utf8");
    ok(err.message.includes("No write performed"), "error states no write performed");
    ok(after === original, "file bytes unchanged");
  }

  // -------------------------------------------------------------------------
  // Test 3: 2-occurrence target without replace_all -> refusal naming count=2
  // -------------------------------------------------------------------------
  console.log("\n[Test 3] Ambiguous (2x) target without replace_all");
  {
    const svc = makeService();
    const file = path.join(TEST_DIR, "ambiguous.txt");
    const original = "foo bar\nbaz\nfoo bar\nqux\n";
    fs.writeFileSync(file, original, "utf8");

    const err = await expectError(
      svc.editFile({
        path: "ambiguous.txt",
        target_content: "foo bar",
        replacement_content: "FOO",
      }),
      "ambiguous-2x",
      ["2", "replace_all"]
    );
    ok(err.message.includes("AmbiguousTargetError"), "error is named AmbiguousTargetError");
    const after = fs.readFileSync(file, "utf8");
    ok(after === original, "file unchanged after refusal");
  }

  // -------------------------------------------------------------------------
  // Test 4: same target with replace_all:true -> both occurrences replaced
  // -------------------------------------------------------------------------
  console.log("\n[Test 4] 2-occurrence target with replace_all:true");
  {
    const svc = makeService();
    const file = path.join(TEST_DIR, "replace_all.txt");
    const original = "foo bar\nbaz\nfoo bar\nqux\n";
    fs.writeFileSync(file, original, "utf8");

    const res = await svc.editFile({
      path: "replace_all.txt",
      target_content: "foo bar",
      replacement_content: "FOO",
      replace_all: true,
    });
    const after = fs.readFileSync(file, "utf8");
    ok(res.success === true, "returns success");
    ok(res.occurrences_replaced === 2, "reports 2 occurrences replaced");
    ok(after === "FOO\nbaz\nFOO\nqux\n", "both occurrences replaced");
  }

  // -------------------------------------------------------------------------
  // Test 5: CRLF file with LF-only target -> auto-normalizes & preserves CRLF
  // -------------------------------------------------------------------------
  console.log("\n[Test 5] CRLF file with LF-only target");
  {
    const svc = makeService();
    const file = path.join(TEST_DIR, "crlf.txt");
    const original = "line one\r\nline two\r\nline three\r\n";
    fs.writeFileSync(file, original, "utf8");

    // Target uses LF only; the file uses CRLF. Auto-normalization matches,
    // applies replacement, and preserves CRLF line endings on disk without error.
    const res = await svc.editFile({
      path: "crlf.txt",
      target_content: "line one\nline two",
      replacement_content: "line ONE\nline TWO",
    });
    ok(res.success === true, "returns success");
    ok(res.occurrences_replaced === 1, "reports 1 occurrence replaced");
    const after = fs.readFileSync(file, "utf8");
    ok(after === "line ONE\r\nline TWO\r\nline three\r\n", "content updated and CRLF preserved");
    ok(after.includes("\r\n"), "file still uses CRLF");
  }

  // -------------------------------------------------------------------------
  // Test 6: unique multi-line target spanning lines still works
  // -------------------------------------------------------------------------
  console.log("\n[Test 6] Unique multi-line target");
  {
    const svc = makeService();
    const file = path.join(TEST_DIR, "multiline.txt");
    const original = "function a() {\n  return 1;\n}\n\nfunction b() {\n  return 2;\n}\n";
    fs.writeFileSync(file, original, "utf8");

    const res = await svc.editFile({
      path: "multiline.txt",
      target_content: "function b() {\n  return 2;\n}",
      replacement_content: "function b() {\n  return 200;\n}",
    });
    const after = fs.readFileSync(file, "utf8");
    ok(res.success === true, "returns success");
    ok(after === "function a() {\n  return 1;\n}\n\nfunction b() {\n  return 200;\n}\n", "multi-line target replaced exactly once");
  }

  // -------------------------------------------------------------------------
  // Test 7: LF file with CRLF target -> auto-normalizes & preserves LF
  // -------------------------------------------------------------------------
  console.log("\n[Test 7] LF file with CRLF target");
  {
    const svc = makeService();
    const file = path.join(TEST_DIR, "lf.txt");
    const original = "alpha\nbeta\ngamma\n";
    fs.writeFileSync(file, original, "utf8");

    const res = await svc.editFile({
      path: "lf.txt",
      target_content: "alpha\r\nbeta",
      replacement_content: "ALPHA\r\nBETA",
    });
    ok(res.success === true, "returns success");
    ok(res.occurrences_replaced === 1, "reports 1 occurrence replaced");
    const after = fs.readFileSync(file, "utf8");
    ok(after === "ALPHA\nBETA\ngamma\n", "content updated and LF preserved");
    ok(!after.includes("\r\n"), "file still uses LF without CRLF pollution");
  }

  // -------------------------------------------------------------------------
  // Cleanup & summary
  // -------------------------------------------------------------------------
  fs.rmSync(TEST_DIR, { recursive: true, force: true });

  console.log("\n==========================================");
  console.log(`edit_file Guard Tests: ${passed} PASSED, ${failed} FAILED`);
  console.log("==========================================");
  if (failed > 0) process.exit(1);
}

runTests().catch((err) => {
  console.error("edit_file guard test suite uncaught error:", err);
  process.exit(1);
});
