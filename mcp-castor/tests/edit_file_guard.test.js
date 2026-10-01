/**
 * P4f edit_file Ambiguity-Guard Test Suite
 *
 * Validates the production-corruption guard in SandboxFsService.editFile:
 * 1. Single-occurrence edit applies and writes correctly.
 * 2. 0-occurrence edit -> explicit "not found" error, file bytes unchanged.
 * 3. 2-occurrence target without replace_all -> refusal naming count=2, file unchanged.
 * 4. Same target with replace_all:true -> both occurrences replaced.
 * 5. CRLF file with LF-only target -> auto-normalizes & preserves CRLF.
 * 6. Unique multi-line target spanning lines still works.
 * 7. LF file with CRLF target -> auto-normalizes & preserves LF.
 * 8. F-3: missing/undefined replacement_content -> InvalidReplacementError, no write.
 * 9. F-3: null replacement_content -> InvalidReplacementError, no write.
 * 10. F-3: non-string (number) replacement_content -> InvalidReplacementError, no write.
 * 11. F-3: explicit empty string "" replacement_content -> allowed (deletion).
 * 12. F-4: mixed-ending file, edit LF section -> LF preserved, CRLF section untouched.
 * 13. F-4: mixed-ending file, edit CRLF section -> CRLF preserved, LF section untouched.
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
  // Test 8: F-3 — missing/undefined replacement_content -> InvalidReplacementError
  // -------------------------------------------------------------------------
  console.log("\n[Test 8] F-3: missing replacement_content");
  {
    const svc = makeService();
    const file = path.join(TEST_DIR, "f3_missing.txt");
    const original = "hello world\nbye\n";
    fs.writeFileSync(file, original, "utf8");

    const err = await expectError(
      svc.editFile({
        path: "f3_missing.txt",
        target_content: "hello world",
        // replacement_content intentionally omitted (undefined)
      }),
      "f3-missing",
      ["InvalidReplacementError", "replacement_content"]
    );
    ok(err.message.includes("undefined"), "error names the offending value (undefined)");
    ok(err.message.includes("No write performed"), "error states no write performed");
    const after = fs.readFileSync(file, "utf8");
    ok(after === original, "file bytes unchanged (no 'undefined' corruption)");
    ok(!after.includes("undefined"), "literal string 'undefined' was NOT written to disk");
  }

  // -------------------------------------------------------------------------
  // Test 9: F-3 — null replacement_content -> InvalidReplacementError
  // -------------------------------------------------------------------------
  console.log("\n[Test 9] F-3: null replacement_content");
  {
    const svc = makeService();
    const file = path.join(TEST_DIR, "f3_null.txt");
    const original = "hello world\nbye\n";
    fs.writeFileSync(file, original, "utf8");

    const err = await expectError(
      svc.editFile({
        path: "f3_null.txt",
        target_content: "hello world",
        replacement_content: null,
      }),
      "f3-null",
      ["InvalidReplacementError", "replacement_content"]
    );
    ok(err.message.includes("object"), "error names the offending type (object)");
    const after = fs.readFileSync(file, "utf8");
    ok(after === original, "file bytes unchanged");
  }

  // -------------------------------------------------------------------------
  // Test 10: F-3 — non-string (number) replacement_content -> InvalidReplacementError
  // -------------------------------------------------------------------------
  console.log("\n[Test 10] F-3: non-string (number) replacement_content");
  {
    const svc = makeService();
    const file = path.join(TEST_DIR, "f3_number.txt");
    const original = "hello world\nbye\n";
    fs.writeFileSync(file, original, "utf8");

    const err = await expectError(
      svc.editFile({
        path: "f3_number.txt",
        target_content: "hello world",
        replacement_content: 42,
      }),
      "f3-number",
      ["InvalidReplacementError", "replacement_content"]
    );
    ok(err.message.includes("number"), "error names the offending type (number)");
    const after = fs.readFileSync(file, "utf8");
    ok(after === original, "file bytes unchanged (no '42' coercion)");
  }

  // -------------------------------------------------------------------------
  // Test 11: F-3 — explicit empty string "" replacement_content -> allowed (deletion)
  // -------------------------------------------------------------------------
  console.log("\n[Test 11] F-3: explicit empty string replacement_content (deletion)");
  {
    const svc = makeService();
    const file = path.join(TEST_DIR, "f3_empty.txt");
    const original = "hello world\nbye\n";
    fs.writeFileSync(file, original, "utf8");

    const res = await svc.editFile({
      path: "f3_empty.txt",
      target_content: "hello world",
      replacement_content: "",
    });
    const after = fs.readFileSync(file, "utf8");
    ok(res.success === true, "returns success for explicit empty string");
    ok(res.occurrences_replaced === 1, "reports 1 occurrence replaced");
    ok(after === "\nbye\n", "matched region deleted, rest of file intact");
  }

  // -------------------------------------------------------------------------
  // Test 12: F-4 — mixed-ending file, edit LF section -> LF preserved, CRLF untouched
  // -------------------------------------------------------------------------
  console.log("\n[Test 12] F-4: mixed file, edit LF section");
  {
    const svc = makeService();
    const file = path.join(TEST_DIR, "f4_lf_section.txt");
    // Mixed file: first two lines LF, next two CRLF, last line LF.
    const original = "alpha\nbeta\ngamma\r\ndelta\r\nepsilon\n";
    fs.writeFileSync(file, original, "utf8");

    // Edit the LF section (alpha/beta). The old global heuristic would label the
    // whole file "CRLF" (because it contains a CRLF) and inject CRLF here.
    const res = await svc.editFile({
      path: "f4_lf_section.txt",
      target_content: "alpha\nbeta",
      replacement_content: "ALPHA\nBETA",
    });
    const after = fs.readFileSync(file, "utf8");
    ok(res.success === true, "returns success");
    ok(after === "ALPHA\nBETA\ngamma\r\ndelta\r\nepsilon\n", "LF section stays LF, CRLF section stays CRLF");
    // The edited region must NOT have been cross-pollinated with CRLF.
    ok(after.startsWith("ALPHA\nBETA\n"), "edited LF region has no injected CRLF");
    // The untouched CRLF region must remain CRLF.
    ok(after.includes("gamma\r\ndelta\r\n"), "untouched CRLF region preserved");
  }

  // -------------------------------------------------------------------------
  // Test 13: F-4 — mixed-ending file, edit CRLF section -> CRLF preserved, LF untouched
  // -------------------------------------------------------------------------
  console.log("\n[Test 13] F-4: mixed file, edit CRLF section");
  {
    const svc = makeService();
    const file = path.join(TEST_DIR, "f4_crlf_section.txt");
    // Mixed file: first two lines CRLF, next two LF, last line CRLF.
    const original = "alpha\r\nbeta\ngamma\ndelta\r\nepsilon";
    fs.writeFileSync(file, original, "utf8");

    // Edit the CRLF section (alpha/beta). The replacement is given in LF form;
    // localized detection must normalize it to CRLF for this region only.
    const res = await svc.editFile({
      path: "f4_crlf_section.txt",
      target_content: "alpha\nbeta",
      replacement_content: "ALPHA\nBETA",
    });
    const after = fs.readFileSync(file, "utf8");
    ok(res.success === true, "returns success");
    ok(after === "ALPHA\r\nBETA\ngamma\ndelta\r\nepsilon", "CRLF section stays CRLF, LF section stays LF");
    // The edited region must be CRLF (normalized to the local style).
    ok(after.startsWith("ALPHA\r\nBETA\n"), "edited CRLF region normalized to CRLF");
    // The untouched LF region must remain LF (no CRLF injected).
    ok(after.includes("gamma\ndelta\r\n"), "untouched LF region preserved");
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
