/**
 * P4i — Path Canonicalization Hardening Regression Suite
 *
 * Proves the workspace-path pipeline is realpath-canonical end-to-end so that
 * a junction/symlink cwd can NEVER produce a false SymlinkEscapeError /
 * PathEscapeError, while every REAL escape vector stays blocked.
 *
 * Root cause under test: this machine has a Windows junction D:\mnt\d -> D:\.
 * When a process is launched with cwd through the junction, process.cwd()
 * returns the junction literal while the sandbox services' containment checks
 * realpath targets to the real path — a literal-vs-real mismatch that produced
 * false escape errors (reproduced in canary/ast_engine from the junction cwd).
 *
 * Vectors:
 *   1. Link-path operations SUCCEED: a SandboxFsService / AstService
 *      constructed with the LINK path as root performs write/read/editFile/
 *      search through the link path without a false escape error.
 *   2. Real escapes STILL BLOCKED: through the link root, `../outside` and a
 *      symlink pointing outside the real root must still throw
 *      PathEscapeError / SymlinkEscapeError.
 *   3. DECISIVE VECTOR: spawn a child node process with cwd set to the
 *      junction path; the child constructs the service from process.cwd() and
 *      performs an editFile on a REAL-path file — the exact production failure
 *      shape. Must succeed.
 *
 * Skip-guarded where symlink/junction creation is unavailable (e.g. a
 * filesystem or privilege that forbids it). The real-path baseline always runs.
 */

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { SandboxFsService } from "../src/harness/services/sandbox_fs.js";
import { AstService } from "../src/harness/services/ast_service.js";
import { AvoOperator } from "../src/harness/avo/avo_operator.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(__dirname, "..");

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

/**
 * Creates a directory link (junction on Windows, symlink elsewhere) from
 * `link` to `target`. Returns true on success, false if the platform/FS
 * forbids it (caller then skips the link-specific vectors).
 */
