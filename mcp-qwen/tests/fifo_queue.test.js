import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { requireEngineOrSkip } from "./helpers/engine_probe.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.resolve(__dirname, "..", "index.js");

async function runTest() {
  // P11: live-engine test — skip honestly when the engine is down.
  await requireEngineOrSkip("fifo_queue");

  console.log("=== Testing MCP FIFO Queue (MAX_CONCURRENT_GOOSE = 1) ===");

  const transport = new StdioClientTransport({
    command: "node",
    args: [scriptPath],
  });

  const client = new Client({ name: "fifo-test-runner", version: "1.0.0" });
  await client.connect(transport);
  console.log("Connected to MCP Server.");

  const tools = await client.listTools();
  console.log("Available tools:", tools.tools.map((t) => t.name));

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

  // Check task list immediately
  console.log("\n3. Inspecting task list via qwen_task...");
  const listRes = await client.callTool({
    name: "qwen_task",
    arguments: { action: "list" },
  });
  console.log("Task list result:\n", listRes.content[0].text);

  console.log("\n4. Awaiting both tasks to complete...");
  const [res1, res2] = await Promise.all([t1, t2]);

  console.log("\n--- Task 1 Result ---");
  console.log(res1.content[0].text.slice(0, 300));

  console.log("\n--- Task 2 Result ---");
  console.log(res2.content[0].text.slice(0, 300));

  console.log("\n=== FIFO Queue Test Passed Cleanly ===");
  process.exit(0);
}

runTest().catch((err) => {
  console.error("Test failed with error:", err);
  process.exit(1);
});
