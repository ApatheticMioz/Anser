#!/usr/bin/env node
/**
 * FX2 - Shell-Injection Hardening + Credential Honesty (fully OFFLINE)
 *
 * Vectors:
 *   (a) sessionId with a single quote -> resolveSessionId throws (fail-fast).
 *   (b) sessionId with ; / backtick / space / newline / $ / " -> throws.
 *   (c) legitimate ids (anser_verify_m0_s1, qwen_sh_123_abc, task-ui-ovh)
 *       -> pass through unchanged; the default-generated id matches the charset.
 *   (d) killGooseSessionSync with a quote-bearing id against a MOCKED
 *       runWslCommandSync: the constructed pgrep pattern contains the quote as
 *       the 4-char close/escaped/reopen sequence (' \ ' ') and has NO raw
 *       unescaped quote inside the single-quoted region.
 *   (d2) a real-bash execution of the constructed command for an injection
 *       payload does NOT execute the injected command (canary file not created).
 *   (e) getApiKeySync with no key file (candidate paths redirected to a fresh
 *       temp dir) -> returns null, and the request-builder path (serverInfo)
 *       omits the Authorization header.
 *
 * Run: node tests/shell_hardening.test.js
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

// Isolate the key-file candidate paths in a fresh temp dir BEFORE importing
// config.js / platform.js / wsl_bridge.js / server_lifecycle.js so
// getApiKeySync finds no key file. NOTE: QWEN_STATE_DIR alone does NOT affect
// apiKeyCandidates (they are home-based), so the home env vars are redirected
// too - this is the ISOLATED pattern from semaphore.test.js, extended to the
// actual candidate-path env vars.
const TMP_STATE = fs.mkdtempSync(path.join(os.tmpdir(), "fx2_state_"));
process.env.QWEN_STATE_DIR = TMP_STATE;
process.env.QWEN_WSL_HOME = TMP_STATE;
process.env.QWEN_WIN_HOME = TMP_STATE;
process.env.HOME = TMP_STATE;

const { getApiKeySync, killGooseSessionSync, setWslCommandSyncRunner } =
  await import("../src/wsl_bridge.js");
const { resolveSessionId } = await import("../src/goose_runner.js");
const { serverInfo } = await import("../src/server_lifecycle.js");

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`[PASS] ${name}`);
    passed++;
  } catch (err) {
    console.error(`[FAIL] ${name}: ${err.message}`);
    failed++;
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    console.log(`[PASS] ${name}`);
    passed++;
  } catch (err) {
    console.error(`[FAIL] ${name}: ${err.message}`);
    failed++;
  }
}

// The single-quote and backslash characters, built via char codes so the test
// source itself is free of ambiguous escape sequences.
const Q = String.fromCharCode(39); // '
const BS = String.fromCharCode(92); // \
// The 4-char POSIX single-quote escape: close-quote, escaped-quote, reopen-quote.
const ESC = Q + BS + Q + Q; // ' \ ' '
// A RegExp matching that 4-char sequence (the backslash is doubled in the
// pattern string so it matches a literal backslash).
const ESC_RE = new RegExp(Q + BS + BS + Q + Q, "g");

// ---------------------------------------------------------------------------
// (a) single quote in session_id -> resolveSessionId throws (fail-fast)
// ---------------------------------------------------------------------------
check("a: single quote in session_id throws with a clear message", () => {
  assert.throws(
    () => resolveSessionId("/tmp/x", "it" + Q + "s"),
    (err) => {
      assert.ok(/Invalid session_id/.test(err.message), `message names the id: ${err.message}`);
      assert.ok(err.message.includes("it" + Q + "s"), "message includes the offending id");
      assert.ok(/\[A-Za-z0-9._:-\]/.test(err.message), "message names the allowed charset");
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// (b) ; / backtick / space / newline / $ / " in session_id -> throws
// ---------------------------------------------------------------------------
for (const [label, bad] of [
  ["semicolon", "a;b"],
  ["backtick", "a`b`c"],
  ["space", "a b"],
  ["newline", "a\nb"],
  ["dollar", "a$b"],
  ["double-quote", "a\"b"],
]) {
  check(`b: ${label} in session_id throws`, () => {
    assert.throws(() => resolveSessionId("/tmp/x", bad), /Invalid session_id/);
  });
}

// ---------------------------------------------------------------------------
// (c) legitimate ids pass through unchanged
// ---------------------------------------------------------------------------
for (const id of ["anser_verify_m0_s1", "qwen_sh_123_abc", "task-ui-ovh"]) {
  check(`c: legitimate id ${id} passes through unchanged`, () => {
    assert.strictEqual(resolveSessionId("/tmp/x", id), id);
  });
}
check("c: default-generated id matches the charset", () => {
  const id = resolveSessionId("/tmp/x", undefined);
  assert.ok(/^[A-Za-z0-9._:-]+$/.test(id), `default id ${id} matches charset`);
  assert.ok(id.startsWith("workspace_"), "default id has the workspace_ prefix");
});

// ---------------------------------------------------------------------------
// (d) killGooseSessionSync with a quote-bearing id (mocked runner)
// ---------------------------------------------------------------------------
// Extract the escaped id from a constructed pgrep command.
function extractEscapedId(cmd) {
  const m = cmd.match(/^pgrep -f 'goose run --name (.*)' 2>\/dev\/null \|\| true$/);
  return m ? m[1] : null;
}

await checkAsync("d: quote-bearing id -> pgrep pattern escaped, no raw quote", async () => {
  const calls = [];
  setWslCommandSyncRunner((cmd) => {
    calls.push(cmd);
    return ""; // no pids -> the sweep stops after the pgrep
  });
  try {
    const id = "it" + Q + "s";
    killGooseSessionSync(id);
    assert.ok(calls.length >= 1, "mocked runner was called");
    const cmd = calls[0];
    assert.ok(cmd.startsWith("pgrep -f 'goose run --name "), `cmd starts with the pgrep pattern: ${cmd}`);
    const escaped = extractEscapedId(cmd);
    assert.ok(escaped !== null, `extracted the escaped id from: ${cmd}`);
    // The 4-char escape round-trips to the original id.
    assert.strictEqual(escaped.replace(ESC_RE, Q), id, "escaped id round-trips to the original");
    // No raw unescaped quote inside the single-quoted region.
    assert.strictEqual(escaped.replace(ESC_RE, "").includes(Q), false, "no raw unescaped quote");
    // The literal 4-char close/escaped/reopen sequence is present.
    assert.ok(escaped.includes(ESC), "contains the 4-char close/escaped/reopen sequence");
  } finally {
    setWslCommandSyncRunner(null);
  }
});

// (d2) real-bash execution: an injection payload does NOT execute. The
// marker is STDOUT-based, not file-based: on Windows, Git Bash mangles a
// backslash canary path (`C:\x` -> `CUsersApathx` created in the CWD), so a
// file-existence check would inspect the wrong path and FALSE-PASS on a real
// injection. A marker echoed to stdout is observed no matter where bash runs.
await checkAsync("d2: injection payload does not execute in a real bash", async () => {
  // Probe for bash (offline-skip if unavailable).
  let bashPath = null;
  try {
    execFileSync("bash", ["--version"], { stdio: "ignore" });
    bashPath = "bash";
  } catch {
    bashPath = null;
  }
  if (!bashPath) {
    console.log("  -> [SKIP] bash unavailable (skipping real-execution injection test)");
    return;
  }
  // A classic injection payload: if the quote broke out of the single-quoted
  // region, `echo <MARKER>` would run as a separate command and print the
  // marker to stdout. With correct escaping the `;` stays inside the pgrep
  // pattern and the marker never appears.
  const MARKER = "FX2_INJECTION_CANARY_EXECUTED";
  const id = "x" + Q + "; echo " + MARKER + "; echo " + Q + "y";
  const calls = [];
  setWslCommandSyncRunner((cmd) => {
    calls.push(cmd);
    return "";
  });
  killGooseSessionSync(id);
  setWslCommandSyncRunner(null);
  const cmd = calls[0];
  // Sanity (mutation-check for d2 itself): rebuild the command with the RAW
  // id substituted back in — quoting deliberately broken — and prove the
  // marker DOES fire. Without this, a marker check that could never observe
  // the injection would false-pass silently.
  const escaped = extractEscapedId(cmd);
  assert.ok(escaped !== null, `extracted escaped id from: ${cmd}`);
  const brokenCmd = cmd.replace(escaped, id);
  const brokenOut = execFileSync(bashPath, ["-c", brokenCmd], { stdio: "pipe" }).toString();
  assert.ok(
    brokenOut.includes(MARKER),
    `sanity: the unescaped payload must execute (got: ${JSON.stringify(brokenOut)})`
  );
  // Execute the EXACT constructed command in a real bash.
  const out = execFileSync(bashPath, ["-c", cmd], { stdio: "pipe" }).toString();
  assert.strictEqual(
    out.includes(MARKER),
    false,
    "injection marker must NOT appear in stdout of the constructed command"
  );
});

// ---------------------------------------------------------------------------
// (f) regex-metachar id -> pgrep pattern is BOTH regex-escaped (pgrep -f
//     matches an ERE: an unescaped `.*` would match every goose process on
//     the box and the sweep would kill sibling sessions) AND shell-escaped.
// ---------------------------------------------------------------------------
await checkAsync("f: regex-metachar id -> pattern regex-escaped AND shell-escaped", async () => {
  const calls = [];
  setWslCommandSyncRunner((cmd) => {
    calls.push(cmd);
    return "";
  });
  try {
    const id = "a.*b" + Q + "c";
    killGooseSessionSync(id);
    assert.ok(calls.length >= 1, "mocked runner was called");
    const escaped = extractEscapedId(calls[0]);
    assert.ok(escaped !== null, `extracted the escaped id from: ${calls[0]}`);
    // ERE metacharacters are backslash-escaped (literal match only).
    assert.ok(
      escaped.includes("a\\.\\*b"),
      `regex metachars escaped (found: ${escaped})`
    );
    assert.ok(!/[^\\][.*+?^${}()|[\]]/.test(escaped.replace(ESC, "")),
      "no unescaped ERE metachar outside the quote escape");
    // The quote still carries the 4-char idiom.
    assert.ok(escaped.includes(ESC), "quote uses the 4-char escape idiom");
    // Full round-trip: shell-unescape, then regex-unescape -> original id.
    const shellUnescaped = escaped.replace(ESC_RE, Q);
    const original = shellUnescaped.replace(/\\(.)/g, "$1");
    assert.strictEqual(original, id, `round-trips to the original id (got: ${original})`);
  } finally {
    setWslCommandSyncRunner(null);
  }
});

// ---------------------------------------------------------------------------
// (e) getApiKeySync with no key file -> null; request-builder omits Authorization
// ---------------------------------------------------------------------------
check("e: getApiKeySync returns null when no key file exists", () => {
  assert.strictEqual(getApiKeySync(), null, "no key file -> null (not a fabricated token)");
});

await checkAsync("e: serverInfo omits the Authorization header when the key is null", async () => {
  let capturedHeaders = null;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    capturedHeaders = opts?.headers ?? null;
    return { ok: true, status: 200, json: async () => ({ data: [{ max_model_len: 1000 }] }) };
  };
  try {
    const info = await serverInfo();
    assert.ok(info, "serverInfo returned info");
    assert.strictEqual(info.maxModelLen, 1000);
    assert.ok(capturedHeaders, "fetch was called with a headers object");
    assert.strictEqual(capturedHeaders.Authorization, undefined, "no Authorization header when the key is null");
  } finally {
    globalThis.fetch = origFetch;
  }
});

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
console.log("");
console.log("==========================================");
console.log(`Shell Hardening Tests: ${passed} PASSED, ${failed} FAILED`);
console.log("==========================================");
if (failed > 0) process.exit(1);
