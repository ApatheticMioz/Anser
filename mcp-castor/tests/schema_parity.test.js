/**
 * P12 — Schema parity drift test.
 *
 * Spawns the real MCP server (node index.js), completes the MCP handshake
 * (initialize -> notifications/initialized -> tools/list), captures the
 * served tools array (name + inputSchema per tool), and deep-compares it
 * against the JSON files written by `castor install` into the Antigravity
 * MCP schema directory.
 *
 * Asserts:
 *   - Same tool name set (no missing/extra tools).
 *   - Per-tool inputSchema equivalence after normalizing key order and
 *     whitespace (deep-compare parsed JSON, not strings).
 *   - Served tools match `getToolManifest()` (in-process introspection).
 *   - On drift, names the tools and the exact JSON paths that differ.
 *
 * Bounded: ~20s total, kills the child on timeout.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { getToolManifest } from "../src/tools.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.resolve(__dirname, "..", "index.js");

// F9 (state isolation): the spawned index.js child imports config.js
// (QWEN_STATE_DIR) and task_registry.js (writes task JSON / session logs /
// slot leases under QWEN_STATE_DIR). Redirect the child's state dir to a fresh
// temp dir so the live MCP server never writes to the production
// C:\Users\<user>\.qwen state.
const TMP_STATE = fs.mkdtempSync(path.join(os.tmpdir(), "fx7_schema_state_"));
const ISOLATED_ENV = {
  ...process.env,
  QWEN_STATE_DIR: TMP_STATE,
  QWEN_WSL_HOME: TMP_STATE,
  QWEN_WIN_HOME: TMP_STATE,
  HOME: TMP_STATE,
};

const TIMEOUT_MS = 20_000;
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

/**
 * Deep-compare two JSON values. Returns an array of { path, served, generated }
 * for every difference found. Key order and whitespace are irrelevant (we
 * compare parsed objects, not strings).
 */
function deepDiff(a, b, path, diffs) {
  if (a === b) return;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") {
    if (a !== b) diffs.push({ path, served: a, generated: b });
    return;
  }
  if (Array.isArray(a) !== Array.isArray(b)) {
    diffs.push({ path, served: a, generated: b });
    return;
  }
  if (Array.isArray(a)) {
    if (a.length !== b.length) {
      diffs.push({ path, served: a, generated: b });
      return;
    }
    for (let i = 0; i < a.length; i++) {
      deepDiff(a[i], b[i], path + "[" + i + "]", diffs);
    }
    return;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (!(k in a)) diffs.push({ path: path + "." + k, served: "<MISSING>", generated: b[k] });
    else if (!(k in b)) diffs.push({ path: path + "." + k, served: a[k], generated: "<MISSING>" });
    else deepDiff(a[k], b[k], path + "." + k, diffs);
  }
}

/**
 * Locate the Antigravity MCP schema directory written by `castor install`
 * (bin/castor.js writeAntigravitySchemas). Resolution order:
 *   1. CASTOR_ANTIGRAVITY_MCP_DIR env override (test isolation).
 *   2. ~/.gemini/antigravity-ide/mcp/castor (the current install target).
 *   3. Legacy qwen38-local dir (Windows home, then WSL /mnt/c view) for
 *      machines that have not yet re-run `castor install`.
 */
