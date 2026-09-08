import assert from "node:assert";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { requireEngineOrSkip } from "./helpers/engine_probe.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.resolve(__dirname, "..", "index.js");

// F9 (state isolation): the spawned index.js child imports config.js
// (QWEN_STATE_DIR) and task_registry.js (writes task JSON / session logs /
// slot leases under QWEN_STATE_DIR). Redirect the child's state dir to a fresh
// temp dir so the live MCP server never writes to the production
// C:\Users\Apath\.qwen state.
const TMP_STATE = fs.mkdtempSync(path.join(os.tmpdir(), "fx7_fifo_state_"));
const ISOLATED_ENV = {
  ...process.env,
  QWEN_STATE_DIR: TMP_STATE,
  QWEN_WSL_HOME: TMP_STATE,
  QWEN_WIN_HOME: TMP_STATE,
  HOME: TMP_STATE,
};

async function runTest() {
  // P11: live-engine test — skip honestly when the engine is down.
  await requireEngineOrSkip("fifo_queue");

  console.log("=== Testing MCP FIFO Queue (MAX_CONCURRENT_GOOSE = 1) ===");

  const transport = new StdioClientTransport({
    command: "node",
    args: [scriptPath],
    env: ISOLATED_ENV,
  });

  const client = new Client({ name: "fifo-test-runner", version: "1.0.0" });
  await client.connect(transport);
  console.log("Connected to MCP Server.");

  const tools = await client.listTools();
  console.log("Available tools:", tools.tools.map((t) => t.name));
  // Real assertion: the coworker tool must be registered (a regression that
  // drops it from the MCP surface would fail here, not just log).
  assert.ok(
    tools.tools.some((t) => t.name === "qwen_coworker"),
    "qwen_coworker must be a registered tool"
  );

  // Dispatch fast task 1
  console.log("\n1. Dispatching Task 1...");
  const t1 = client.callTool({
    name: "qwen_coworker",
    arguments: {
      prompt: "Reply with exactly: 'Task 1 done'",
      session_id: "fifo_test_1",
      cwd: "D:/LLM_Ecosystem",
    },
  });

  // Short delay to let task 1 enter execution
  await new Promise((r) => setTimeout(r, 200));

  // Dispatch fast task 2
  console.log("2. Dispatching Task 2 while Task 1 is active...");
  const t2 = client.callTool({
    name: "qwen_coworker",
    arguments: {
      prompt: "Reply with exactly: 'Task 2 done'",
      session_id: "fifo_test_2",
      cwd: "D:/LLM_Ecosystem",
    },
  });

  // Check task list immediately (both tasks should be present in the queue).
  console.log("\n3. Inspecting task list via qwen_task...");
  const listRes = await client.callTool({
    name: "qwen_task",
    arguments: { action: "list" },
  });
  console.log("Task list result:\n", listRes.content[0].text);
  // Real assertion: the list must be parseable JSON and contain BOTH dispatched
  // sessions (proves the FIFO queue actually queued both, not just one).
  const listed = JSON.parse(listRes.content[0].text);
  const listedIds = (listed.tasks || []).map((t) => t.sessionId);
  assert.ok(
    listedIds.includes("fifo_test_1") && listedIds.includes("fifo_test_2"),
    `qwen_task list must contain both dispatched sessions (got: ${JSON.stringify(listedIds)})`
  );

  console.log("\n4. Awaiting both tasks to complete...");
  const [res1, res2] = await Promise.all([t1, t2]);

  console.log("\n--- Task 1 Result ---");
  console.log(res1.content[0].text.slice(0, 300));

  console.log("\n--- Task 2 Result ---");
  console.log(res2.content[0].text.slice(0, 300));

  // Real behavioral assertions (M0b 3/4): the old body only logged the results
  // and exited 0, so it could NEVER fail — a completed task flipped to
  // isError:true (the F4-class false-failure) or a missing deliverable would
  // pass silently. These assertions catch that regression:
  //   (a) both tasks report isError === false (a clean completion, not a
  //       fabricated failure), and
  //   (b) each task's text carries its expected deliverable marker.
  assert.strictEqual(res1.isError, false, "Task 1 must complete without error");
  assert.strictEqual(res2.isError, false, "Task 2 must complete without error");
  assert.ok(
    res1.content[0].text.includes("Task 1 done"),
    `Task 1 must deliver its marker (got: ${JSON.stringify(res1.content[0].text.slice(0, 120))})`
  );
  assert.ok(
    res2.content[0].text.includes("Task 2 done"),
    `Task 2 must deliver its marker (got: ${JSON.stringify(res2.content[0].text.slice(0, 120))})`
  );

  console.log("\n=== FIFO Queue Test Passed Cleanly ===");
  process.exit(0);
}

runTest().catch((err) => {
  console.error("Test failed with error:", err);
  process.exit(1);
});
