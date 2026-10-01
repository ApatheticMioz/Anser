/**
 * P8 — Generic MCP extension bridge tests (offline).
 *
 * Uses the fixture echo-MCP server (tests/fixtures/echo_mcp_server.js) as the
 * extension target. No npx / context7 / network.
 *
 * Vectors:
 *   1. spawn + handshake + tools/list discovers the fixture's tools
 *   2. execute a bridged tool and get the echo back
 *   3. dispose() kills the child (zero survivors via pidAlive after a wait)
 *   4. invalid spec -> honest error, no throw into the dispatch
 *   5. handshake timeout -> clean failure path (no throw, child reaped)
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { Context } from "../src/harness/core/kernel.js";
import { McpBridge, normalizeExtensionSpec, disposeAllBridges } from "../src/harness/services/mcp_bridge.js";
import { pidAlive } from "../src/semaphore.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(__dirname, "fixtures", "echo_mcp_server.js");

let passed = 0;
let failed = 0;
function assert(cond, name) {
  if (cond) {
    console.log(`[PASS] ${name}`);
    passed++;
  } else {
    console.error(`[FAIL] ${name}`);
    failed++;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  // --- Test 1: spawn + handshake + tools/list discovers tools ---
  console.log("\n[Test 1: spawn + handshake + tools/list]");
  {
    const ctx = new Context(null, "bridge_t1");
    const bridge = new McpBridge({
      cwd: process.cwd(),
      targetInWsl: false,
      extensions: [`node ${FIXTURE}`],
      timeouts: { initTimeoutMs: 10_000, callTimeoutMs: 10_000 },
    });
    await bridge.start(ctx);
    const tools = ctx.listTools();
    const names = tools.map((t) => t.function.name);
    assert(
      names.includes("ext_echo_mcp_fixture_echo") ||
        names.some((n) => n.startsWith("ext_") && n.endsWith("_echo")),
      `discovered echo tool (got: ${names.join(", ")})`
    );
    assert(
      names.some((n) => n.endsWith("_upper")),
      "discovered upper tool"
    );
    // description should be prefixed with [ext:<server>]
    const echoTool = tools.find((t) => t.function.name.endsWith("_echo"));
    assert(
      echoTool && echoTool.function.description.startsWith("[ext:"),
      "description prefixed with [ext:<server>]"
    );
    // inputSchema passthrough
    assert(
      echoTool && echoTool.function.parameters && echoTool.function.parameters.type === "object",
      "inputSchema passthrough (object)"
    );

    // --- Test 2: execute a bridged tool and get the echo back ---
    console.log("\n[Test 2: execute bridged tool -> echo back]");
    const exec = await ctx.executeTool(echoTool.function.name, { text: "hello-bridge" });
    assert(!exec.isError, `tool call did not error (got: ${exec.error || "none"})`);
    const result = exec.result;
    const text =
      result && Array.isArray(result.content) ? result.content[0].text : JSON.stringify(result);
    assert(text === "echo:hello-bridge", `echo returned (got: ${text})`);

    // upper tool
    const upperTool = tools.find((t) => t.function.name.endsWith("_upper"));
    const upExec = await ctx.executeTool(upperTool.function.name, { text: "abc" });
    const upText =
      upExec.result && Array.isArray(upExec.result.content)
        ? upExec.result.content[0].text
        : JSON.stringify(upExec.result);
    assert(upText === "ABC", `upper tool returned (got: ${upText})`);

    // --- Test 3: dispose kills the child ---
    console.log("\n[Test 3: dispose kills the child]");
    const pids = bridge.getPids();
    assert(pids.length === 1, `one child spawned (got ${pids.length})`);
    const pid = pids[0];
    assert(pidAlive(pid), "child alive before dispose");
    bridge.dispose();
    // give the OS a moment to reap
    await sleep(300);
    assert(!pidAlive(pid), "child dead after dispose (pidAlive false)");
    // tools unregistered
    const after = ctx.listTools().map((t) => t.function.name);
    assert(
      !after.some((n) => n.endsWith("_echo") || n.endsWith("_upper")),
      "bridged tools unregistered after dispose"
    );
    ctx.dispose();
  }

  // --- Test 4: invalid spec -> honest error, no throw into the dispatch ---
  console.log("\n[Test 4: invalid spec -> honest error, no throw]");
  {
    const ctx = new Context(null, "bridge_t4");
    let threw = false;
    let bridge;
    try {
      bridge = new McpBridge({
        cwd: process.cwd(),
        targetInWsl: false,
        extensions: [12345, "   "], // invalid: non-string, and empty string
        timeouts: { initTimeoutMs: 2000 },
      });
      await bridge.start(ctx); // must NOT throw
    } catch (e) {
      threw = true;
    }
    assert(!threw, "start() did not throw on invalid specs");
    const tools = ctx.listTools();
    assert(tools.length === 0, "no tools registered from invalid specs");
    if (bridge) bridge.dispose();
    ctx.dispose();
  }

  // --- Test 5: handshake timeout -> clean failure path ---
  console.log("\n[Test 5: handshake timeout -> clean failure]");
  {
    // A spec that spawns a process which never responds to initialize.
    // `node -e "setInterval(()=>{},1000)"` stays alive but silent.
    const ctx = new Context(null, "bridge_t5");
    let threw = false;
    let bridge;
    try {
      bridge = new McpBridge({
        cwd: process.cwd(),
        targetInWsl: false,
        extensions: [`node -e "setInterval(()=>{},1000)"`],
        timeouts: { initTimeoutMs: 1500 }, // short: forces the timeout
      });
      await bridge.start(ctx); // must NOT throw; timeout is handled internally
    } catch (e) {
      threw = true;
    }
    assert(!threw, "start() did not throw on handshake timeout");
    const tools = ctx.listTools();
    assert(tools.length === 0, "no tools registered after handshake timeout");
    // the silent child must have been reaped
    if (bridge) {
      const pids = bridge.getPids();
      bridge.dispose();
      await sleep(300);
      const survivors = pids.filter((p) => pidAlive(p));
      assert(survivors.length === 0, `no surviving children after timeout+dispose (got ${survivors.length})`);
    }
    ctx.dispose();
  }

  // --- Test 6: normalizeExtensionSpec contract (string + structured) ---
  console.log("\n[Test 6: normalizeExtensionSpec contract]");
  {
    const a = normalizeExtensionSpec("npx -y @upstash/context7-mcp");
    assert(a.command === "npx", `string spec command (got ${a.command})`);
    assert(a.args[0] === "-y", `string spec args[0] (got ${a.args[0]})`);
    assert(a.serverName === "context7_mcp", `serverName sanitized (got ${a.serverName})`);

    const b = normalizeExtensionSpec({ command: "uvx", args: ["free-search-mcp"], name: "free_search" });
    assert(b.command === "uvx", "structured spec command");
    assert(b.serverName === "free_search", `structured spec name (got ${b.serverName})`);

    // WSL normalization: npx.cmd -> npx
    const c = normalizeExtensionSpec("npx.cmd -y pkg", { targetInWsl: true });
    assert(c.command === "npx", `wsl npx.cmd normalized (got ${c.command})`);

    // context7@latest alias
    const d = normalizeExtensionSpec("npx -y context7@latest", { targetInWsl: true });
    assert(
      d.args.includes("@upstash/context7-mcp"),
      `context7@latest alias normalized (got ${d.args.join(" ")})`
    );

    // invalid: non-string non-object
    let threw = false;
    try {
      normalizeExtensionSpec(42);
    } catch {
      threw = true;
    }
    assert(threw, "invalid spec type throws (caught by start)");
  }

  // --- Test 7: disposeAllBridges reaps any stragglers ---
  console.log("\n[Test 7: disposeAllBridges reaps stragglers]");
  {
    const ctx = new Context(null, "bridge_t7");
    const bridge = new McpBridge({
      cwd: process.cwd(),
      targetInWsl: false,
      extensions: [`node ${FIXTURE}`],
      timeouts: { initTimeoutMs: 10_000 },
    });
    await bridge.start(ctx);
    const pids = bridge.getPids();
    assert(pids.length === 1, "child spawned for straggler test");
    // Do NOT call bridge.dispose(); rely on the global reaper.
    disposeAllBridges();
    await sleep(300);
    const survivors = pids.filter((p) => pidAlive(p));
    assert(survivors.length === 0, `disposeAllBridges reaped the child (got ${survivors.length})`);
    ctx.dispose();
  }

  console.log("\n==========================================");
  console.log(`MCP Bridge Tests: ${passed} PASSED, ${failed} FAILED`);
  console.log("==========================================");
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("MCP Bridge test uncaught error:", err);
  process.exit(1);
});
