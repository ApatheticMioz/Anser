/**
 * P11 — Stdio Purity Regression (zero-stdout-write invariant lock).
 *
 * Spawns `node index.js` from the repo root and speaks MCP over stdio:
 *   1. initialize  (protocolVersion "2024-11-05")
 *   2. await its response
 *   3. notifications/initialized
 *   4. tools/list
 *
 * It asserts that EVERY byte received on the child's stdout parses as a
 * complete newline-delimited JSON-RPC frame — no stray text, no log lines,
 * no BOM. This permanently locks the zero-stdout-write invariant: the MCP
 * server must emit ONLY JSON-RPC on stdout (all diagnostics go to stderr).
 *
 * A live MCP instance may already hold port 18021; index.js logs that
 * conflict to stderr and continues — such stderr lines are ignored here
 * because they do not affect stdout purity.
 *
 * Bounded: the child is killed and the test fails after ~20s.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const INDEX = path.join(REPO_ROOT, "index.js");

const TIMEOUT_MS = 20_000;

// F9 (state isolation): the spawned index.js child imports config.js
// (QWEN_STATE_DIR) and task_registry.js (writes task JSON / session logs /
// slot leases under QWEN_STATE_DIR). Redirect the child's state dir to a fresh
// temp dir so the live MCP server never writes to the production
// C:\Users\Apath\.qwen state.
const TMP_STATE = fs.mkdtempSync(path.join(os.tmpdir(), "fx7_stdio_state_"));
const ISOLATED_ENV = {
  ...process.env,
  QWEN_STATE_DIR: TMP_STATE,
  QWEN_WSL_HOME: TMP_STATE,
  QWEN_WIN_HOME: TMP_STATE,
  HOME: TMP_STATE,
};

function frame(msg) {
  return JSON.stringify(msg) + "\n";
}

function main() {
  console.log("=== P11 Stdio Purity (zero-stdout-write invariant) ===\n");

  const child = spawn(process.execPath, [INDEX], {
    cwd: REPO_ROOT,
    stdio: ["pipe", "pipe", "pipe"],
    env: ISOLATED_ENV,
  });

  let stdoutBuf = "";
  let stderrBuf = "";
  let frames = 0;
  let sawInitializeResponse = false;
  let sawToolsListResponse = false;
  let done = false;
  let timer = null;

  const fail = (msg) => {
    if (done) return;
    done = true;
    if (timer) clearTimeout(timer);
    console.error(`\n[FAIL] ${msg}`);
    if (stdoutBuf.trim()) {
      console.error(`--- raw stdout (first 2000 bytes) ---\n${stdoutBuf.slice(0, 2000)}`);
    }
    if (stderrBuf.trim()) {
      console.error(`--- raw stderr (first 1000 bytes) ---\n${stderrBuf.slice(0, 1000)}`);
    }
    try {
      child.kill("SIGKILL");
    } catch {}
    process.exit(1);
  };

  const finish = (ok, msg) => {
    if (done) return;
    done = true;
    if (timer) clearTimeout(timer);
    try {
      child.kill("SIGKILL");
    } catch {}
    if (ok) {
      console.log(`\n==========================================`);
      console.log(`Stdio Purity: PASSED (${msg})`);
      console.log(`==========================================`);
      console.log(`\n>>> STDOUT IS PURE NEWLINE-DELIMITED JSON-RPC <<<\n`);
      process.exit(0);
    } else {
      fail(msg);
    }
  };

  // Hard bound: kill and fail after ~20s.
  timer = setTimeout(() => {
    finish(false, `timed out after ${TIMEOUT_MS}ms (no clean MCP handshake)`);
  }, TIMEOUT_MS);

  child.stdout.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    stdoutBuf += text;

    // Split into complete newline-delimited frames; keep the trailing
    // partial line in the buffer for the next chunk.
    let idx;
    while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
      const line = stdoutBuf.slice(0, idx);
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (line.length === 0) continue; // blank line is not a frame

      // EVERY non-blank line must be a complete JSON-RPC frame.
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (err) {
        finish(
          false,
          `non-JSON-RPC byte on stdout: ${JSON.stringify(line.slice(0, 200))} (${err.message})`
        );
        return;
      }
      if (msg.jsonrpc !== "2.0") {
        finish(false, `frame missing jsonrpc:"2.0": ${JSON.stringify(line.slice(0, 200))}`);
        return;
      }
      frames++;

      if (msg.id === 1 && msg.result && msg.result.protocolVersion) {
        sawInitializeResponse = true;
        // Now send notifications/initialized, then tools/list.
        child.stdin.write(frame({ jsonrpc: "2.0", method: "notifications/initialized" }));
        child.stdin.write(frame({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }));
      } else if (msg.id === 2 && msg.result && Array.isArray(msg.result.tools)) {
        sawToolsListResponse = true;
        finish(true, `handshake complete: ${frames} pure frames, ${msg.result.tools.length} tools listed`);
      }
    }
  });

  child.stderr.on("data", (chunk) => {
    // stderr is NOT part of the purity contract; capture for diagnostics only.
    stderrBuf += chunk.toString("utf8");
  });

  child.on("error", (err) => {
    finish(false, `failed to spawn index.js: ${err.message}`);
  });

  child.on("exit", (code, signal) => {
    if (done) return;
    // If the child exited before we saw the tools/list response, that is a
    // failure (it died mid-handshake).
    if (!sawToolsListResponse) {
      finish(false, `child exited (code=${code}, signal=${signal}) before tools/list response`);
    }
  });

  // Kick off the handshake: initialize.
  child.stdin.write(
    frame({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "stdio-purity-test", version: "1.0.0" },
      },
    })
  );
}

main();
