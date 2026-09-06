/**
 * P11 - Syntax-Integrity Scan (chain test).
 *
 * Walks src/ and tests/ recursively (skipping node_modules and any
 * dot-directories) and runs the P6 JS syntax gate (AstService.validateSyntax:
 * `node --check` against a temp copy whose extension matches the module
 * system - .mjs for ESM-looking files, else .cjs) on EVERY .js file found.
 *
 * This closes the bug class where a stray block-terminator (two asterisks
 * immediately followed by a slash) inside a JSDoc / block comment
 * early-terminates the block and turns documentation into code, producing a
 * file that parses as a comment-terminated fragment and fails the syntax
 * gate. It is a permanent, whole-tree lock on JS syntax integrity.
 *
 * The gate is REUSED from src/harness/services/ast_service.js - this test
 * does NOT reimplement parsing.
 *
 * Asserts zero invalid files; on failure it names the offending file and the
 * parser error.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AstService } from "../src/harness/services/ast_service.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const SCAN_DIRS = ["src", "tests"];
const SKIP_DIRS = new Set(["node_modules"]);

let passed = 0;
let failed = 0;
const invalidFiles = [];

/**
 * Recursively collect .js files under `dir`, skipping node_modules and any
 * dot-directories (e.g. .venv, .evo, .test_evo_tmp).
 */
function collectJsFiles(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
      collectJsFiles(full, out);
    } else if (e.isFile() && e.name.endsWith(".js")) {
      out.push(full);
    }
  }
}

function main() {
  console.log("=== P11 Syntax-Integrity Scan (JS gate over src/ + tests/) ===\n");

  const ast = new AstService({ root: REPO_ROOT });

  const files = [];
  for (const d of SCAN_DIRS) {
    const dir = path.join(REPO_ROOT, d);
    if (fs.existsSync(dir)) collectJsFiles(dir, files);
  }

  console.log(`Scanning ${files.length} .js file(s) across ${SCAN_DIRS.join(", ")}...\n`);

  for (const file of files) {
    const rel = path.relative(REPO_ROOT, file);
    let content;
    try {
      content = fs.readFileSync(file, "utf8");
    } catch (err) {
      console.error(`  [FAIL] ${rel}: unreadable (${err.message})`);
      failed++;
      invalidFiles.push({ file: rel, error: `unreadable: ${err.message}` });
      continue;
    }

    const r = ast.validateSyntax(file, content, "js");

    if (r.checked && r.valid) {
      passed++;
    } else if (r.checked && !r.valid) {
      failed++;
      invalidFiles.push({ file: rel, error: r.error });
      console.error(`  [FAIL] ${rel}: ${r.error}`);
    } else {
      // checked:false - no checker available for js (should not happen for
      // node --check, but degrade honestly rather than false-pass).
      failed++;
      invalidFiles.push({ file: rel, error: `not checked: ${r.reason}` });
      console.error(`  [FAIL] ${rel}: not syntax-checked (${r.reason})`);
    }
  }

  console.log(`\n==========================================`);
  console.log(`Syntax-Integrity: ${passed} PASSED, ${failed} FAILED`);
  console.log(`==========================================`);

  if (invalidFiles.length > 0) {
    console.error(`\nInvalid file(s):`);
    for (const { file, error } of invalidFiles) {
      console.error(`  - ${file}: ${error}`);
    }
    process.exit(1);
  }

  console.log(`\n>>> ALL ${files.length} JS FILES SYNTACTICALLY VALID <<<\n`);
  process.exit(0);
}

main();