function makeDirLink(target, link) {
  try {
    if (process.platform === "win32") {
      fs.symlinkSync(target, link, "junction");
    } else {
      fs.symlinkSync(target, link, "dir");
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Creates a file symlink from `link` to `target`. Returns true on success.
 */
function makeFileLink(target, link) {
  try {
    if (process.platform === "win32") {
      fs.symlinkSync(target, link, "file");
    } else {
      fs.symlinkSync(target, link);
    }
    return true;
  } catch {
    return false;
  }
}

async function runTests() {
  console.log("=== P4i Path Canonicalization Hardening Tests ===\n");

  // ------------------------------------------------------------------------
  // Setup: a real temp dir + a junction/symlink to it (the "link" form).
  // ------------------------------------------------------------------------
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "p4i_"));
  const realRoot = path.join(base, "real");
  const outsideDir = path.join(base, "outside");
  const linkRoot = path.join(base, "link");
  fs.mkdirSync(realRoot, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });

  const linkCreated = makeDirLink(realRoot, linkRoot);
  console.log(`  link form: ${linkCreated ? "created" : "UNAVAILABLE (skip-guarded)"}`);
  console.log(`  realRoot:  ${realRoot}`);
  console.log(`  linkRoot:  ${linkRoot}\n`);

  // A file that lives in the REAL root (the "real-path" target).
  const sampleFile = path.join(realRoot, "sample.js");
  const SAMPLE = "function add(a, b) {\n  return a + b;\n}\n";
  fs.writeFileSync(sampleFile, SAMPLE, "utf8");

  // ------------------------------------------------------------------------
  // Test 1: Link-path operations SUCCEED (no false escape error).
  // ------------------------------------------------------------------------
  console.log("[Test 1] Link-path operations succeed through the link root");
  if (!linkCreated) {
    skip("link-path write/read/edit/search", "symlink/junction unavailable");
  } else {
    // Construct the service with the LINK path as root (mirrors a process
    // whose process.cwd() is the junction). The constructor canonicalizes it
    // to the real root; operations through the link path must succeed.
    const fsSvc = new SandboxFsService({ root: linkRoot });

    // 1a. write through the link path
    const writePath = path.join(linkRoot, "written.txt");
    let writeOk = true;
    let writeErr = null;
    try {
      await fsSvc.writeFile({ path: writePath, content: "hello via link" });
    } catch (e) {
      writeOk = false;
      writeErr = e;
    }
    ok(writeOk, `writeFile through link path (err: ${writeErr?.message ?? "none"})`);

    // 1b. read it back through the link path
    let readOk = true;
    let readErr = null;
    let readContent = "";
    try {
      const r = await fsSvc.readFile({ path: writePath });
      readContent = r.content;
    } catch (e) {
      readOk = false;
      readErr = e;
    }
    ok(readOk && readContent.includes("hello via link"),
      `readFile through link path (err: ${readErr?.message ?? "none"})`);

    // 1c. editFile through the link path
    let editOk = true;
    let editErr = null;
    try {
      await fsSvc.editFile({
        path: writePath,
        target_content: "hello via link",
        replacement_content: "edited via link",
      });
    } catch (e) {
      editOk = false;
      editErr = e;
    }
    ok(editOk, `editFile through link path (err: ${editErr?.message ?? "none"})`);

    // 1d. searchCode through the link path
    let searchOk = true;
    let searchErr = null;
    try {
      const s = await fsSvc.searchCode({ query: "edited via link", dirPath: linkRoot });
      searchOk = s.count >= 1;
    } catch (e) {
      searchOk = false;
      searchErr = e;
    }
    ok(searchOk, `searchCode through link path (err: ${searchErr?.message ?? "none"})`);

    // 1e. AstService search through the link path (the original repro fired
    //     in AstService.search).
    const astSvc = new AstService({ root: linkRoot });
    let astOk = true;
    let astErr = null;
    let astCount = 0;
    try {
      const a = await astSvc.search({
        path: sampleFile,
        pattern: "function $NAME($$$ARGS) { $$$BODY }",
        lang: "js",
      });
      astCount = a.count;
      astOk = a.count === 1;
    } catch (e) {
      astOk = false;
      astErr = e;
    }
    ok(astOk, `AstService.search through link root (count=${astCount}, err: ${astErr?.message ?? "none"})`);
  }

  // ------------------------------------------------------------------------
  // Test 2: Real escapes are STILL BLOCKED through the link root.
  // ------------------------------------------------------------------------
  console.log("\n[Test 2] Real escapes still blocked through the link root");
  if (!linkCreated) {
    skip("escape vectors through link root", "symlink/junction unavailable");
  } else {
    const fsSvc = new SandboxFsService({ root: linkRoot });

    // 2a. `../outside` traversal through the link root.
    const outsideViaDotdot = path.join(linkRoot, "..", "outside.txt");
    let blockedDotdot = false;
    let dotdotErr = null;
    try {
      await fsSvc.writeFile({ path: outsideViaDotdot, content: "MALICIOUS" });
    } catch (e) {
      dotdotErr = e;
      blockedDotdot = /PathEscapeError|SymlinkEscapeError/.test(e.message);
    }
    ok(blockedDotdot,
      `../outside blocked (err: ${dotdotErr?.message ?? "NONE — BREACH"})`);

    // 2b. A directory link INSIDE the real root that points OUTSIDE, accessed
    //     through the link root. Its realpath lands outside the real root, so
    //     it must be blocked. (A directory junction is used because Windows
    //     file symlinks require admin; a directory junction works without it
    //     and exercises the same realpath-escape path.)
    const evilLink = path.join(realRoot, "evil");
    const evilCreated = makeDirLink(outsideDir, evilLink);
    if (!evilCreated) {
      skip("symlink-to-outside blocked", "dir link unavailable");
    } else {
      const evilTarget = path.join(linkRoot, "evil", "secret.txt");
      let blockedSymlink = false;
      let symlinkErr = null;
      try {
        await fsSvc.writeFile({ path: evilTarget, content: "MALICIOUS" });
      } catch (e) {
        symlinkErr = e;
        blockedSymlink = /PathEscapeError|SymlinkEscapeError/.test(e.message);
      }
      ok(blockedSymlink,
        `symlink-to-outside blocked (err: ${symlinkErr?.message ?? "NONE — BREACH"})`);
    }

    // 2c. AvoOperator.assertWithinWorkspace through the link root.
    const avo = new AvoOperator({ workspaceRoot: linkRoot });
    let avoBlocked = false;
    let avoErr = null;
    try {
      avo.assertWithinWorkspace(path.join(linkRoot, "..", "outside.js"));
    } catch (e) {
      avoErr = e;
      avoBlocked = /SecurityContainmentError/.test(e.message);
    }
    ok(avoBlocked,
      `AvoOperator.assertWithinWorkspace ../outside blocked (err: ${avoErr?.message ?? "NONE — BREACH"})`);
  }

  // ------------------------------------------------------------------------
  // Test 3: DECISIVE VECTOR — child process with junction cwd.
  // ------------------------------------------------------------------------
  console.log("\n[Test 3] Decisive vector: child node process with junction cwd");
  if (!linkCreated) {
    skip("child-process junction-cwd editFile", "symlink/junction unavailable");
  } else {
    // Write a child script that constructs the service from process.cwd()
    // (the junction) and edits a REAL-path file — the exact production
    // failure shape (root = junction literal, target = real path).
    // The import uses a file:// URL (required for ESM on Windows).
    const servicePath = path.join(WORKSPACE, "src", "harness", "services", "sandbox_fs.js");
    const serviceUrl = pathToFileURL(servicePath).href;
    // .mjs so the child is treated as an ES module (top-level await + import)
    // regardless of the temp dir's (absent) package.json "type".
    const childScript = path.join(base, "child.mjs");
    const childSource = `
import { SandboxFsService } from ${JSON.stringify(serviceUrl)};
const svc = new SandboxFsService({ root: process.cwd() });
const realFile = process.env.P4I_REAL_FILE;
try {
  const res = await svc.editFile({
    path: realFile,
    target_content: "return a + b;",
    replacement_content: "return a + b + 1;",
  });
  console.log("CHILD_OK " + (res.success ? "success" : "fail"));
  process.exit(0);
} catch (e) {
  console.log("CHILD_ERR " + e.message);
  process.exit(1);
}
`;
    fs.writeFileSync(childScript, childSource, "utf8");

    // Reset the sample file to a known state before the child edits it.
    fs.writeFileSync(sampleFile, SAMPLE, "utf8");

    let childOk = false;
    let childOut = "";
    let childErr = "";
    try {
      const r = execFileSync(process.execPath, [childScript], {
        cwd: linkRoot, // <-- the junction cwd (the production failure shape)
        env: { ...process.env, P4I_REAL_FILE: sampleFile },
        encoding: "utf8",
        timeout: 60_000,
      });
      childOut = r;
      childOk = /CHILD_OK success/.test(r);
    } catch (e) {
      childOut = e.stdout || "";
      childErr = e.stderr || e.message;
      childOk = /CHILD_OK success/.test(childOut);
    }
    ok(childOk,
      `child process (junction cwd) editFile on real-path file (out: ${childOut.trim() || childErr})`);

    // Verify the edit actually landed on the real file.
    const after = fs.readFileSync(sampleFile, "utf8");
    ok(after.includes("return a + b + 1;"),
      "child edit persisted to the real file");
  }

  // ------------------------------------------------------------------------
  // Test 4: Real-path baseline (always runs, independent of link availability).
  // ------------------------------------------------------------------------
  console.log("\n[Test 4] Real-path baseline (no junction)");
  {
    const fsSvc = new SandboxFsService({ root: realRoot });
    let baselineOk = true;
    let baselineErr = null;
    try {
      await fsSvc.writeFile({ path: path.join(realRoot, "baseline.txt"), content: "ok" });
      const r = await fsSvc.readFile({ path: path.join(realRoot, "baseline.txt") });
      baselineOk = r.content.includes("ok");
    } catch (e) {
      baselineOk = false;
      baselineErr = e;
    }
    ok(baselineOk, `real-path write/read (err: ${baselineErr?.message ?? "none"})`);
  }

  // ------------------------------------------------------------------------
  // Cleanup & summary
  // ------------------------------------------------------------------------
  try {
    fs.rmSync(base, { recursive: true, force: true });
  } catch {}

  console.log("\n==========================================");
  console.log(`Path Canonicalization Tests: ${passed} PASSED, ${failed} FAILED, ${skipped} SKIPPED`);
  console.log("==========================================");
  if (failed > 0) process.exit(1);
}

runTests().catch((err) => {
  console.error("Path canonicalization test suite uncaught error:", err);
  process.exit(1);
});