function findGeneratedDir() {
  const candidates = [
    process.env.CASTOR_ANTIGRAVITY_MCP_DIR,
    path.join(os.homedir(), ".gemini/antigravity-ide/mcp/castor"),
    // Legacy: pre-`castor install` output of the retired update_schemas.py.
    path.join(os.homedir(), ".gemini/antigravity-ide/mcp/qwen38-local"),
    // WSL - the Windows C: drive mounted under /mnt/c, derived from the
    // current user's home (no hardcoded username).
    path.join("/mnt/c/Users", path.basename(os.homedir()), ".gemini/antigravity-ide/mcp/castor"),
    path.join("/mnt/c/Users", path.basename(os.homedir()), ".gemini/antigravity-ide/mcp/qwen38-local"),
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

async function runTests() {
  console.log("=== P12 Schema Parity Drift Test ===\n");

  // Locate the generated schema files.
  const genDir = findGeneratedDir();
  if (!genDir) {
    // Honest skip (P11 discipline): the generated dir absent means the
    // environment prerequisite was never run on this machine (fresh clone),
    // NOT a parity failure. When the dir EXISTS, drift is a hard failure.
    console.log(
      "  [SKIP] Antigravity MCP schema dir not found - run `npx -y mcp-castor init` (or `node bin/castor.js install --antigravity`) once to enable the parity check"
    );
    process.exit(0);
  }
  console.log(`  Generated dir: ${genDir}`);

  // Load the install-generated schemas (one <name>.json per tool,
  // { name, description, parameters }).
  const generated = {};
  for (const f of fs.readdirSync(genDir)) {
    if (f.endsWith(".json")) {
      const obj = JSON.parse(fs.readFileSync(path.join(genDir, f), "utf8"));
      generated[obj.name] = obj.parameters;
    }
  }
  console.log(`  Generated tools: ${Object.keys(generated).join(", ")}`);

  // Spawn the live server and capture the served schemas.
  let client;
  let transport;
  const timer = setTimeout(() => {
    console.error("  [FAIL] Timed out after " + TIMEOUT_MS + "ms");
    process.exit(1);
  }, TIMEOUT_MS);

  try {
    transport = new StdioClientTransport({
      command: "node",
      args: [scriptPath],
      env: ISOLATED_ENV,
    });
    client = new Client({ name: "schema-parity-test", version: "1.0.0" });
    await client.connect(transport);

    // The SDK's connect() performs the full handshake:
    //   initialize -> notifications/initialized
    // Then we call tools/list.
    const res = await client.listTools();
    const served = res.tools.map((t) => ({ name: t.name, inputSchema: t.inputSchema }));
    console.log(`  Served tools: ${served.map((t) => t.name).join(", ")}`);

    // --- Assert: served tools match getToolManifest() (in-process) ---
    // The manifest is built through the exact SDK code path used by
    // tools/list, so any divergence here means the live server is serving
    // something different from the registered tool surface.
    const manifest = getToolManifest();
    const manifestByName = new Map(manifest.map((t) => [t.name, t]));
    let manifestDiffs = 0;
    for (const t of served) {
      const m = manifestByName.get(t.name);
      if (!m) {
        manifestDiffs++;
        console.error(`  [DRIFT] ${t.name}: present in served tools but missing from getToolManifest()`);
        continue;
      }
      const diffs = [];
      deepDiff(t.inputSchema, m.inputSchema, "", diffs);
      manifestDiffs += diffs.length;
      if (diffs.length > 0) {
        console.error(`\n  MANIFEST DRIFT in ${t.name} (${diffs.length} diff(s)):`);
        for (const d of diffs) {
          console.error(`    ${d.path}`);
          console.error(`      served:    ${JSON.stringify(d.served)}`);
          console.error(`      manifest:  ${JSON.stringify(d.generated)}`);
        }
      }
    }
    for (const m of manifest) {
      if (!served.some((t) => t.name === m.name)) {
        manifestDiffs++;
        console.error(`  [DRIFT] ${m.name}: present in getToolManifest() but missing from served tools`);
      }
    }
    ok(
      manifestDiffs === 0,
      `Served tools match getToolManifest() (diffs: ${manifestDiffs})`
    );

    // --- Assert: same tool name set ---
    const servedNames = served.map((t) => t.name).sort();
    const genNames = Object.keys(generated).sort();
    const missingInGen = servedNames.filter((n) => !genNames.includes(n));
    const extraInGen = genNames.filter((n) => !servedNames.includes(n));

    ok(
      missingInGen.length === 0,
      `No tools missing from generated (missing: ${missingInGen.join(", ") || "(none)"})`
    );
    ok(
      extraInGen.length === 0,
      `No extra tools in generated (extra: ${extraInGen.join(", ") || "(none)"})`
    );

    // --- Assert: per-tool inputSchema equivalence ---
    let totalDiffs = 0;
    for (const t of served) {
      if (!generated[t.name]) continue;
      const diffs = [];
      deepDiff(t.inputSchema, generated[t.name], "", diffs);
      totalDiffs += diffs.length;
      if (diffs.length > 0) {
        console.error(`\n  DRIFT in ${t.name} (${diffs.length} diff(s)):`);
        for (const d of diffs) {
          console.error(`    ${d.path}`);
          console.error(`      served:    ${JSON.stringify(d.served)}`);
          console.error(`      generated: ${JSON.stringify(d.generated)}`);
        }
      }
    }
    ok(
      totalDiffs === 0,
      `All inputSchemas match (total diffs: ${totalDiffs})`
    );
  } finally {
    clearTimeout(timer);
    if (client) {
      try {
        await client.close();
      } catch {}
    }
  }

  console.log("\n==========================================");
  console.log(`Schema Parity Tests: ${passed} PASSED, ${failed} FAILED`);
  console.log("==========================================");
  if (failed > 0) process.exit(1);
}

runTests().catch((err) => {
  console.error("Schema parity test uncaught error:", err);
  process.exit(1);
});
