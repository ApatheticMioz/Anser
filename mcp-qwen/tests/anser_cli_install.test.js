/**
 * Slice 4B Canary — anser install / anser init
 *
 * Verifies the `anser install` and `anser init` CLI subcommands:
 *
 *   1. `install --antigravity` PRESERVES sibling servers in an existing
 *      mcp_config.json (e.g. `treemap`) while merging `mcpServers.anser`.
 *   2. `install --antigravity` writes valid tool schemas (from
 *      getToolManifest()) into the Antigravity MCP schema dir — one
 *      `<name>.json` per tool with `{ name, description, parameters }`,
 *      where `parameters` is a JSON Schema object.
 *   3. The `mcpServers.anser` spec is platform-correct:
 *        - Windows: { command: "cmd.exe", args: ["/c", "npx", "-y", "mcp-anser"] }
 *        - POSIX:   { command: "npx",     args: ["-y", "mcp-anser"] }
 *   4. `install --antigravity --dev` uses the local index.js script path.
 *   5. `install --claude` invokes `claude mcp add anser -- <cmd> <args...>`
 *      (verified via a mock `claude` that logs its arguments).
 *   6. `init --yes` writes the engine defaults to config.json non-interactively.
 *
 * Fully offline & deterministic: every CLI invocation runs in a child process
 * with an isolated QWEN_STATE_DIR / ANSER_HOME and a clean engine-config env.
 * No real engine, no real ~/.gemini, no real claude.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const BIN = path.join(REPO_ROOT, "bin", "anser.js");
const INDEX_JS = path.join(REPO_ROOT, "index.js");

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

// --- Isolated scratch root for the whole test run ---
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "anser_cli_install_"));

/**
 * Build a clean child env: engine-config vars stripped (so defaults apply),
 * state/home dirs isolated, offline discipline enforced.
 */
function baseEnv() {
  const env = { ...process.env };
  // Clean slate: remove engine-config env so built-in defaults are exercised.
  delete env.QWEN_MODEL;
  delete env.QWEN_BASE_URL;
  delete env.QWEN_MAX_CONTEXT;
  delete env.QWEN_LAUNCH_COMMAND;
  delete env.MCP_TOOL_PREFIX;
  delete env.VLLM_PORT;
  env.TEST_OFFLINE = "1";
  env.ALLOW_ENGINE_INTERRUPT = "0";
  return env;
}

function runAnser(args, extraEnv = {}) {
  const env = { ...baseEnv(), ...extraEnv };
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    timeout: 20000,
    env,
  });
}

/** Per-test isolated ANSER_HOME + derived .gemini paths. */
function makeHome(name) {
  const home = path.join(TMP, name);
  return {
    ANSER_HOME: home,
    ANSER_MCP_CONFIG: path.join(home, ".gemini", "config", "mcp_config.json"),
    ANSER_ANTIGRAVITY_MCP_DIR: path.join(
      home,
      ".gemini",
      "antigravity-ide",
      "mcp",
      "anser"
    ),
  };
}

/** Create a mock `claude` that logs its arguments to a file. */
function makeMockClaude(name) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(dir, { recursive: true });
  const log = path.join(dir, "claude_args.txt");
  let cmd;
  if (process.platform === "win32") {
    cmd = path.join(dir, "mock_claude.bat");
    // In a .bat, %* = all args.
    fs.writeFileSync(cmd, `@echo off\r\necho %* > "${log}"\r\n`, "utf8");
  } else {
    cmd = path.join(dir, "mock_claude.sh");
    fs.writeFileSync(cmd, `#!/bin/sh\necho "$@" > ${JSON.stringify(log)}\n`, "utf8");
    fs.chmodSync(cmd, 0o755);
  }
  return { cmd, log };
}

