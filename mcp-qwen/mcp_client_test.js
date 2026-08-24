// Standalone MCP client harness: connects to the qwen38-local MCP server over
// stdio exactly like Claude Code would, and calls delegate_coding_task through
// the real protocol layer (schema validation included) - not a shortcut that
// calls the server's internal functions directly.
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

  const scenario = process.argv[2] ?? "success";

  if (scenario === "success") {
    console.log("\n=== calling delegate_coding_task (should succeed) ===");
    const result = await client.callTool({
      name: "delegate_coding_task",
      arguments: {
        cwd: "C:\\Users\\Apath\\AppData\\Local\\Temp\\qwen_worker_test",
        task:
          "Create a file called divider.py defining a function safe_divide(a, b) that " +
          "returns a/b, raising ZeroDivisionError with message 'cannot divide by zero' " +
          "if b is 0. Add a __main__ block that prints safe_divide(10, 2) and then " +
          "catches and prints 'caught: <message>' for safe_divide(1, 0). Run the " +
          "script yourself to confirm both lines print correctly before finishing.",
      },
    }, undefined, { timeout: 280_000 });
    console.log("isError:", result.isError);
    console.log(result.content[0].text);
  } else if (scenario === "malformed") {
    console.log("\n=== calling delegate_coding_task with MISSING required field (should be rejected by schema, not crash) ===");
    try {
      const result = await client.callTool({
        name: "delegate_coding_task",
        arguments: { task: "no cwd provided" },
      });
      console.log("isError:", result.isError);
      console.log(JSON.stringify(result).slice(0, 500));
    } catch (e) {
      console.log("Rejected as expected:", e.message);
    }
  } else if (scenario === "extensions") {
    console.log("\n=== calling delegate_coding_task WITH a real MCP extension attached ===");
    const result = await client.callTool({
      name: "delegate_coding_task",
      arguments: {
        cwd: "C:\\Users\\Apath\\AppData\\Local\\Temp\\qwen_worker_test\\goose_test",
        task: "Using your filesystem MCP tools specifically (not your shell tool), list the files in the current directory and report their exact names.",
        extensions: ["npx -y @modelcontextprotocol/server-filesystem C:\\Users\\Apath\\AppData\\Local\\Temp\\qwen_worker_test\\goose_test"],
      },
    }, undefined, { timeout: 280_000 });
    console.log("isError:", result.isError);
    console.log(result.content[0].text);
  } else if (scenario === "slow") {
    console.log("\n=== calling delegate_coding_task with a deliberately slow task (should return a taskId, not block) ===");
    const start = Date.now();
    const result = await client.callTool({
      name: "delegate_coding_task",
      arguments: {
        cwd: "C:\\Users\\Apath\\AppData\\Local\\Temp\\qwen_worker_test\\live_test",
        task: "Run this exact shell command first and wait for it to finish: `powershell -Command \"Start-Sleep -Seconds 70\"` — then create a file called slow_probe.py containing just the line `# done`. Do not skip the sleep, do not run anything else.",
        verify: false,
      },
    }, undefined, { timeout: 120_000 });
    console.log(`first response after ${((Date.now() - start) / 1000).toFixed(1)}s, isError:`, result.isError);
    console.log(result.content[0].text);

    const m = result.content[0].text.match(/taskId "([^"]+)"/);
    if (!m) {
      console.log("\nUNEXPECTED: task completed within the race window, or no taskId found - nothing to poll.");
    } else {
      const taskId = m[1];
      console.log(`\n=== polling qwen_check_task("${taskId}") until done ===`);
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 10_000));
        const check = await client.callTool({ name: "qwen_check_task", arguments: { taskId } });
        console.log(`[poll ${i + 1}] isError: ${check.isError} | ${check.content[0].text.split("\n")[0]}`);
        if (!check.content[0].text.startsWith("Still running")) {
          console.log("\n=== FINAL RESULT ===");
          console.log(check.content[0].text);
          break;
        }
      }
    }
  } else if (scenario === "impossible") {
    console.log("\n=== calling delegate_coding_task with a deliberately impossible task (should surface an error, not crash) ===");
    const result = await client.callTool({
      name: "delegate_coding_task",
      arguments: {
        cwd: "C:\\Users\\Apath\\AppData\\Local\\Temp\\qwen_worker_test",
        task:
          "Run the bash command `exit 1` and then read the contents of a file at " +
          "'Z:\\definitely\\does\\not\\exist\\nope.txt' using your read tool - report " +
          "exactly what error you get, do not create the file.",
      },
    });
    console.log("isError:", result.isError);
    console.log(result.content[0].text);
  }

  await client.close();
  process.exit(0);
}

main().catch((e) => {
  console.error("HARNESS FAILURE:", e);
  process.exit(1);
});
