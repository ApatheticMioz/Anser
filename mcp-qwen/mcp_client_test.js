// Standalone MCP client test harness: connects to qwen38-local over stdio
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function main() {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["D:/LLM_Ecosystem/mcp-qwen/index.js"],
  });
  const client = new Client({ name: "test-harness", version: "1.0.0" });
  await client.connect(transport);

  const tools = await client.listTools();
  console.log("=== registered tools ===");
  console.log(tools.tools.map((t) => t.name).join(", "));
  console.log("Registered tool count:", tools.tools.length);

  const scenario = process.argv[2] ?? "list";

  if (scenario === "server_status") {
    console.log("\n=== checking qwen_server status ===");
    const res = await client.callTool({
      name: "qwen_server",
      arguments: { action: "status" },
    });
    console.log("Result:", res.content[0].text);
  } else if (scenario === "coworker_test") {
    console.log("\n=== calling qwen_coworker ===");
    const res = await client.callTool({
      name: "qwen_coworker",
      arguments: {
        prompt: "Say hello and return immediately.",
      },
    });
    console.log("isError:", res.isError);
    console.log("Response:", res.content[0].text);
  } else if (scenario === "list_tasks") {
    console.log("\n=== calling qwen_list_active_tasks ===");
    const res = await client.callTool({
      name: "qwen_list_active_tasks",
      arguments: {},
    });
    console.log("Result:", res.content[0].text);
  }

  await client.close();
  process.exit(0);
}

main().catch((e) => {
  console.error("HARNESS FAILURE:", e);
  process.exit(1);
});
