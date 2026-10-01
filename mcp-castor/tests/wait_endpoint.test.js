#!/usr/bin/env node
/**
 * M1 (F9/N4/N5) — /task/:id/wait terminal-response contract.
 *
 * The old behavior: on task FAILURE the wait endpoint replied HTTP 500 with
 * a text/markdown body. Downstream orchestrators (curl --fail) read that as
 * an infra crash and retry-stormed a terminal state.
 *
 * The new contract:
 *   - Terminal (done) responses — success OR failure — are ALWAYS HTTP 200
 *     with Content-Type application/json, body shape identical to
 *     GET /task/:id ({found, id, status, isError, result, ...}).
 *   - The status string is NOT masked or rewritten (engine_empty_response
 *     stays engine_empty_response).
 *   - Connection: close is set so the socket terminates cleanly after the
 *     body (observed clients hanging on an open socket).
 *   - The success path is unchanged in semantics (200 + JSON).
 *
 * Covers both the memory path (task in the in-process Map) and the
 * disk-poll path (task on disk from another instance).
 *
 * Run: node tests/wait_endpoint.test.js
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import assert from "node:assert";

// ---------------------------------------------------------------------------
// Isolate ALL on-disk state in a fresh temp dir BEFORE any src import so
// config.js pins QWEN_STATE_DIR (and TASK_DIR under it) to the private dir.
// The production ~/.qwen is never read or written.
// ---------------------------------------------------------------------------
const TMP_STATE = fs.mkdtempSync(path.join(os.tmpdir(), "wait_endpoint_"));
process.env.QWEN_STATE_DIR = TMP_STATE;
process.env.HOME = TMP_STATE;
process.env.QWEN_WSL_HOME = TMP_STATE;
process.env.QWEN_WIN_HOME = TMP_STATE;

const { STATUS_PORT } = await import("../src/config.js");
const taskRegistry = await import("../src/task_registry.js");
const { tasks, statusHttpServer, notifyWaiters } = taskRegistry;

// ---------------------------------------------------------------------------
// check() harness + hard watchdog
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;
function check(name, cond, detail = "") {
  if (cond) {
    console.log(`[PASS] ${name}`);
    passed++;
  } else {
    console.error(`[FAIL] ${name}${detail ? ` (${detail})` : ""}`);
    failed++;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Hard watchdog: force termination so a wedged check can never hang the suite.
setTimeout(() => {
  console.error(`\nHARD WATCHDOG fired - forcing exit (failures=${failed})`);
  process.exit(failed === 0 ? 0 : 1);
}, 30_000).unref();

// Find a free loopback port.
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

// Make an HTTP GET request and return { status, headers, body, socketClosed }.
// socketClosed is true if the server sent Connection: close or the socket
// was destroyed after the response.
function httpGet(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { hostname: "127.0.0.1", port, path: urlPath },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          const connHeader = res.headers["connection"] || "";
          const socketClosed =
            connHeader.toLowerCase() === "close" ||
            res.socket?.destroyed === true;
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body,
            socketClosed,
          });
        });
      }
    );
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Setup: start the status HTTP server on a free port.
// ---------------------------------------------------------------------------
const PORT = await getFreePort();
await new Promise((resolve, reject) => {
  statusHttpServer.once("error", reject);
  statusHttpServer.listen(PORT, "127.0.0.1", () => {
    statusHttpServer.removeListener("error", reject);
    resolve();
  });
});

// ---------------------------------------------------------------------------
// M1a: Memory-path FAILURE — done + isError → 200 + JSON + isError:true
// ---------------------------------------------------------------------------
console.log("\n[M1a] Memory-path failure: done+isError → 200 + JSON");
{
  const now = Date.now();
  const task = {
    id: "task_m1a_fail",
    sessionId: "m1a",
    cwd: TMP_STATE,
    createdAt: now - 60_000,
    startedAt: now - 50_000,
    finishedAt: now - 10_000,
    lastActivityAt: now - 10_000,
    status: "engine_empty_response",
    done: true,
    isError: true,
    reasoningEffort: "xhigh",
    streamBytes: 1234,
    streamTail: "some tail text",
    fileOps: [],
    toolCallsCount: 3,
    result: {
      isError: true,
      text: "Engine returned empty response after 3 retries.",
      toolCalls: 3,
      errors: ["ENGINE_EMPTY_RESPONSE"],
    },
  };
  tasks.set(task.id, task);

  const res = await httpGet(PORT, `/task/${task.id}/wait`);
  check("M1a: status is 200 (not 500)", res.status === 200, `got ${res.status}`);
  check(
    "M1a: Content-Type is application/json",
    (res.headers["content-type"] || "").includes("application/json"),
    `got ${res.headers["content-type"]}`
  );
  check(
    "M1a: Connection header is close",
    (res.headers["connection"] || "").toLowerCase() === "close",
    `got ${res.headers["connection"]}`
  );
  check("M1a: socket closed after body", res.socketClosed === true);

  let parsed;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    parsed = null;
  }
  check("M1a: body is valid JSON", parsed !== null, res.body.slice(0, 100));
  if (parsed) {
    check("M1a: found is true", parsed.found === true);
    check("M1a: id matches", parsed.id === task.id, `got ${parsed.id}`);
    check("M1a: isError is true", parsed.isError === true);
    check("M1a: done is true", parsed.done === true);
    check(
      "M1a: status is NOT masked (engine_empty_response stays)",
      parsed.status === "engine_empty_response",
      `got ${parsed.status}`
    );
    check(
      "M1a: result is present",
      parsed.result !== null && parsed.result !== undefined
    );
    check(
      "M1a: result.isError is true",
      parsed.result?.isError === true
    );
    check(
      "M1a: result.text preserved",
      parsed.result?.text === task.result.text,
      `got ${parsed.result?.text}`
    );
    check("M1a: sessionId present", parsed.sessionId === "m1a");
    check("M1a: cwd present", parsed.cwd === TMP_STATE);
    check("M1a: elapsed_s is a number", typeof parsed.elapsed_s === "number");
    check("M1a: startedAt present", parsed.startedAt === task.startedAt);
    check(
      "M1a: lastActivitySecAgo is a number or null",
      parsed.lastActivitySecAgo === null ||
        typeof parsed.lastActivitySecAgo === "number"
    );
    check("M1a: streamBytes present", parsed.streamBytes === 1234);
    check("M1a: toolCallsCount present", parsed.toolCallsCount === 3);
  }

  tasks.delete(task.id);
}

// ---------------------------------------------------------------------------
// M1b: Memory-path SUCCESS — done + !isError → 200 + JSON (regression)
// ---------------------------------------------------------------------------
console.log("\n[M1b] Memory-path success: done+!isError → 200 + JSON (regression)");
{
  const now = Date.now();
  const task = {
    id: "task_m1b_ok",
    sessionId: "m1b",
    cwd: TMP_STATE,
    createdAt: now - 120_000,
    startedAt: now - 110_000,
    finishedAt: now - 10_000,
    lastActivityAt: now - 10_000,
    status: "completed",
    done: true,
    isError: false,
    reasoningEffort: "medium",
    streamBytes: 5678,
    streamTail: "done",
    fileOps: [{ path: "/tmp/x", op: "write" }],
    toolCallsCount: 7,
    result: {
      isError: false,
      text: "Task completed successfully.",
      toolCalls: 7,
    },
  };
  tasks.set(task.id, task);

  const res = await httpGet(PORT, `/task/${task.id}/wait`);
  check("M1b: status is 200", res.status === 200, `got ${res.status}`);
  check(
    "M1b: Content-Type is application/json",
    (res.headers["content-type"] || "").includes("application/json"),
    `got ${res.headers["content-type"]}`
  );
  check(
    "M1b: Connection header is close",
    (res.headers["connection"] || "").toLowerCase() === "close",
    `got ${res.headers["connection"]}`
  );
  check("M1b: socket closed after body", res.socketClosed === true);

  let parsed;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    parsed = null;
  }
  check("M1b: body is valid JSON", parsed !== null, res.body.slice(0, 100));
  if (parsed) {
    check("M1b: found is true", parsed.found === true);
    check("M1b: isError is false", parsed.isError === false);
    check("M1b: done is true", parsed.done === true);
    check("M1b: status is completed", parsed.status === "completed");
    check(
      "M1b: result.text preserved",
      parsed.result?.text === "Task completed successfully."
    );
    check("M1b: fileOps present", Array.isArray(parsed.fileOps));
  }

  tasks.delete(task.id);
}

// ---------------------------------------------------------------------------
// M1c: Disk-poll path FAILURE — task on disk, done+isError → 200 + JSON
// ---------------------------------------------------------------------------
console.log("\n[M1c] Disk-poll path failure: done+isError → 200 + JSON");
{
  const now = Date.now();
  const taskId = "task_m1c_disk_fail";
  const diskTask = {
    id: taskId,
    sessionId: "m1c",
    cwd: TMP_STATE,
    createdAt: now - 60_000,
    startedAt: now - 50_000,
    finishedAt: now - 10_000,
    lastHeartbeatAt: now - 10_000,
    status: "failed",
    done: true,
    isError: true,
    reasoningEffort: null,
    fileOps: [],
    toolCallsCount: 1,
    result: {
      isError: true,
      text: "Worker process exited unexpectedly.",
      toolCalls: 1,
      errors: ["WORKER_PROCESS_TERMINATED"],
    },
    stderr: "",
  };
  // Write the task file to the isolated TASK_DIR.
  const TASK_DIR = path.join(TMP_STATE, "tasks");
  fs.mkdirSync(TASK_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(TASK_DIR, `${taskId}.json`),
    JSON.stringify(diskTask, null, 2),
    "utf8"
  );

  // The task is NOT in the in-memory Map, so the wait handler will
  // find it on disk. Since it's already done, it responds immediately
  // (no polling needed).
  const res = await httpGet(PORT, `/task/${taskId}/wait`);
  check("M1c: status is 200 (not 500)", res.status === 200, `got ${res.status}`);
  check(
    "M1c: Content-Type is application/json",
    (res.headers["content-type"] || "").includes("application/json"),
    `got ${res.headers["content-type"]}`
  );
  check(
    "M1c: Connection header is close",
    (res.headers["connection"] || "").toLowerCase() === "close",
    `got ${res.headers["connection"]}`
  );
  check("M1c: socket closed after body", res.socketClosed === true);

  let parsed;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    parsed = null;
  }
  check("M1c: body is valid JSON", parsed !== null, res.body.slice(0, 100));
  if (parsed) {
    check("M1c: found is true", parsed.found === true);
    check("M1c: id matches", parsed.id === taskId, `got ${parsed.id}`);
    check("M1c: isError is true", parsed.isError === true);
    check("M1c: done is true", parsed.done === true);
    check("M1c: status is failed", parsed.status === "failed", `got ${parsed.status}`);
    check(
      "M1c: result.isError is true",
      parsed.result?.isError === true
    );
    check(
      "M1c: result.text preserved",
      parsed.result?.text === "Worker process exited unexpectedly."
    );
  }

  // Clean up the disk file.
  fs.unlinkSync(path.join(TASK_DIR, `${taskId}.json`));
}

// ---------------------------------------------------------------------------
// M1d: Disk-poll path SUCCESS — task on disk, done+!isError → 200 + JSON
// ---------------------------------------------------------------------------
console.log("\n[M1d] Disk-poll path success: done+!isError → 200 + JSON");
{
  const now = Date.now();
  const taskId = "task_m1d_disk_ok";
  const diskTask = {
    id: taskId,
    sessionId: "m1d",
    cwd: TMP_STATE,
    createdAt: now - 120_000,
    startedAt: now - 110_000,
    finishedAt: now - 10_000,
    lastHeartbeatAt: now - 10_000,
    status: "completed",
    done: true,
    isError: false,
    reasoningEffort: "low",
    fileOps: [],
    toolCallsCount: 2,
    result: {
      isError: false,
      text: "All done.",
      toolCalls: 2,
    },
    stderr: "",
  };
  const TASK_DIR = path.join(TMP_STATE, "tasks");
  fs.mkdirSync(TASK_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(TASK_DIR, `${taskId}.json`),
    JSON.stringify(diskTask, null, 2),
    "utf8"
  );

  const res = await httpGet(PORT, `/task/${taskId}/wait`);
  check("M1d: status is 200", res.status === 200, `got ${res.status}`);
  check(
    "M1d: Content-Type is application/json",
    (res.headers["content-type"] || "").includes("application/json"),
    `got ${res.headers["content-type"]}`
  );
  check(
    "M1d: Connection header is close",
    (res.headers["connection"] || "").toLowerCase() === "close",
    `got ${res.headers["connection"]}`
  );
  check("M1d: socket closed after body", res.socketClosed === true);

  let parsed;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    parsed = null;
  }
  check("M1d: body is valid JSON", parsed !== null, res.body.slice(0, 100));
  if (parsed) {
    check("M1d: found is true", parsed.found === true);
    check("M1d: isError is false", parsed.isError === false);
    check("M1d: done is true", parsed.done === true);
    check("M1d: status is completed", parsed.status === "completed");
    check("M1d: result.text preserved", parsed.result?.text === "All done.");
  }

  fs.unlinkSync(path.join(TASK_DIR, `${taskId}.json`));
}

// ---------------------------------------------------------------------------
// M1e: notifyWaiters — in-flight waiters get 200 + JSON (not 500 + markdown)
// ---------------------------------------------------------------------------
console.log("\n[M1e] notifyWaiters: in-flight waiters get 200 + JSON");
{
  const now = Date.now();
  const task = {
    id: "task_m1e_notify",
    sessionId: "m1e",
    cwd: TMP_STATE,
    createdAt: now - 60_000,
    startedAt: now - 50_000,
    finishedAt: now,
    lastActivityAt: now,
    status: "failed",
    done: true,
    isError: true,
    reasoningEffort: null,
    streamBytes: 0,
    streamTail: "",
    fileOps: [],
    toolCallsCount: 0,
    result: {
      isError: true,
      text: "Cancelled by caller.",
      toolCalls: 0,
    },
  };
  tasks.set(task.id, task);

  // Create a fake res object to capture what notifyWaiters writes.
  const written = {};
  const fakeRes = {
    writeHead: (status, headers) => {
      written.status = status;
      written.headers = headers;
    },
    end: (body) => {
      written.body = body;
    },
  };
  task.waiters = [fakeRes];

  notifyWaiters(task);

  check(
    "M1e: notifyWaiters writes 200 (not 500)",
    written.status === 200,
    `got ${written.status}`
  );
  check(
    "M1e: Content-Type is application/json",
    (written.headers?.["Content-Type"] || "").includes("application/json"),
    `got ${written.headers?.["Content-Type"]}`
  );
  check(
    "M1e: Connection is close",
    (written.headers?.["Connection"] || "").toLowerCase() === "close",
    `got ${written.headers?.["Connection"]}`
  );
  let parsed;
  try {
    parsed = JSON.parse(written.body);
  } catch {
    parsed = null;
  }
  check("M1e: body is valid JSON", parsed !== null, written.body?.slice(0, 100));
  if (parsed) {
    check("M1e: isError is true", parsed.isError === true);
    check("M1e: status is failed", parsed.status === "failed");
    check("M1e: result.text preserved", parsed.result?.text === "Cancelled by caller.");
  }

  tasks.delete(task.id);
}

// ---------------------------------------------------------------------------
// M1f: 404 not-found path is unchanged
// ---------------------------------------------------------------------------
console.log("\n[M1f] 404 not-found path unchanged");
{
  const res = await httpGet(PORT, `/task/nonexistent_task_xyz/wait`);
  check("M1f: status is 404", res.status === 404, `got ${res.status}`);
  check(
    "M1f: body mentions not found",
    /not found/i.test(res.body),
    res.body.slice(0, 80)
  );
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
await new Promise((resolve) => {
  try {
    statusHttpServer.close(resolve);
  } catch {
    resolve();
  }
});
fs.rmSync(TMP_STATE, { recursive: true, force: true });

console.log("\n==========================================");
console.log(`Wait-Endpoint Completed: ${passed} PASSED, ${failed} FAILED`);
console.log("==========================================");
process.exit(failed === 0 ? 0 : 1);
