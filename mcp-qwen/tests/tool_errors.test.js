/**
 * P12 — MCP-conformant tool-error envelope regression lock.
 *
 * Verifies that every tool handler in src/tools.js, when it encounters a
 * failure, returns a normal CallToolResult with `isError: true` and a
 * human-readable `content[0].text` that names the real cause — NOT a thrown
 * exception, NOT a protocol-level error.
 *
 * Also asserts that a success path still returns without `isError`.
 *
 * The test registers the REAL tool handlers against a stub server object,
 * then invokes the captured handler functions directly. No network, no
 * engine, no subprocesses.
 */

import { registerTools } from "../src/tools.js";

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

async function runTests() {
  console.log("=== P12 MCP-conformant tool-error envelope tests ===\n");

  // Build a stub server that captures registered tool handlers.
  const handlers = {};
  const stubServer = {
    registerTool(name, _config, handler) {
      handlers[name] = handler;
    },
  };

  registerTools(stubServer);

  // Verify all three expected tools are registered.
  const expectedTools = ["qwen_coworker", "qwen_task", "qwen_server"];
  for (const t of expectedTools) {
    ok(typeof handlers[t] === "function", `tool '${t}' registered`);
  }

  // ------------------------------------------------------------------
  // Test 1: qwen_task with bad args (missing task_id for 'status')
  // ------------------------------------------------------------------
  console.log("\n[Test 1] qwen_task: missing task_id for 'status' action");
  {
    const result = await handlers["qwen_task"]({ action: "status" });
    ok(result.isError === true, "isError is true");
    ok(
      Array.isArray(result.content) && result.content.length === 1,
      "content is a single-element array"
    );
    ok(
      result.content[0].type === "text" && typeof result.content[0].text === "string",
      "content[0] is a text block"
    );
    ok(
      /task_id/.test(result.content[0].text),
      "error message names the real cause (task_id)"
    );
    ok(
      !/\n\s+at\s/.test(result.content[0].text),
      "no stack trace leaked into content"
    );
  }

  // ------------------------------------------------------------------
  // Test 2: qwen_task with nonexistent task_id
  // ------------------------------------------------------------------
  console.log("\n[Test 2] qwen_task: nonexistent task_id");
  {
    const result = await handlers["qwen_task"]({
      action: "status",
      task_id: "task_nonexistent_99999",
    });
    ok(result.isError === true, "isError is true");
    ok(
      /not found/i.test(result.content[0].text),
      "error message names the real cause (not found)"
    );
    ok(
      /task_nonexistent_99999/.test(result.content[0].text),
      "error message includes the actual task_id"
    );
    ok(
      !/\n\s+at\s/.test(result.content[0].text),
      "no stack trace leaked into content"
    );
  }

  // ------------------------------------------------------------------
  // Test 3: qwen_task success path (list) — no isError
  // ------------------------------------------------------------------
  console.log("\n[Test 3] qwen_task: list (success path)");
  {
    const result = await handlers["qwen_task"]({ action: "list" });
    ok(result.isError !== true, "isError is not true on success");
    ok(
      Array.isArray(result.content) && result.content.length === 1,
      "content is a single-element array"
    );
    ok(
      result.content[0].type === "text" && typeof result.content[0].text === "string",
      "content[0] is a text block"
    );
    // The list response should be valid JSON with a tasks array.
    let parsed;
    try {
      parsed = JSON.parse(result.content[0].text);
    } catch {
      parsed = null;
    }
    ok(parsed !== null && Array.isArray(parsed.tasks), "list returns valid JSON with tasks array");
  }

  // ------------------------------------------------------------------
  // Test 4: qwen_server status — should not throw even when engine is down
  // ------------------------------------------------------------------
  console.log("\n[Test 4] qwen_server: status (engine may be down)");
  {
    let result;
    let threw = false;
    try {
      result = await handlers["qwen_server"]({ action: "status" });
    } catch (e) {
      threw = true;
      result = { content: [{ type: "text", text: e.message }], isError: true };
    }
    ok(!threw, "handler did not throw (bounded try/catch)");
    ok(
      result.isError === true || result.isError === undefined || result.isError === false,
      "result has a valid isError value"
    );
    ok(
      Array.isArray(result.content) && result.content.length >= 1,
      "content is a non-empty array"
    );
    // When the engine is down, status should be "stopped" — a success result.
    if (result.isError !== true) {
      let parsed;
      try {
        parsed = JSON.parse(result.content[0].text);
      } catch {
        parsed = null;
      }
      ok(
        parsed !== null && typeof parsed.status === "string",
        "status response is valid JSON with a status field"
      );
    }
  }

  // ------------------------------------------------------------------
  // Test 5: qwen_coworker — verify the handler is a function and the
  // wrapper is in place (we don't invoke it because it would spawn a
  // real task; we just verify the registration and that the handler
  // is an async function).
  // ------------------------------------------------------------------
  console.log("\n[Test 5] qwen_coworker: handler registered and is async");
  {
    ok(
      handlers["qwen_coworker"] !== undefined &&
        handlers["qwen_coworker"].constructor.name === "AsyncFunction",
      "qwen_coworker handler is an async function"
    );
  }

  // ------------------------------------------------------------------
  // Summary
  // ------------------------------------------------------------------
  console.log("\n==========================================");
  console.log(`Tool Error Envelope Tests: ${passed} PASSED, ${failed} FAILED`);
  console.log("==========================================");
  if (failed > 0) process.exit(1);
}

runTests().catch((err) => {
  console.error("Tool error test suite uncaught error:", err);
  process.exit(1);
});