try {
  // =========================================================================
  // 1. install --antigravity preserves sibling servers + writes valid schemas
  // =========================================================================
  {
    const h = makeHome("home1");
    // Seed a mock mcp_config.json with a sibling server `treemap`.
    fs.mkdirSync(path.dirname(h.ANSER_MCP_CONFIG), { recursive: true });
    fs.writeFileSync(
      h.ANSER_MCP_CONFIG,
      JSON.stringify(
        {
          mcpServers: {
            treemap: { command: "treemap", args: ["--serve", "--port", "9999"] },
          },
        },
        null,
        2
      )
    );

    const res = runAnser(["install", "--antigravity"], h);
    assert(res.status === 0, "install --antigravity exits 0");

    const merged = JSON.parse(fs.readFileSync(h.ANSER_MCP_CONFIG, "utf8"));
    // Sibling preserved, byte-for-byte.
    assert(
      merged.mcpServers.treemap &&
        merged.mcpServers.treemap.command === "treemap" &&
        JSON.stringify(merged.mcpServers.treemap.args) ===
          JSON.stringify(["--serve", "--port", "9999"]),
      "sibling server 'treemap' preserved (command + args intact)"
    );
    // Anser merged in.
    assert(merged.mcpServers.anser, "mcpServers.anser written");

    // Platform-correct anser spec.
    if (process.platform === "win32") {
      assert(
        merged.mcpServers.anser.command === "cmd.exe",
        "Windows: anser command is cmd.exe"
      );
      assert(
        JSON.stringify(merged.mcpServers.anser.args) ===
          JSON.stringify(["/c", "npx", "-y", "mcp-anser"]),
        "Windows: anser args are [\"/c\",\"npx\",\"-y\",\"mcp-anser\"]"
      );
    } else {
      assert(
        merged.mcpServers.anser.command === "npx",
        "POSIX: anser command is npx"
      );
      assert(
        JSON.stringify(merged.mcpServers.anser.args) ===
          JSON.stringify(["-y", "mcp-anser"]),
        "POSIX: anser args are [\"-y\",\"mcp-anser\"]"
      );
    }

    // Schemas written from getToolManifest().
    const schemaFiles = fs
      .readdirSync(h.ANSER_ANTIGRAVITY_MCP_DIR)
      .filter((f) => f.endsWith(".json"))
      .sort();
    assert(
      schemaFiles.length === 3,
      `3 schema files written (got ${schemaFiles.length}: ${schemaFiles.join(", ")})`
    );
    const names = [];
    for (const f of schemaFiles) {
      const obj = JSON.parse(
        fs.readFileSync(path.join(h.ANSER_ANTIGRAVITY_MCP_DIR, f), "utf8")
      );
      names.push(obj.name);
      assert(
        typeof obj.name === "string" && obj.name.length > 0,
        `schema ${f} has non-empty name`
      );
      assert(
        typeof obj.description === "string" && obj.description.length > 0,
        `schema ${f} has non-empty description`
      );
      assert(
        obj.parameters && obj.parameters.type === "object",
        `schema ${f} parameters.type === "object"`
      );
      assert(
        obj.parameters && typeof obj.parameters.properties === "object",
        `schema ${f} parameters has a properties object`
      );
    }
    assert(
      JSON.stringify(names.sort()) ===
        JSON.stringify(["qwen_coworker", "qwen_server", "qwen_task"]),
      `schema names are the 3 known tools (got ${JSON.stringify(names.sort())})`
    );
  }

  // =========================================================================
  // 2. install --antigravity with NO existing mcp_config.json creates it
  // =========================================================================
  {
    const h = makeHome("home2");
    // Do NOT create the config file; the dir may or may not exist.
    const res = runAnser(["install", "--antigravity"], h);
    assert(res.status === 0, "install --antigravity (no existing config) exits 0");
    assert(
      fs.existsSync(h.ANSER_MCP_CONFIG),
      "mcp_config.json created when absent"
    );
    const merged = JSON.parse(fs.readFileSync(h.ANSER_MCP_CONFIG, "utf8"));
    assert(
      merged.mcpServers && merged.mcpServers.anser,
      "mcpServers.anser present in freshly created config"
    );
  }

  // =========================================================================
  // 3. install --antigravity --dev uses the local index.js script path
  // =========================================================================
  {
    const h = makeHome("home3");
    fs.mkdirSync(path.dirname(h.ANSER_MCP_CONFIG), { recursive: true });
    fs.writeFileSync(h.ANSER_MCP_CONFIG, JSON.stringify({ mcpServers: {} }, null, 2));
    const res = runAnser(["install", "--antigravity", "--dev"], h);
    assert(res.status === 0, "install --antigravity --dev exits 0");
    const merged = JSON.parse(fs.readFileSync(h.ANSER_MCP_CONFIG, "utf8"));
    if (process.platform === "win32") {
      assert(
        merged.mcpServers.anser.command === "cmd.exe" &&
          merged.mcpServers.anser.args[0] === "/c" &&
          merged.mcpServers.anser.args[1] === "node" &&
          merged.mcpServers.anser.args[2] === INDEX_JS,
        `dev Windows: anser is cmd.exe /c node <index.js> (got ${JSON.stringify(merged.mcpServers.anser)})`
      );
    } else {
      assert(
        merged.mcpServers.anser.command === "node" &&
          merged.mcpServers.anser.args[0] === INDEX_JS,
        `dev POSIX: anser is node <index.js> (got ${JSON.stringify(merged.mcpServers.anser)})`
      );
    }
  }

  // =========================================================================
  // 4. install --claude invokes `claude mcp add anser -- <cmd> <args...>`
  // =========================================================================
  {
    const h = makeHome("home4");
    const mock = makeMockClaude("mock4");
    const res = runAnser(["install", "--claude"], {
      ...h,
      ANSER_CLAUDE_CMD: mock.cmd,
    });
    assert(res.status === 0, "install --claude exits 0");
    assert(fs.existsSync(mock.log), "claude CLI was invoked (mock log written)");
    const args = fs.readFileSync(mock.log, "utf8").trim();
    assert(
      args.startsWith("mcp add anser --"),
      `claude invoked with 'mcp add anser -- ...' (got: ${args})`
    );
    assert(
      args.includes("npx -y mcp-anser"),
      `claude args include 'npx -y mcp-anser' (got: ${args})`
    );
  }

  // =========================================================================
  // 5. init --yes writes engine defaults to config.json non-interactively
  // =========================================================================
  {
    const stateDir = path.join(TMP, "state5");
    const h = makeHome("home5");
    const mock = makeMockClaude("mock5");
    const res = runAnser(["init", "--yes"], {
      ...h,
      QWEN_STATE_DIR: stateDir,
      ANSER_CLAUDE_CMD: mock.cmd,
    });
    assert(res.status === 0, "init --yes exits 0");
    const cfgPath = path.join(stateDir, "config.json");
    assert(fs.existsSync(cfgPath), "init --yes wrote config.json");
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    assert(cfg.model === "Qwen3.8-27B", `init --yes writes default model (got ${cfg.model})`);
    assert(
      cfg.max_context === 245760,
      `init --yes writes default max_context (got ${cfg.max_context})`
    );
    assert(cfg.tool_prefix === "qwen", `init --yes writes default tool_prefix (got ${cfg.tool_prefix})`);
    assert(
      typeof cfg.baseURL === "string" && cfg.baseURL.startsWith("http://"),
      `init --yes writes a default baseURL (got ${cfg.baseURL})`
    );
    // max_context persisted as a number, not a string.
    assert(
      typeof cfg.max_context === "number",
      "init --yes persists max_context as a number"
    );
  }

  // =========================================================================
  // 6. install with an unknown flag is a hard error (exit 1)
  // =========================================================================
  {
    const h = makeHome("home6");
    const res = runAnser(["install", "--bogus"], h);
    assert(res.status === 1, "install --bogus exits 1");
    assert(
      res.stderr.includes("Unknown flag"),
      "install --bogus prints 'Unknown flag' to stderr"
    );
  }

  // =========================================================================
  // 7. interactive init (piped stdin) prompts, writes config, declines install
  // =========================================================================
  {
    const stateDir = path.join(TMP, "state7");
    const h = makeHome("home7");
    const mock = makeMockClaude("mock7");
    // Piped answers: baseURL, model, max_context, tool_prefix, then "n" to
    // decline the install offer.
    const input =
      "http://127.0.0.1:18020/v1\n" +
      "MyModel-9B\n" +
      "12345\n" +
      "my\n" +
      "n\n";
    const res = spawnSync(process.execPath, [BIN, "init"], {
      encoding: "utf8",
      timeout: 20000,
      input,
      env: {
        ...baseEnv(),
        ...h,
        QWEN_STATE_DIR: stateDir,
        ANSER_CLAUDE_CMD: mock.cmd,
      },
    });
    assert(res.status === 0, "interactive init exits 0");
    const cfgPath = path.join(stateDir, "config.json");
    assert(fs.existsSync(cfgPath), "interactive init wrote config.json");
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    assert(cfg.model === "MyModel-9B", `interactive init writes model (got ${cfg.model})`);
    assert(
      cfg.max_context === 12345 && typeof cfg.max_context === "number",
      `interactive init writes max_context as number (got ${cfg.max_context})`
    );
    assert(cfg.tool_prefix === "my", `interactive init writes tool_prefix (got ${cfg.tool_prefix})`);
    assert(
      cfg.baseURL === "http://127.0.0.1:18020/v1",
      `interactive init writes baseURL (got ${cfg.baseURL})`
    );
    // Declined the install offer: no claude invocation happened.
    assert(
      !fs.existsSync(mock.log),
      "interactive init (declined) does not invoke claude"
    );
  }
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log("\n==========================================");
console.log(`Anser CLI install/init: ${passed} PASSED, ${failed} FAILED`);
console.log("==========================================");
if (failed > 0) process.exit(1);
