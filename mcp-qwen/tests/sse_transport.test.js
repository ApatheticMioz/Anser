#!/usr/bin/env node
/**
 * sse_transport.test.js — Comprehensive & Adversarial MCP SSE Transport Suite.
 *
 * Exercises the native Server-Sent Events (SSE) endpoint on statusHttpServer
 * (port 18021) using the official @modelcontextprotocol/sdk client and server
 * transports.
 *
 * Vectors:
 *   [1] Happy Path: SSE connect, handshake, tool discovery, tool call execution.
 *   [2] Adversarial: Missing sessionId on POST -> HTTP 400.
 *   [3] Adversarial: Nonexistent sessionId on POST -> HTTP 404.
 *   [4] Adversarial: Malformed / non-JSON payload on POST -> HTTP 400, no server crash.
 *   [5] Adversarial: Abrupt socket destruction -> session unlinked, no leak.
 *   [6] Adversarial: Concurrency burst (10 simultaneous clients) -> all succeed independently.
 *   [7] Protocol: CORS preflight (OPTIONS) -> HTTP 204 + allow headers.
 *   [8] Health: /health reports sse:true and active session gauges.
 *
 * Fully offline: no live GPU / vLLM needed.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import assert from "node:assert";

// Isolate test state in private temp directory
const TMP_STATE = fs.mkdtempSync(path.join(os.tmpdir(), "sse_test_"));
process.env.QWEN_STATE_DIR = TMP_STATE;
process.env.HOME = TMP_STATE;
process.env.QWEN_WSL_HOME = TMP_STATE;
process.env.QWEN_WIN_HOME = TMP_STATE;

let TEST_PORT = 0;

// Import after env setup
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { SSEClientTransport } = await import("@modelcontextprotocol/sdk/client/sse.js");
const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
const {
  statusHttpServer,
  setMcpServerFactory,
  activeSseSessions,
} = await import("../src/task_registry.js");
const { registerTools } = await import("../src/tools.js");

let passed = 0;
let failed = 0;

function check(name, cond, detail = "") {
  if (cond) {
    console.log(`  [PASS] ${name}`);
    passed++;
  } else {
    console.error(`  [FAIL] ${name}${detail ? ` (${detail})` : ""}`);
    failed++;
  }
}

function createTestMcpServer() {
  const server = new McpServer({
    name: "mcp-anser-test",
    version: "5.2.0",
  });
  registerTools(server);
  return server;
}

// Hard watchdog: 45s cap
const watchdog = setTimeout(() => {
  console.error(`\nHARD WATCHDOG fired in sse_transport.test.js (failures=${failed})`);
  process.exit(1);
}, 45_000);
watchdog.unref();

async function runSuite() {
  console.log("=== MCP SSE Transport & Adversarial Stress Suite ===\n");

  setMcpServerFactory(createTestMcpServer);

  await new Promise((resolve, reject) => {
    const onErr = (err) => {
      console.error("statusHttpServer listen error:", err);
      reject(err);
    };
    statusHttpServer.once("error", onErr);
    statusHttpServer.listen(0, "127.0.0.1", () => {
      statusHttpServer.removeListener("error", onErr);
      TEST_PORT = statusHttpServer.address().port;
      process.env.STATUS_PORT = String(TEST_PORT);
      resolve();
    });
  });

  try {
    // -------------------------------------------------------------------------
    // Test 1: Happy Path Handshake, Discovery, and Tool Execution
    // -------------------------------------------------------------------------
    console.log("[Test 1] Happy Path: SSE Handshake, Tool Listing & Execution");
    {
      const client = new Client(
        { name: "test-client-1", version: "1.0.0" },
        { capabilities: {} }
      );
      const transport = new SSEClientTransport(
        new URL(`http://127.0.0.1:${TEST_PORT}/sse`)
      );

      await client.connect(transport);
      check("client connected via SSE", true);
      check("activeSseSessions tracked", activeSseSessions.size === 1);

      const toolList = await client.listTools();
      const toolNames = toolList.tools.map((t) => t.name).sort();
      check(
        "discovered all 3 tools via SSE",
        toolNames.includes("qwen_coworker") &&
          toolNames.includes("qwen_task") &&
          toolNames.includes("qwen_server"),
        `got: ${toolNames.join(", ")}`
      );

      // Call qwen_task: list
      const taskListRes = await client.callTool({
        name: "qwen_task",
        arguments: { action: "list" },
      });
      check(
        "qwen_task list executed over SSE",
        !taskListRes.isError && Array.isArray(taskListRes.content)
      );

      // Call qwen_server: status
      const serverStatusRes = await client.callTool({
        name: "qwen_server",
        arguments: { action: "status" },
      });
      check(
        "qwen_server status executed over SSE",
        Array.isArray(serverStatusRes.content)
      );

      await client.close();
      // Allow async session close to settle
      await new Promise((r) => setTimeout(r, 100));
      check("session removed on clean client close", activeSseSessions.size === 0);
    }

    // -------------------------------------------------------------------------
    // Test 2: Adversarial — Missing / Invalid Session IDs on POST /message
    // -------------------------------------------------------------------------
    console.log("\n[Test 2] Adversarial: Missing & Invalid Session IDs");
    {
      // Missing sessionId
      const res1 = await fetch(`http://127.0.0.1:${TEST_PORT}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      });
      check("missing sessionId returns HTTP 400", res1.status === 400);
      const b1 = await res1.json();
      check("error body names missing sessionId", /Missing sessionId/.test(b1.error));

      // Nonexistent sessionId
      const res2 = await fetch(
        `http://127.0.0.1:${TEST_PORT}/message?sessionId=nonexistent-uuid-999`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }),
        }
      );
      check("nonexistent sessionId returns HTTP 404", res2.status === 404);
      const b2 = await res2.json();
      check("error body names session not found", /Session not found/.test(b2.error));
    }

    // -------------------------------------------------------------------------
    // Test 3: Adversarial — Malformed / Non-JSON Payloads on Active Session
    // -------------------------------------------------------------------------
    console.log("\n[Test 3] Adversarial: Malformed & Garbage Payloads");
    {
      const client = new Client(
        { name: "test-client-3", version: "1.0.0" },
        { capabilities: {} }
      );
      const transport = new SSEClientTransport(
        new URL(`http://127.0.0.1:${TEST_PORT}/sse`)
      );
      await client.connect(transport);

      const activeId = Array.from(activeSseSessions.keys())[0];
      check("got active sessionId for injection test", Boolean(activeId));

      // Send raw garbage (not json)
      const resGarbage = await fetch(
        `http://127.0.0.1:${TEST_PORT}/message?sessionId=${activeId}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "THIS_IS_DEFINITELY_NOT_JSON{{{",
        }
      );
      check("garbage body returns HTTP 400", resGarbage.status === 400);

      // Verify server is STILL alive and client is functional
      const ping = await client.listTools();
      check("server and client survive garbage injection intact", ping.tools.length > 0);

      await client.close();
      await new Promise((r) => setTimeout(r, 100));
    }

    // -------------------------------------------------------------------------
    // Test 4: Adversarial — Abrupt Socket Destruction Mid-Stream
    // -------------------------------------------------------------------------
    console.log("\n[Test 4] Adversarial: Abrupt Socket Destruction");
    {
      const initialCount = activeSseSessions.size;
      await new Promise((resolve) => {
        const req = http.get(`http://127.0.0.1:${TEST_PORT}/sse`, (res) => {
          // Once headers are received and session is open, destroy socket abruptly
          setTimeout(() => {
            req.destroy();
            resolve();
          }, 50);
        });
      });

      // Allow close event to flush
      await new Promise((r) => setTimeout(r, 200));
      check(
        "abrupt socket drop reaped from activeSseSessions",
        activeSseSessions.size === initialCount
      );
    }

    // -------------------------------------------------------------------------
    // Test 5: Adversarial — Concurrency Burst (10 Simultaneous Clients)
    // -------------------------------------------------------------------------
    console.log("\n[Test 5] Adversarial: Concurrency Burst (10 Simultaneous Clients)");
    {
      const CLIENT_COUNT = 10;
      const clients = [];

      for (let i = 0; i < CLIENT_COUNT; i++) {
        const c = new Client(
          { name: `burst-client-${i}`, version: "1.0.0" },
          { capabilities: {} }
        );
        const t = new SSEClientTransport(
          new URL(`http://127.0.0.1:${TEST_PORT}/sse`)
        );
        clients.push({ client: c, transport: t });
      }

      // Connect all in parallel
      await Promise.all(clients.map(({ client, transport }) => client.connect(transport)));
      check(`all ${CLIENT_COUNT} clients connected concurrently`, activeSseSessions.size === CLIENT_COUNT);

      // Issue parallel tool calls across all 10 clients
      const results = await Promise.all(
        clients.map(({ client }) =>
          client.callTool({ name: "qwen_task", arguments: { action: "list" } })
        )
      );
      const allSuccess = results.every((r) => !r.isError && Array.isArray(r.content));
      check(`all ${CLIENT_COUNT} concurrent tool calls succeeded`, allSuccess);

      // Disconnect all in parallel
      await Promise.all(clients.map(({ client }) => client.close()));
      await new Promise((r) => setTimeout(r, 200));
      check(
        `all ${CLIENT_COUNT} sessions reaped after burst disconnect`,
        activeSseSessions.size === 0
      );
    }

    // -------------------------------------------------------------------------
    // Test 6: CORS & Preflight (OPTIONS)
    // -------------------------------------------------------------------------
    console.log("\n[Test 6] Protocol: CORS Preflight & Health Verification");
    {
      const optionsRes = await fetch(`http://127.0.0.1:${TEST_PORT}/sse`, {
        method: "OPTIONS",
      });
      check("OPTIONS preflight returns HTTP 204", optionsRes.status === 204);
      check(
        "CORS allow-origin is *",
        optionsRes.headers.get("access-control-allow-origin") === "*"
      );

      const healthRes = await fetch(`http://127.0.0.1:${TEST_PORT}/health`);
      const health = await healthRes.json();
      check("health endpoint reports sse: true", health.sse === true);
      check(
        "health endpoint reports active_sse_sessions count",
        typeof health.active_sse_sessions === "number"
      );
    }

    // -------------------------------------------------------------------------
    // Summary
    // -------------------------------------------------------------------------
    console.log("\n==========================================");
    console.log(`SSE Transport Tests: ${passed} PASSED, ${failed} FAILED`);
    console.log("==========================================");
  } finally {
    await new Promise((r) => statusHttpServer.close(r));
    try {
      fs.rmSync(TMP_STATE, { recursive: true, force: true });
    } catch {}
  }

  if (failed > 0) {
    process.exit(1);
  }
}

runSuite().catch((err) => {
  console.error("FATAL in sse_transport.test.js:", err);
  process.exit(1);
});
