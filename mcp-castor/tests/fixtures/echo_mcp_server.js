#!/usr/bin/env node
/**
 * Offline fixture: a minimal stdio JSON-RPC MCP server used by
 * tests/mcp_bridge.test.js. It implements just enough of the MCP protocol
 * for the bridge to handshake and exercise tools:
 *   - initialize  -> returns protocolVersion + serverInfo
 *   - notifications/initialized -> ignored (no response)
 *   - tools/list  -> two tools: "echo" and "upper"
 *   - tools/call  -> echoes the arguments back as content
 *
 * It is newline-delimited JSON-RPC over stdin/stdout, exactly what the
 * bridge speaks. No network, no npx, no external deps.
 */

let buffer = "";

function write(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function handle(msg) {
  const { id, method, params } = msg;

  if (method === "initialize") {
    write({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "echo-mcp-fixture", version: "1.0.0" },
      },
    });
    return;
  }

  if (method === "notifications/initialized") {
    // notification: no response
    return;
  }

  if (method === "tools/list") {
    write({
      jsonrpc: "2.0",
      id,
      result: {
        tools: [
          {
            name: "echo",
            description: "Echoes the provided text back.",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
            },
          },
          {
            name: "upper",
            description: "Uppercases the provided text.",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
            },
          },
        ],
      },
    });
    return;
  }

  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments || {};
    let text;
    if (name === "echo") {
      text = `echo:${args.text ?? ""}`;
    } else if (name === "upper") {
      text = String(args.text ?? "").toUpperCase();
    } else {
      write({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `unknown tool: ${name}` },
      });
      return;
    }
    write({
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text }],
        isError: false,
      },
    });
    return;
  }

  // Unknown request with an id -> method-not-found error.
  if (id !== undefined) {
    write({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `method not found: ${method}` },
    });
  }
}

process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    handle(msg);
  }
});

process.stdin.on("end", () => {
  process.exit(0);
});
