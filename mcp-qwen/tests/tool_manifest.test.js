/**
 * Slice 2A Canary — getToolManifest()
 *
 * Standalone, fast, deterministic (no network, no engine, no subprocesses).
 * Verifies that getToolManifest() returns an array of tool entries where each
 * entry has:
 *   - a non-empty string `name`
 *   - a non-empty string `description`
 *   - a valid `inputSchema` with `type: "object"` and a `properties` object
 *
 * It also asserts the three known tools are present and that the manifest is
 * byte-identical to what the SDK serves over `tools/list` (the whole point of
 * the manifest: a faithful, in-process mirror of the wire schema).
 */

process.env.TEST_OFFLINE = "1";
import { getToolManifest } from "../src/tools.js";

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

async function run() {
  console.log("=== Slice 2A: getToolManifest() canary ===\n");

  const manifest = getToolManifest();

  // --- Structural: it is an array of well-formed entries ---
  ok(Array.isArray(manifest), "getToolManifest() returns an array");
  ok(manifest.length > 0, "manifest is non-empty");

  for (const entry of manifest) {
    ok(
      typeof entry.name === "string" && entry.name.length > 0,
      `entry has non-empty string name (${entry.name})`
    );
    ok(
      typeof entry.description === "string" && entry.description.length > 0,
      `entry '${entry.name}' has non-empty string description`
    );
    ok(
      entry.inputSchema && typeof entry.inputSchema === "object",
      `entry '${entry.name}' has an object inputSchema`
    );
    ok(
      entry.inputSchema && entry.inputSchema.type === "object",
      `entry '${entry.name}' inputSchema.type === "object"`
    );
    ok(
      entry.inputSchema &&
        entry.inputSchema.properties &&
        typeof entry.inputSchema.properties === "object",
      `entry '${entry.name}' inputSchema has a properties object`
    );
  }

  // --- Content: the three known tools are present ---
  const names = manifest.map((e) => e.name);
  for (const expected of ["qwen_coworker", "qwen_task", "qwen_server"]) {
    ok(names.includes(expected), `manifest includes tool '${expected}'`);
  }

  // --- Slice 2B: prefix parameterization ---
  // An empty prefix yields the canonical unprefixed names; a custom prefix
  // is applied to every tool name.
  const canonical = getToolManifest({ prefix: "" }).map((e) => e.name);
  ok(
    JSON.stringify(canonical) === JSON.stringify(["coworker", "task", "server"]),
    `getToolManifest({ prefix: "" }) yields canonical names (got: ${JSON.stringify(canonical)})`
  );

  const prefixed = getToolManifest({ prefix: "test" }).map((e) => e.name);
  ok(
    JSON.stringify(prefixed) === JSON.stringify(["test_coworker", "test_task", "test_server"]),
    `getToolManifest({ prefix: "test" }) yields prefixed names (got: ${JSON.stringify(prefixed)})`
  );

  // --- Parity: byte-identical to the SDK's served inputSchema ---
  // Rebuild the served schema through the SDK's own ListTools handler path and
  // confirm our manifest matches it exactly for every tool.
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { normalizeObjectSchema } = await import(
    "@modelcontextprotocol/sdk/server/zod-compat.js"
  );
  const { toJsonSchemaCompat } = await import(
    "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js"
  );
  const { registerTools } = await import("../src/tools.js");

  const server = new McpServer({ name: "parity-probe", version: "0.0.0" });
  registerTools(server);

  for (const [name, tool] of Object.entries(server._registeredTools)) {
    if (!tool.enabled) continue;
    const obj = normalizeObjectSchema(tool.inputSchema);
    const served = obj
      ? toJsonSchemaCompat(obj, { strictUnions: true, pipeStrategy: "input" })
      : { type: "object", properties: {} };
    const mine = manifest.find((e) => e.name === name)?.inputSchema;
    ok(
      JSON.stringify(mine) === JSON.stringify(served),
      `manifest inputSchema for '${name}' is byte-identical to SDK-served schema`
    );
  }

  console.log(`\n=== Result: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error("Canary crashed:", err);
  process.exit(1);
});
