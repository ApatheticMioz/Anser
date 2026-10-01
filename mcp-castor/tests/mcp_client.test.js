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
// C:\Users\<user>\.qwen state. (The established isolation pattern, applied to
// the child's env.)
const TMP_STATE = fs.mkdtempSync(path.join(os.tmpdir(), "fx7_mcp_client_state_"));
const ISOLATED_ENV = {
  ...process.env,
  CASTOR_STATE_DIR: TMP_STATE,
  QWEN_STATE_DIR: TMP_STATE,
  QWEN_WSL_HOME: TMP_STATE,
  QWEN_WIN_HOME: TMP_STATE,
  HOME: TMP_STATE,
};

async function main() {
  // P11: live-engine test — skip honestly when the engine is down.
  await requireEngineOrSkip("mcp_client");

  const transport = new StdioClientTransport({
    command: "node",
    args: [scriptPath],
    env: ISOLATED_ENV,
  });
  const client = new Client({ name: "test-harness", version: "1.0.0" });
  await client.connect(transport);

  const tools = await client.listTools();
  console.log("=== registered tools ===");
  console.log(tools.tools.map((t) => t.name).join(", "));
  console.log("Registered tool count:", tools.tools.length);

  // Real assertion (M0b 3/4): the MCP surface must expose the three consolidated
  // tools.
  const toolNames = tools.tools.map((t) => t.name);
  const coworkerTool = toolNames.find((t) => t.endsWith("_coworker") || t === "coworker");
  const taskTool = toolNames.find((t) => t.endsWith("_task") || t === "task");
  const serverTool = toolNames.find((t) => t.endsWith("_server") || t === "server");

  assert.ok(coworkerTool, `MCP server must register coworker tool (got: ${JSON.stringify(toolNames)})`);
  assert.ok(taskTool, `MCP server must register task tool (got: ${JSON.stringify(toolNames)})`);
  assert.ok(serverTool, `MCP server must register server tool (got: ${JSON.stringify(toolNames)})`);

  const scenario = process.argv[2] ?? "list";

  if (scenario === "server_status") {
    console.log(`\n=== checking ${serverTool} status ===`);
    const res = await client.callTool({
      name: serverTool,
      arguments: { action: "status" },
    });
    console.log("Result:", res.content[0].text);
    // Real assertion: a status query must not error (the status branch returns
    // success-by-omission — no isError field — so "not an error" is the honest
    // check), and must return a non-empty status payload.
    assert.ok(!res.isError, `${serverTool} status must not error`);
    assert.ok(
      res.content[0].text.trim().length > 0,
      `${serverTool} status must return a non-empty payload`
    );
  } else if (scenario === "coworker_test") {
    console.log(`\n=== calling ${coworkerTool} ===`);
    const res = await client.callTool({
      name: coworkerTool,
      arguments: {
        prompt: "Say hello and return immediately.",
      },
    });
    console.log("isError:", res.isError);
    console.log("Response:", res.content[0].text);
    // Real assertion: a coworker dispatch must complete without error and
    // produce a non-empty deliverable (catches the F4-class false-failure).
    assert.strictEqual(res.isError, false, `${coworkerTool} must complete without error`);
    assert.ok(
      res.content[0].text.trim().length > 0,
      `${coworkerTool} must return a non-empty deliverable`
    );
  } else if (scenario === "task_list") {
    console.log(`\n=== calling ${taskTool} (list) ===`);
    const res = await client.callTool({
      name: taskTool,
      arguments: { action: "list" },
    });
    console.log("Result:", res.content[0].text);
    // Real assertion: the list must not error (success-by-omission) and must be
    // parseable JSON carrying a tasks array (the task list contract), not
    // an opaque string.
    assert.ok(!res.isError, `${taskTool} list must not error`);
    const parsed = JSON.parse(res.content[0].text);
    assert.ok(Array.isArray(parsed.tasks), `${taskTool} list must return a tasks array`);
  }

  await client.close();
  process.exit(0);
}

main().catch((e) => {
  console.error("HARNESS FAILURE:", e);
  process.exit(1);
});
