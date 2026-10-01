/**
 * Test suite for apply_patch (git apply integration) in SandboxFsService
 *
 * Slice 3 — Patch Engine Hardening (F-5, F-6, F-10, F-11, F-13).
 *
 * Original coverage (kept):
 *   1. Clean unified diff patch application.
 *   2. Empty patch rejection.
 *   3. Corrupted patch rejection (GitApplyError).
 *
 * New adversarial / resilience coverage (F-10, F-13):
 *   4. `../` path traversal inside a patch is rejected; the outside file is
 *      left untouched.
 *   5. Symlink escape: a patch that writes through a symlink pointing outside
 *      the sandbox is refused; the outside file is left untouched.
 *   6. Multi-file patch atomicity: if ONE file in a multi-file patch conflicts,
 *      ZERO files are written (git apply is atomic).
 *   7. Absolute path inside a patch is rejected; the target is untouched.
 *
 * New hardening coverage (F-5, F-6, F-11):
 *   8. Oversized patch (> 2 MB) is rejected with PatchTooLargeError BEFORE any
 *      git subprocess is spawned.
 *   9. A patch at exactly the 2 MB cap is NOT rejected by the size check
 *      (proves the cap uses strict `>`), so it proceeds to git.
 *  10. A subprocess timeout surfaces as a distinct GitApplyTimeoutError (not
 *      the generic GitApplyError) and leaves the file unmodified.
 *  11. Whitespace faithfulness (F-6): a patch that adds a line with trailing
 *      spaces writes those bytes verbatim (no silent `--whitespace=fix`
 *      rewrite).
 *  12. Non-git directory (F-11): a patch applies cleanly in a plain
 *      (non-git) directory; git apply does not require a repository.
 *
 * Runs under both `node tests/apply_patch.test.js` and
 * `node --test tests/apply_patch.test.js` (the top-level runTests() exits
 * non-zero on any failure, which the native runner reports as a failed test).
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  SandboxFsService,
  PatchTooLargeError,
  GitApplyTimeoutError,
  MAX_PATCH_SIZE,
} from "../src/harness/services/sandbox_fs.js";

// Use the canonical (real) workspace root to avoid junction/symlink
// resolution mismatches (e.g. D:\mnt\d -> D:\ on Windows).
const CANONICAL_CWD = fs.realpathSync(process.cwd());
const TEST_DIR = path.join(CANONICAL_CWD, ".apply_patch_tmp");
// A sibling directory that lives OUTSIDE the sandbox root, used as the
// "outside" target for traversal / symlink-escape tests.
const OUTSIDE_DIR = path.join(CANONICAL_CWD, ".apply_patch_outside");

async function runTests() {
  console.log("=== apply_patch Verification Tests ===\n");
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

  // Capture the thrown error from an async call, or null if it resolved.
  async function capture(promise) {
    try {
      await promise;
      return null;
    } catch (err) {
      return err;
    }
  }

  // Fresh sandbox dirs for each run.
  for (const d of [TEST_DIR, OUTSIDE_DIR]) {
    if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
    fs.mkdirSync(d, { recursive: true });
  }

  const svc = new SandboxFsService({ root: TEST_DIR });
  const sampleFile = path.join(TEST_DIR, "patch_target.js");
  fs.writeFileSync(sampleFile, "const x = 1;\nconst y = 2;\n", "utf8");

  // -------------------------------------------------------------------------
  // Test 1 — clean unified diff patch application
  // -------------------------------------------------------------------------
  console.log("[Test 1] Clean unified diff patch application");
  {
    const patch = `--- a/patch_target.js
+++ b/patch_target.js
@@ -1,2 +1,2 @@
 const x = 1;
-const y = 2;
+const y = 200;
`;
    const err = await capture(svc.applyPatch({ patch, dirPath: "." }));
    ok(err === null, "returns success (no throw)");
    const updated = fs.readFileSync(sampleFile, "utf8");
    ok(updated === "const x = 1;\nconst y = 200;\n", "file content patched correctly");
  }

  // -------------------------------------------------------------------------
  // Test 2 — empty patch rejection
  // -------------------------------------------------------------------------
  console.log("\n[Test 2] Empty patch rejection");
  {
    const err = await capture(svc.applyPatch({ patch: "" }));
    ok(
      err !== null && err.message.includes("patch cannot be empty"),
      "rejects with clear message"
    );
  }

  // -------------------------------------------------------------------------
  // Test 3 — corrupted patch rejection (generic GitApplyError)
  // -------------------------------------------------------------------------
  console.log("\n[Test 3] Corrupted patch rejection");
  {
    const err = await capture(svc.applyPatch({ patch: "corrupted header\n@@ -99,99 @@\n" }));
    ok(
      err !== null && err.message.includes("GitApplyError"),
      "rejects with GitApplyError"
    );
  }

  // -------------------------------------------------------------------------
  // Test 4 — F-10: `../` path traversal rejection
  // -------------------------------------------------------------------------
  console.log("\n[Test 4] F-10: ../ path traversal rejection");
  {
    const outsideFile = path.join(OUTSIDE_DIR, "outside.txt");
    const outsideOriginal = "OUTSIDE-ORIGINAL\n";
    fs.writeFileSync(outsideFile, outsideOriginal, "utf8");

    // A patch that tries to write to ../outside.txt (relative to the sandbox
    // root, i.e. OUTSIDE_DIR/outside.txt).
    const patch = `--- a/../outside.txt
+++ b/../outside.txt
@@ -1 +1 @@
-OUTSIDE-ORIGINAL
+PWNED
`;
    const err = await capture(svc.applyPatch({ patch, dirPath: "." }));
    ok(err !== null, "traversal patch is rejected (throws)");
    const after = fs.readFileSync(outsideFile, "utf8");
    ok(after === outsideOriginal, "outside file is untouched after traversal attempt");
  }

  // -------------------------------------------------------------------------
  // Test 5 — F-10: symlink escape / write refusal
  // -------------------------------------------------------------------------
  console.log("\n[Test 5] F-10: symlink escape / write refusal");
  {
    const outsideFile = path.join(OUTSIDE_DIR, "sym_outside.txt");
    const outsideOriginal = "OUTSIDE-ORIGINAL\n";
    fs.writeFileSync(outsideFile, outsideOriginal, "utf8");

    // A symlink INSIDE the sandbox that points OUTSIDE the sandbox.
    const linkPath = path.join(TEST_DIR, "sneaky.txt");
    try {
      fs.symlinkSync(outsideFile, linkPath);
    } catch (e) {
      // If symlinks are unavailable on this platform, skip the write-refusal
      // assertion but still confirm nothing was written outside.
      console.log(`  (symlink unavailable: ${e.message}; asserting outside file untouched)`);
    }

    const patch = `--- a/sneaky.txt
+++ b/sneaky.txt
@@ -1 +1 @@
-OUTSIDE-ORIGINAL
+PWNED
`;
    const err = await capture(svc.applyPatch({ patch, dirPath: "." }));
    ok(err !== null, "symlink-escape patch is rejected (throws)");
    const after = fs.readFileSync(outsideFile, "utf8");
    ok(after === outsideOriginal, "outside file is untouched after symlink-escape attempt");
  }

  // -------------------------------------------------------------------------
  // Test 6 — F-13: multi-file patch conflict atomicity
  // -------------------------------------------------------------------------
  console.log("\n[Test 6] F-13: multi-file patch conflict atomicity");
  {
    const goodFile = path.join(TEST_DIR, "good.txt");
    const badFile = path.join(TEST_DIR, "bad.txt");
    fs.writeFileSync(goodFile, "good line\n", "utf8");
    fs.writeFileSync(badFile, "bad line\n", "utf8");

    // good.txt patch matches; bad.txt patch has WRONG context (conflict).
    const patch =
      `--- a/good.txt
+++ b/good.txt
@@ -1 +1 @@
-good line
+good changed
` +
      `--- a/bad.txt
+++ b/bad.txt
@@ -1 +1 @@
-WRONG CONTEXT
+bad changed
`;
    const err = await capture(svc.applyPatch({ patch, dirPath: "." }));
    ok(err !== null, "conflicting multi-file patch is rejected (throws)");
    const goodAfter = fs.readFileSync(goodFile, "utf8");
    const badAfter = fs.readFileSync(badFile, "utf8");
    ok(goodAfter === "good line\n", "good.txt NOT written (atomicity: 0 files written)");
    ok(badAfter === "bad line\n", "bad.txt NOT written (atomicity: 0 files written)");
  }

  // -------------------------------------------------------------------------
  // Test 7 — F-10: absolute path inside a patch is rejected
  // -------------------------------------------------------------------------
  console.log("\n[Test 7] F-10: absolute path rejection");
  {
    const absTarget = path.join(OUTSIDE_DIR, "abs_target.txt");
    const absOriginal = "ABS-ORIGINAL\n";
    fs.writeFileSync(absTarget, absOriginal, "utf8");

    const patch = `--- a/${absTarget}
+++ b/${absTarget}
@@ -1 +1 @@
-ABS-ORIGINAL
+PWNED
`;
    const err = await capture(svc.applyPatch({ patch, dirPath: "." }));
    ok(err !== null, "absolute-path patch is rejected (throws)");
    const after = fs.readFileSync(absTarget, "utf8");
    ok(after === absOriginal, "absolute-path target is untouched");
  }

  // -------------------------------------------------------------------------
  // Test 8 — F-5: oversized patch (> 2 MB) -> PatchTooLargeError
  // -------------------------------------------------------------------------
  console.log("\n[Test 8] F-5: oversized patch -> PatchTooLargeError");
  {
    // 2 MB + 1 byte, well over the cap. Not a valid patch, but the size check
    // runs BEFORE git is spawned, so it must be rejected by the cap.
    const oversized = "x".repeat(MAX_PATCH_SIZE + 1);
    const err = await capture(svc.applyPatch({ patch: oversized, dirPath: "." }));
    ok(err instanceof PatchTooLargeError, "throws PatchTooLargeError (instanceof)");
    ok(
      err !== null && err.name === "PatchTooLargeError",
      "error name is PatchTooLargeError"
    );
    ok(
      err !== null && err.size === MAX_PATCH_SIZE + 1 && err.limit === MAX_PATCH_SIZE,
      "error carries size and limit"
    );
  }

  // -------------------------------------------------------------------------
  // Test 9 — F-5: patch at exactly the cap is NOT rejected by the size check
  // -------------------------------------------------------------------------
  console.log("\n[Test 9] F-5: patch at exactly the cap passes the size check");
  {
    // Exactly MAX_PATCH_SIZE bytes. The size check uses strict `>`, so this
    // must NOT throw PatchTooLargeError. It is not a valid patch, so git will
    // reject it with a generic GitApplyError — proving the size check let it
    // through to git.
    const atCap = "x".repeat(MAX_PATCH_SIZE);
    const err = await capture(svc.applyPatch({ patch: atCap, dirPath: "." }));
    ok(
      err !== null && !(err instanceof PatchTooLargeError),
      "not rejected by the size cap (proceeds to git)"
    );
    ok(
      err !== null && err.message.includes("GitApplyError"),
      "reaches git and fails with GitApplyError (not the size cap)"
    );
  }

  // -------------------------------------------------------------------------
  // Test 10 — F-5: subprocess timeout -> distinct GitApplyTimeoutError
  // -------------------------------------------------------------------------
  console.log("\n[Test 10] F-5: subprocess timeout -> GitApplyTimeoutError");
  {
    // A service with a 1ms git-apply timeout, so a valid-but-large patch is
    // killed by the timeout before it can complete.
    const timeoutSvc = new SandboxFsService({ root: TEST_DIR, gitApplyTimeoutMs: 1 });
    const bigFile = path.join(TEST_DIR, "big.txt");
    const n = 20000;
    const original = Array.from({ length: n }, (_, i) => `old line ${i + 1}`).join("\n") + "\n";
    fs.writeFileSync(bigFile, original, "utf8");

    const lines = ["--- a/big.txt", "+++ b/big.txt", `@@ -1,${n} +1,${n} @@`];
    for (let i = 1; i <= n; i++) {
      lines.push(`-old line ${i}`);
      lines.push(`+new line ${i}`);
    }
    const patch = lines.join("\n") + "\n";

    const err = await capture(timeoutSvc.applyPatch({ patch, dirPath: "." }));
    ok(err instanceof GitApplyTimeoutError, "throws GitApplyTimeoutError (instanceof)");
    ok(
      err !== null && err.name === "GitApplyTimeoutError",
      "error name is GitApplyTimeoutError"
    );
    ok(
      err !== null && err.message.includes("GitApplyTimeoutError"),
      "message names the timeout"
    );
    const after = fs.readFileSync(bigFile, "utf8");
    ok(after === original, "file is unmodified after the timeout (atomic)");
  }

  // -------------------------------------------------------------------------
  // Test 11 — F-6: whitespace faithfulness (no silent --whitespace=fix)
  // -------------------------------------------------------------------------
  console.log("\n[Test 11] F-6: whitespace faithfulness (no silent rewrite)");
  {
    const wsFile = path.join(TEST_DIR, "ws.txt");
    fs.writeFileSync(wsFile, "a\n", "utf8");
    // The added line has trailing spaces. With --whitespace=fix these would be
    // stripped; without it (our behavior) they are written verbatim.
    const patch = "--- a/ws.txt\n+++ b/ws.txt\n@@ -1,1 +1,2 @@\n a\n+added with trailing  \n";
    const err = await capture(svc.applyPatch({ patch, dirPath: "." }));
    ok(err === null, "whitespace patch applies (no throw)");
    const after = fs.readFileSync(wsFile, "utf8");
    ok(
      after === "a\nadded with trailing  \n",
      "trailing spaces preserved verbatim (no --whitespace=fix rewrite)"
    );
  }

  // -------------------------------------------------------------------------
  // Test 12 — F-11: non-git directory application
  // -------------------------------------------------------------------------
  console.log("\n[Test 12] F-11: non-git directory application");
  {
    // A plain directory in os.tmpdir() is NOT inside any git repository.
    const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), "apply_patch_nongit_"));
    try {
      const nonGitSvc = new SandboxFsService({ root: nonGitDir });
      const f = path.join(nonGitDir, "nongit.txt");
      fs.writeFileSync(f, "hello\n", "utf8");
      const patch = "--- a/nongit.txt\n+++ b/nongit.txt\n@@ -1 +1 @@\n-hello\n+world\n";
      const err = await capture(nonGitSvc.applyPatch({ patch, dirPath: "." }));
      ok(err === null, "patch applies in a non-git directory (no throw)");
      const after = fs.readFileSync(f, "utf8");
      // In a non-git directory, line endings depend on the host's git config
      // (core.autocrlf may convert LF to CRLF on Windows runners where no
      // .gitattributes exists). Normalize newlines before comparing.
      ok(
        after.replace(/\r\n/g, "\n") === "world\n",
        "file modified in the non-git directory"
      );
    } finally {
      fs.rmSync(nonGitDir, { recursive: true, force: true });
    }
  }

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------
  for (const d of [TEST_DIR, OUTSIDE_DIR]) {
    if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
  }

  console.log("\n==========================================");
  console.log(`apply_patch Tests: ${passed} PASSED, ${failed} FAILED`);
  console.log("==========================================");
  if (failed > 0) process.exit(1);
}

runTests().catch((err) => {
  console.error("apply_patch test error:", err);
  process.exit(1);
});
