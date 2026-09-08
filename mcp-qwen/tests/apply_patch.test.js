/**
 * Test suite for apply_patch (git apply integration) in SandboxFsService
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { SandboxFsService } from "../src/harness/services/sandbox_fs.js";

const CANONICAL_CWD = fs.realpathSync(process.cwd());
const TEST_DIR = path.join(CANONICAL_CWD, ".apply_patch_tmp");

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

  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(TEST_DIR, { recursive: true });

  const svc = new SandboxFsService({ root: TEST_DIR });
  const sampleFile = path.join(TEST_DIR, "patch_target.js");
  fs.writeFileSync(sampleFile, "const x = 1;\nconst y = 2;\n", "utf8");

  // Standard unified diff patch
  const patch = `--- a/patch_target.js
+++ b/patch_target.js
@@ -1,2 +1,2 @@
 const x = 1;
-const y = 2;
+const y = 200;
`;

  console.log("[Test 1] Clean unified diff patch application");
  try {
    const res = await svc.applyPatch({ patch, dirPath: "." });
    ok(res.success === true, "returns success: true");
    const updated = fs.readFileSync(sampleFile, "utf8");
    ok(updated === "const x = 1;\nconst y = 200;\n", "file content patched correctly");
  } catch (err) {
    console.error("Test 1 error:", err);
    ok(false, "should not throw on valid patch");
  }

  console.log("\n[Test 2] Empty patch rejection");
  try {
    await svc.applyPatch({ patch: "" });
    ok(false, "empty patch should reject");
  } catch (err) {
    ok(err.message.includes("patch cannot be empty"), "rejects with clear message");
  }

  console.log("\n[Test 3] Corrupted patch rejection");
  try {
    await svc.applyPatch({ patch: "corrupted header\n@@ -99,99 @@\n" });
    ok(false, "corrupted patch should reject");
  } catch (err) {
    ok(err.message.includes("GitApplyError"), "rejects with GitApplyError");
  }

  // Cleanup
  fs.rmSync(TEST_DIR, { recursive: true, force: true });

  console.log("\n==========================================");
  console.log(`apply_patch Tests: ${passed} PASSED, ${failed} FAILED`);
  console.log("==========================================");
  if (failed > 0) process.exit(1);
}

runTests().catch((err) => {
  console.error("apply_patch test error:", err);
  process.exit(1);
});
