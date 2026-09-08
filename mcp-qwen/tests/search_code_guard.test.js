/**
 * search_code guard tests — Slice 1 (F-1, F-2, F-12)
 *
 * Pins down the integrity and secret-leak-prevention invariants of
 * SandboxFsService.searchCode:
 *   (a) F-1  — literal string matching (regex metacharacters are NOT interpreted)
 *   (b) F-2  — fail-fast with GitGrepError on a fatal git error (exit 128) in a repo
 *   (c) F-2  — the fallback directory walk excludes .env / .env.* (secret leak prevention)
 *   (d) F-12 — max_results caps the TOTAL aggregate matches consistently across both paths
 *
 * Uses Node's native test runner (node:test) and strict assertions (node:assert/strict).
 * All fixtures are created in os.tmpdir() (a non-git location) and cleaned up afterwards.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { SandboxFsService, GitGrepError } from "../src/harness/services/sandbox_fs.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const tmpDirs = [];

function makeTmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function gitInit(dir) {
  execFileSync("git", ["init", "-q", "."], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "test"], { cwd: dir });
}

function gitCommitAll(dir) {
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: dir });
}

// Corrupt a valid repository so that `git grep` fails with a FATAL exit code
// (128) while the `.git` directory still exists. This is the canonical
// "fatal error inside a repo" case that must fail fast (F-2).
function corruptRepo(dir) {
  fs.writeFileSync(path.join(dir, ".git", "HEAD"), "GARBAGE NOT A REF\n", "utf8");
}

after(() => {
  for (const d of tmpDirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

// ---------------------------------------------------------------------------
// (a) F-1 — literal string matching
// ---------------------------------------------------------------------------

test("F-1: literal matching — regex metacharacters are not interpreted", async () => {
  const dir = makeTmpDir("lit_");
  // Line 1 and 4 contain the literal "a.c"; lines 2 and 3 would match the
  // REGEX "a.c" (a<any>c) but must NOT match the literal "a.c".
  fs.writeFileSync(path.join(dir, "t.txt"), "a.c\nabc\naxc\na.c literal\n", "utf8");
  gitInit(dir);
  gitCommitAll(dir);

  const svc = new SandboxFsService({ root: dir });
  const res = await svc.searchCode({ query: "a.c", dirPath: "." });

  assert.equal(
    res.count,
    2,
    `expected exactly 2 literal matches, got ${res.count}: ${JSON.stringify(res.matches)}`
  );
  assert.ok(res.matches.some((m) => m.includes("t.txt:1:")), "line 1 (a.c) should match");
  assert.ok(res.matches.some((m) => m.includes("t.txt:4:")), "line 4 (a.c literal) should match");
  assert.ok(
    !res.matches.some((m) => m.includes("t.txt:2:")),
    "line 2 (abc) must NOT match the literal a.c"
  );
  assert.ok(
    !res.matches.some((m) => m.includes("t.txt:3:")),
    "line 3 (axc) must NOT match the literal a.c"
  );
});

test("F-1: literal matching — other metacharacters are not interpreted", async () => {
  const dir = makeTmpDir("lit2_");
  // "a[b" is an invalid regex (unmatched bracket). As a literal it must match
  // only the line containing the exact substring "a[b".
  fs.writeFileSync(path.join(dir, "t.txt"), "a[b\nab\na[b literal\n", "utf8");
  gitInit(dir);
  gitCommitAll(dir);

  const svc = new SandboxFsService({ root: dir });
  const res = await svc.searchCode({ query: "a[b", dirPath: "." });

  assert.equal(
    res.count,
    2,
    `expected 2 literal matches for "a[b", got ${res.count}: ${JSON.stringify(res.matches)}`
  );
  assert.ok(res.matches.some((m) => m.includes("t.txt:1:")), "line 1 (a[b) should match");
  assert.ok(res.matches.some((m) => m.includes("t.txt:3:")), "line 3 (a[b literal) should match");
  assert.ok(!res.matches.some((m) => m.includes("t.txt:2:")), "line 2 (ab) must NOT match");
});

// ---------------------------------------------------------------------------
// (b) F-2 — fail-fast on fatal git error (exit 128)
// ---------------------------------------------------------------------------

test("F-2: fail-fast with GitGrepError on fatal git error (exit 128) in a repo", async () => {
  const dir = makeTmpDir("corrupt_");
  fs.writeFileSync(path.join(dir, "t.txt"), "a.c\n", "utf8");
  gitInit(dir);
  gitCommitAll(dir);
  corruptRepo(dir); // .git exists but is broken -> git grep exits 128

  const svc = new SandboxFsService({ root: dir });
  await assert.rejects(
    () => svc.searchCode({ query: "a.c", dirPath: "." }),
    (err) => {
      assert.ok(
        err instanceof GitGrepError,
        `expected GitGrepError, got ${err.name}: ${err.message}`
      );
      assert.equal(err.name, "GitGrepError");
      assert.equal(err.code, 128, `expected fatal exit code 128, got ${err.code}`);
      assert.ok(
        typeof err.stderr === "string" && err.stderr.length > 0,
        "stderr should be populated from git"
      );
      return true; // assert.rejects validation functions must return true on match
    }
  );
});

test("F-2: git grep exit 1 (no matches) returns an empty result, NOT an error", async () => {
  const dir = makeTmpDir("nomatch_");
  fs.writeFileSync(path.join(dir, "t.txt"), "hello\nworld\n", "utf8");
  gitInit(dir);
  gitCommitAll(dir);

  const svc = new SandboxFsService({ root: dir });
  const res = await svc.searchCode({ query: "zzz_no_match_zzz", dirPath: "." });

  assert.equal(res.count, 0, "expected 0 matches for a non-existent query");
  assert.deepEqual(res.matches, [], "expected an empty matches array");
});

// ---------------------------------------------------------------------------
// (c) F-2 — .env / .env.* exclusion in the fallback walk
// ---------------------------------------------------------------------------

test("F-2: fallback walk excludes .env and .env.* files (secret leak prevention)", async () => {
  const dir = makeTmpDir("nongit_");
  // A NON-git directory (no .git) triggers the fallback directory walk.
  fs.writeFileSync(path.join(dir, "plain.txt"), "needle here\n", "utf8");
  fs.writeFileSync(path.join(dir, ".env"), "SECRET=needle\n", "utf8");
  fs.writeFileSync(path.join(dir, ".env.local"), "SECRET2=needle\n", "utf8");

  const svc = new SandboxFsService({ root: dir });
  const res = await svc.searchCode({ query: "needle", dirPath: "." });

  assert.ok(res.matches.some((m) => m.includes("plain.txt")), "plain.txt should be found");
  assert.ok(
    !res.matches.some((m) => m.includes(".env")),
    ".env must NOT be ingested by the fallback walk"
  );
  assert.ok(
    !res.matches.some((m) => m.includes(".env.local")),
    ".env.local must NOT be ingested by the fallback walk"
  );
  assert.equal(
    res.count,
    1,
    `expected exactly 1 match (plain.txt), got ${res.count}: ${JSON.stringify(res.matches)}`
  );
});

test("F-2: fallback walk still finds normal files in nested non-git dirs", async () => {
  const dir = makeTmpDir("nongit_nested_");
  fs.mkdirSync(path.join(dir, "sub"), { recursive: true });
  fs.writeFileSync(path.join(dir, "sub", "deep.txt"), "deep needle\n", "utf8");
  fs.writeFileSync(path.join(dir, "sub", ".env"), "DEEP_SECRET=deep needle\n", "utf8");

  const svc = new SandboxFsService({ root: dir });
  const res = await svc.searchCode({ query: "deep needle", dirPath: "." });

  assert.ok(
    res.matches.some((m) => m.includes("sub/deep.txt") || m.includes("sub\\deep.txt")),
    "nested deep.txt should be found"
  );
  assert.ok(
    !res.matches.some((m) => m.includes(".env")),
    "nested .env must NOT be ingested"
  );
});

// ---------------------------------------------------------------------------
// (d) F-12 — cap semantics consistency
// ---------------------------------------------------------------------------

test("F-12: max_results caps TOTAL matches on the git path", async () => {
  const dir = makeTmpDir("cap_git_");
  const lines = Array.from({ length: 10 }, (_, i) => `line${i} token`);
  fs.writeFileSync(path.join(dir, "big.txt"), lines.join("\n") + "\n", "utf8");
  gitInit(dir);
  gitCommitAll(dir);

  const svc = new SandboxFsService({ root: dir });
  const res = await svc.searchCode({ query: "token", dirPath: ".", max_results: 3 });

  assert.equal(res.count, 3, `expected count 3, got ${res.count}`);
  assert.equal(res.matches.length, 3, `expected 3 matches, got ${res.matches.length}`);
  assert.ok(res.count <= 3, "count must not exceed max_results");
});

test("F-12: max_results caps TOTAL matches on the fallback path", async () => {
  const dir = makeTmpDir("cap_fb_");
  const lines = Array.from({ length: 10 }, (_, i) => `line${i} token`);
  fs.writeFileSync(path.join(dir, "big.txt"), lines.join("\n") + "\n", "utf8");
  // Non-git dir -> fallback walk.

  const svc = new SandboxFsService({ root: dir });
  const res = await svc.searchCode({ query: "token", dirPath: ".", max_results: 3 });

  assert.equal(res.count, 3, `expected count 3, got ${res.count}`);
  assert.equal(res.matches.length, 3, `expected 3 matches, got ${res.matches.length}`);
  assert.ok(res.count <= 3, "count must not exceed max_results");
});

test("F-12: git path and fallback path return consistent counts for identical content", async () => {
  const content = Array.from({ length: 10 }, (_, i) => `line${i} token`).join("\n") + "\n";

  const gitDir = makeTmpDir("consist_git_");
  fs.writeFileSync(path.join(gitDir, "big.txt"), content, "utf8");
  gitInit(gitDir);
  gitCommitAll(gitDir);
  const gitSvc = new SandboxFsService({ root: gitDir });
  const gitRes = await gitSvc.searchCode({ query: "token", dirPath: ".", max_results: 3 });

  const fbDir = makeTmpDir("consist_fb_");
  fs.writeFileSync(path.join(fbDir, "big.txt"), content, "utf8");
  const fbSvc = new SandboxFsService({ root: fbDir });
  const fbRes = await fbSvc.searchCode({ query: "token", dirPath: ".", max_results: 3 });

  assert.equal(
    gitRes.count,
    fbRes.count,
    `git count ${gitRes.count} should equal fallback count ${fbRes.count}`
  );
  assert.equal(gitRes.count, 3, "both paths should be capped at 3");
});
