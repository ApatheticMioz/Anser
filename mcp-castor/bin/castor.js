#!/usr/bin/env node
/**
 * Castor CLI entrypoint (packaged as the `castor` bin).
 *
 * Subcommands:
 *   castor [mcp]     Start the MCP server on stdio (default).
 *   castor init      Initialize ~/.castor config (prompts, or --yes for defaults).
 *   castor install   Register the Castor MCP server with Antigravity / Claude Code.
 *   castor config    Show or edit configuration.
 *   castor status    Show engine / task status.
 *   castor clean     Prune old sessions / orphan temp files from the state dir.
 *
 * Stdio purity: in MCP mode NOTHING is written to stdout except JSON-RPC
 * frames emitted by the MCP transport. All diagnostics go to stderr.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import readline from "node:readline";
import { QWEN_STATE_DIR, getEngineConfig } from "../src/config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
// Direct script path used by `install --dev` (the MCP server entrypoint).
const INDEX_JS = path.join(REPO_ROOT, "index.js");

const USAGE = `Usage: castor [command]

Commands:
  mcp       Start the MCP server on stdio (default)
  init      Initialize the ~/.castor config (prompts, or --yes for defaults)
  install   Register the Castor MCP server with a host
    install [--antigravity] [--claude] [--all] [--dev]
      --antigravity  Write tool schemas + merge mcp_config.json (Antigravity IDE)
      --claude       Register with Claude Code (claude mcp add)
      --all          Both (default when no host flag is given)
      --dev          Use the local script path instead of the published package
  config    Show or edit configuration
    config path          Print path to config.json
    config get [key]     Print a config value (or full JSON if no key)
    config set <k> <v>   Set a config key (model, baseURL, max_context,
                         launch_command, tool_prefix, api_key, engine_type,
                         stop_command, engine_log_path, use_stream_proxy,
                         stream_proxy_port, status_port, vllm_port, search)
    config edit          Open config in $EDITOR (or notepad/vi)
  status    Show engine and task status
  clean     Prune old sessions and orphan .tmp_* files from the state dir
    clean [--dry-run] [--max-age-days N] [--max-sessions N] [--max-size-mb N]
      --dry-run          Report what would be reclaimed without deleting
      --max-age-days N   Evict sessions older than N days (default: 14)
      --max-sessions N   Keep at most N sessions (default: 200)
      --max-size-mb N    Keep total session size under N MB (default: 50)

Run 'castor mcp' (or just 'castor') to start the MCP server.
`;

// ---------------------------------------------------------------------------
// config subcommand
// ---------------------------------------------------------------------------

const CONFIG_FILE = path.join(QWEN_STATE_DIR, "config.json");
const VALID_KEYS = new Set([
  "model",
  "baseURL",
  "max_context",
  "launch_command",
  "tool_prefix",
  "api_key",
  "engine_type",
  "stop_command",
  "engine_log_path",
  "use_stream_proxy",
  "stream_proxy_port",
  "status_port",
  "vllm_port",
  "search",
]);

function readConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = fs.readFileSync(CONFIG_FILE, "utf8").replace(/^\uFEFF/, "");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") return parsed;
    }
  } catch (err) {
    process.stderr.write(`[config] Corrupt ${CONFIG_FILE}: ${err.message}\n`);
  }
  return {};
}

function writeConfig(cfg) {
  fs.mkdirSync(QWEN_STATE_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + "\n", "utf8");
}

function configPath() {
  process.stdout.write(CONFIG_FILE + "\n");
}

function configGet(key) {
  const cfg = readConfig();
  if (key === undefined) {
    process.stdout.write(JSON.stringify(cfg, null, 2) + "\n");
    return;
  }
  if (!VALID_KEYS.has(key)) {
    process.stderr.write(`Unknown config key: ${key}\n`);
    process.stderr.write(`Valid keys: ${[...VALID_KEYS].join(", ")}\n`);
    process.exit(1);
  }
  const val = cfg[key];
  if (val === undefined) {
    process.stdout.write("(not set)\n");
  } else {
    process.stdout.write(String(val) + "\n");
  }
}

function configSet(key, val) {
  if (!VALID_KEYS.has(key)) {
    process.stderr.write(`Unknown config key: ${key}\n`);
    process.stderr.write(`Valid keys: ${[...VALID_KEYS].join(", ")}\n`);
    process.exit(1);
  }
  const cfg = readConfig();
  if (key === "max_context" || key === "stream_proxy_port" || key === "status_port" || key === "vllm_port") {
    const num = Number(val);
    if (!Number.isFinite(num) || num <= 0) {
      process.stderr.write(
        `Invalid value for ${key}: ${val} (must be a positive number)\n`
      );
      process.exit(1);
    }
    cfg[key] = num;
  } else if (key === "use_stream_proxy") {
    cfg[key] = val === "true" || val === "1";
  } else {
    cfg[key] = val;
  }
  writeConfig(cfg);
  const isNumeric = key === "max_context" || key === "stream_proxy_port" || key === "status_port" || key === "vllm_port";
  const isBoolean = key === "use_stream_proxy";
  const display = isNumeric || isBoolean ? String(cfg[key]) : `"${cfg[key]}"`;
  process.stdout.write(`Set ${key} = ${display}\n`);
}

function configEdit() {
  const isWindows = process.platform === "win32";
  const editor = process.env.EDITOR || (isWindows ? "notepad" : "vi");
  if (!fs.existsSync(CONFIG_FILE)) {
    writeConfig({});
  }
  const result = spawnSync(editor, [CONFIG_FILE], { stdio: "inherit" });
  if (result.error) {
    process.stderr.write(`Failed to open editor: ${result.error.message}\n`);
    process.exit(1);
  }
}

function handleConfig(args) {
  const sub = args[0];
  if (sub === "path") {
    configPath();
  } else if (sub === "get") {
    configGet(args[1]);
  } else if (sub === "set") {
    if (args.length < 3) {
      process.stderr.write("Usage: castor config set <key> <value>\n");
      process.exit(1);
    }
    configSet(args[1], args[2]);
  } else if (sub === "edit") {
    configEdit();
  } else {
    process.stderr.write(
      "Usage: castor config [path|get [key]|set <key> <val>|edit]\n"
    );
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// install subcommand
// ---------------------------------------------------------------------------

/**
 * Base home directory for the .gemini config tree. Overridable via CASTOR_HOME
 * for test isolation (defaults to the OS user home).
 */
function castorHome() {
  return process.env.CASTOR_HOME || os.homedir();
}

/** Path to the Antigravity/Gemini mcp_config.json (overridable for tests). */
function mcpConfigPath() {
  return (
    process.env.CASTOR_MCP_CONFIG ||
    path.join(castorHome(), ".gemini", "config", "mcp_config.json")
  );
}

/**
 * Directory where Antigravity auto-discovers the Castor MCP tool schemas
 * (overridable for tests). Defaults to ~/.gemini/antigravity-ide/mcp/castor/.
 */
function antigravityMcpDir() {
  return (
    process.env.CASTOR_ANTIGRAVITY_MCP_DIR ||
    path.join(castorHome(), ".gemini", "antigravity-ide", "mcp", "castor")
  );
}

/**
 * Build the mcp_config.json server spec for the Castor MCP server.
 *
 * On Windows, `npx` must be invoked through `cmd.exe /c`; on POSIX, `npx` is
 * invoked directly. With `--dev`, the local index.js script path is used
 * instead of the published `mcp-castor` package.
 *
 * @param {boolean} dev
 * @returns {{ command: string, args: string[] }}
 */
function buildMcpServerSpec(dev) {
  const isWin = process.platform === "win32";
  if (dev) {
    return isWin
      ? { command: "cmd.exe", args: ["/c", "node", INDEX_JS] }
      : { command: "node", args: [INDEX_JS] };
  }
  return isWin
    ? { command: "cmd.exe", args: ["/c", "npx", "-y", "mcp-castor"] }
    : { command: "npx", args: ["-y", "mcp-castor"] };
}

/**
 * Build the server spec for `claude mcp add`. Claude Code spawns the command
 * directly (no `cmd.exe` wrapper needed), so this is simpler than the
 * mcp_config.json spec.
 *
 * @param {boolean} dev
 * @returns {{ command: string, args: string[] }}
 */
function buildClaudeServerSpec(dev) {
  if (dev) return { command: "node", args: [INDEX_JS] };
  return { command: "npx", args: ["-y", "mcp-castor"] };
}

/**
 * Read the existing mcp_config.json (if present), merge the Castor server spec
 * into `mcpServers.castor` (preserving ALL sibling servers such as `treemap`),
 * and write it back. Returns the merged config object.
 *
 * @param {{ command: string, args: string[] }} serverSpec
 * @returns {object}
 */
function mergeMcpConfig(serverSpec) {
  const cfgPath = mcpConfigPath();
  let cfg = {};
  if (fs.existsSync(cfgPath)) {
    try {
      const raw = fs.readFileSync(cfgPath, "utf8").replace(/^\uFEFF/, "");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") cfg = parsed;
    } catch (err) {
      process.stderr.write(
        `[install] Corrupt ${cfgPath}: ${err.message}; starting fresh.\n`
      );
      cfg = {};
    }
  }
  if (!cfg.mcpServers || typeof cfg.mcpServers !== "object") {
    cfg.mcpServers = {};
  }
  cfg.mcpServers.castor = serverSpec;
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  return cfg;
}

/**
 * Write the tool JSON schemas (from getToolManifest()) into the Antigravity
 * MCP schema directory. Each tool becomes `<name>.json` with
 * `{ name, description, parameters }` (the same shape update_schemas.py
 * emits, so the schema_parity test can consume it). Stale `.json` files in
 * the directory are removed first so a renamed/removed tool does not linger.
 *
 * @returns {Promise<Array<{name: string, description: string, inputSchema: object}>>}
 */
async function writeAntigravitySchemas() {
  const { getToolManifest } = await import("../src/tools.js");
  const manifest = getToolManifest();
  const dir = antigravityMcpDir();
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith(".json")) {
      try {
        fs.rmSync(path.join(dir, f));
      } catch {}
    }
  }
  for (const tool of manifest) {
    const payload = {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    };
    const p = path.join(dir, `${tool.name}.json`);
    fs.writeFileSync(p, JSON.stringify(payload, null, 2) + "\n", "utf8");
    process.stdout.write(`[install] Wrote ${p}\n`);
  }
  return manifest;
}

/**
 * Antigravity install: write the tool schemas, then merge the Castor server
 * spec into mcp_config.json (preserving sibling servers).
 *
 * @param {boolean} dev
 */
async function installAntigravity(dev) {
  process.stdout.write("[install] Antigravity IDE...\n");
  await writeAntigravitySchemas();
  const spec = buildMcpServerSpec(dev);
  const cfg = mergeMcpConfig(spec);
  const names = Object.keys(cfg.mcpServers);
  process.stdout.write(
    `[install] Merged mcpServers.castor into ${mcpConfigPath()} (servers: ${names.join(", ")})\n`
  );
}

/**
 * Claude Code install: run `claude mcp add castor -- <command> <args...>`.
 * The `claude` binary is overridable via CASTOR_CLAUDE_CMD for tests. If the
 * CLI is unavailable or the command fails, a manual command is printed and
 * false is returned (non-fatal).
 *
 * @param {boolean} dev
 * @returns {boolean}
 */
function installClaude(dev) {
  process.stdout.write("[install] Claude Code...\n");
  const spec = buildClaudeServerSpec(dev);
  const claudeCmd = process.env.CASTOR_CLAUDE_CMD || "claude";
  const args = ["mcp", "add", "castor", "--", spec.command, ...spec.args];
  // On Windows the `claude` CLI is a .cmd shim that must be resolved through
  // the shell; on POSIX it is a regular executable.
  const res = spawnSync(claudeCmd, args, {
    encoding: "utf8",
    timeout: 15000,
    shell: process.platform === "win32",
  });
  if (res.error) {
    process.stderr.write(
      `[install] claude CLI unavailable (${res.error.message}); run manually: ${claudeCmd} mcp add castor -- ${spec.command} ${spec.args.join(" ")}\n`
    );
    return false;
  }
  if (res.status !== 0) {
    process.stderr.write(
      `[install] claude mcp add failed (exit ${res.status}): ${(res.stderr || "").trim()}\n`
    );
    return false;
  }
  process.stdout.write("[install] Registered castor with Claude Code.\n");
  return true;
}

/**
 * Parse `install` flags. Unknown flags are a hard error (exit 1).
 *
 * @param {string[]} args
 * @returns {{ antigravity: boolean, claude: boolean, all: boolean, dev: boolean }}
 */
function parseInstallFlags(args) {
  const flags = { antigravity: false, claude: false, all: false, dev: false };
  for (const a of args) {
    if (a === "--antigravity") flags.antigravity = true;
    else if (a === "--claude") flags.claude = true;
    else if (a === "--all") flags.all = true;
    else if (a === "--dev") flags.dev = true;
    else {
      process.stderr.write(`[install] Unknown flag: ${a}\n`);
      process.exit(1);
    }
  }
  return flags;
}

/**
 * Orchestrate the install across the requested hosts. With no host flag,
 * defaults to both (equivalent to --all).
 *
 * @param {{ antigravity: boolean, claude: boolean, all: boolean, dev: boolean }} flags
 * @returns {Promise<boolean>}
 */
async function runInstall(flags) {
  const targets = [];
  if (flags.all) {
    targets.push("antigravity", "claude");
  } else {
    if (flags.antigravity) targets.push("antigravity");
    if (flags.claude) targets.push("claude");
  }
  if (targets.length === 0) {
    // No host flag: default to both.
    targets.push("antigravity", "claude");
  }
  let ok = true;
  for (const t of targets) {
    if (t === "antigravity") {
      try {
        await installAntigravity(flags.dev);
      } catch (err) {
        process.stderr.write(`[install] Antigravity failed: ${err.message}\n`);
        ok = false;
      }
    } else if (t === "claude") {
      if (!installClaude(flags.dev)) ok = false;
    }
  }
  process.stdout.write(ok ? "[install] Done.\n" : "[install] Completed with warnings.\n");
  return ok;
}

async function handleInstall(args) {
  const flags = parseInstallFlags(args);
  await runInstall(flags);
}

// ---------------------------------------------------------------------------
// init subcommand
// ---------------------------------------------------------------------------

// Piped-stdin line reader. When stdin is a pipe (not a TTY) — e.g. in tests or
// when the user pipes answers — readline.question() is unreliable (it can
// close after the first line). Instead we buffer all of stdin once and hand
// out lines in order. For a real TTY we fall back to readline.question().
let _pipedLines = null;
let _pipedDone = false;
function _ensurePipedLines() {
  if (_pipedLines !== null) return;
  _pipedLines = [];
  if (process.stdin.isTTY) {
    _pipedDone = true;
    return;
  }
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf("\n")) !== -1) {
      _pipedLines.push(buf.slice(0, idx));
      buf = buf.slice(idx + 1);
    }
  });
  process.stdin.on("end", () => {
    if (buf.length > 0) _pipedLines.push(buf);
    _pipedDone = true;
  });
}

/**
 * Read a single line from stdin (interactive prompt).
 *
 * @param {string} question
 * @returns {Promise<string>}
 */
function promptLine(question) {
  process.stdout.write(question);
  if (process.stdin.isTTY) {
    return new Promise((resolve) => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      rl.question("", (answer) => {
        rl.close();
        resolve(answer);
      });
    });
  }
  // Piped: wait until at least one line is available (or stdin ends).
  return new Promise((resolve) => {
    _ensurePipedLines();
    const poll = () => {
      if (_pipedLines.length > 0) {
        resolve(_pipedLines.shift());
      } else if (_pipedDone) {
        resolve("");
      } else {
        setTimeout(poll, 5);
      }
    };
    poll();
  });
}

/**
 * Initialize the ~/.castor config. Prompts for baseURL, model, max_context,
 * and tool_prefix (showing the current value as the default), saves them to
 * config.json, then offers to run `castor install`. With `--yes`, writes the
 * defaults non-interactively and auto-runs the install.
 *
 * @param {string[]} args
 */
async function handleInit(args) {
  const yes = args.includes("--yes") || args.includes("-y");
  const cfg = readConfig();
  const engine = getEngineConfig();
  const defaults = {
    baseURL: engine.baseURL,
    model: engine.model,
    max_context: engine.max_context,
    tool_prefix: engine.tool_prefix,
  };

  let values;
  if (yes) {
    values = { ...defaults };
    process.stdout.write("[init] Writing defaults (non-interactive):\n");
    for (const [k, v] of Object.entries(values)) {
      process.stdout.write(`  ${k} = ${JSON.stringify(v)}\n`);
    }
  } else {
    values = {};
    for (const [k, def] of Object.entries(defaults)) {
      const answer = await promptLine(`${k} [${def}]: `);
      values[k] = answer.trim() === "" ? def : answer.trim();
    }
    const num = Number(values.max_context);
    if (!Number.isFinite(num) || num <= 0) {
      process.stderr.write(`[init] Invalid max_context: ${values.max_context}\n`);
      process.exit(1);
    }
    values.max_context = num;
  }

  // Merge over any existing config (preserving other keys like search /
  // launch_command).
  const merged = { ...cfg, ...values };
  writeConfig(merged);
  process.stdout.write(`[init] Wrote ${CONFIG_FILE}\n`);

  if (yes) {
    process.stdout.write("[init] Running castor install --all...\n");
    await runInstall({ all: true });
  } else {
    const answer = await promptLine("Run 'castor install' now? [y/N]: ");
    if (answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes") {
      await runInstall({ all: true });
    }
  }
}

// ---------------------------------------------------------------------------
// status subcommand
// ---------------------------------------------------------------------------

async function handleStatus() {
  const cfg = getEngineConfig();
  const stateDir = QWEN_STATE_DIR;

  // Same offline discipline as tests/helpers/engine_probe.js: never probe
  // the engine unless ALLOW_ENGINE_INTERRUPT=1 (avoids interrupting live
  // workloads and keeps `castor status` deterministic in CI).
  const probeDisabled =
    process.env.TEST_OFFLINE === "1" ||
    process.env.ALLOW_ENGINE_INTERRUPT !== "1";
  let engineReachable = null; // null = probe skipped (unknown)
  let probeDetail = "skipped (ALLOW_ENGINE_INTERRUPT=0)";
  if (!probeDisabled) {
    try {
      const res = await fetch(cfg.baseURL, {
        signal: AbortSignal.timeout(2000),
      });
      engineReachable = true;
      probeDetail = `HTTP ${res.status}`;
    } catch (err) {
      engineReachable = false;
      probeDetail =
        err.name === "TimeoutError" || err.name === "AbortError"
          ? "timeout (2s)"
          : err.message;
    }
  }

  const lines = [
    "Castor Status",
    "=============",
    `Engine:      ${cfg.model}`,
    `Base URL:    ${cfg.baseURL}`,
    `Max Context: ${cfg.max_context} tokens`,
    `Tool Prefix: ${cfg.tool_prefix}`,
    `State Dir:   ${stateDir}`,
    `Engine Up:   ${
      engineReachable === null ? "UNKNOWN" : engineReachable ? "YES" : "NO"
    } (${probeDetail})`,
  ];
  process.stdout.write(lines.join("\n") + "\n");
}

// ---------------------------------------------------------------------------
// clean subcommand
// ---------------------------------------------------------------------------

async function handleClean(argv) {
  const dryRun = argv.includes("--dry-run");
  const flagVal = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  const maxAgeDays = flagVal("--max-age-days");
  const maxSessions = flagVal("--max-sessions");
  const maxSizeMb = flagVal("--max-size-mb");

  const opts = { dryRun };
  if (maxAgeDays !== undefined) {
    const n = Number(maxAgeDays);
    if (!Number.isFinite(n) || n <= 0) {
      process.stderr.write(`Invalid --max-age-days: ${maxAgeDays}\n`);
      process.exit(1);
    }
    opts.maxAgeMs = n * 86_400_000;
  }
  if (maxSessions !== undefined) {
    const n = Number(maxSessions);
    if (!Number.isFinite(n) || n <= 0) {
      process.stderr.write(`Invalid --max-sessions: ${maxSessions}\n`);
      process.exit(1);
    }
    opts.maxCount = n;
  }
  if (maxSizeMb !== undefined) {
    const n = Number(maxSizeMb);
    if (!Number.isFinite(n) || n <= 0) {
      process.stderr.write(`Invalid --max-size-mb: ${maxSizeMb}\n`);
      process.exit(1);
    }
    opts.maxSizeMb = n;
  }

  const { cleanStateDir } = await import("../src/state_pruner.js");
  const result = cleanStateDir(opts);

  const mb = (b) => (b / (1024 * 1024)).toFixed(2);
  const prefix = dryRun ? "[dry-run] would" : "";
  process.stdout.write(
    `${prefix} prune ${result.sessionsPruned} session(s) ` +
      `(${mb(result.bytesReclaimed)} MB), ` +
      `${prefix} clean ${result.tmpFilesCleaned} orphan .tmp_* file(s) ` +
      `(${mb(result.tmpBytesReclaimed)} MB); ` +
      `${result.protected} session(s) protected (active/incomplete)\n`
  );
}

// ---------------------------------------------------------------------------
// main dispatch
// ---------------------------------------------------------------------------

const subcommand = process.argv[2];

if (subcommand === undefined || subcommand === "mcp") {
  // MCP mode: stdio purity — no stdout logging, ever.
  // Lazy import so `config`/`status`/`install`/`init` never load the MCP SDK.
  const { startMcpServer } = await import("../index.js");
  startMcpServer().catch((err) => {
    process.stderr.write(
      `MCP Server Fatal Error: ${err && err.stack ? err.stack : err}\n`
    );
    process.exit(1);
  });
} else if (subcommand === "-h" || subcommand === "--help" || subcommand === "help") {
  process.stderr.write(USAGE);
  process.exit(0);
} else if (subcommand === "config") {
  handleConfig(process.argv.slice(3));
} else if (subcommand === "status") {
  handleStatus().catch((err) => {
    process.stderr.write(`Status error: ${err.message}\n`);
    process.exit(1);
  });
} else if (subcommand === "init") {
  handleInit(process.argv.slice(3)).catch((err) => {
    process.stderr.write(`Init error: ${err.message}\n`);
    process.exit(1);
  });
} else if (subcommand === "install") {
  handleInstall(process.argv.slice(3)).catch((err) => {
    process.stderr.write(`Install error: ${err.message}\n`);
    process.exit(1);
  });
} else if (subcommand === "clean") {
  handleClean(process.argv.slice(3)).catch((err) => {
    process.stderr.write(`Clean error: ${err.message}\n`);
    process.exit(1);
  });
} else {
  process.stderr.write(`Unknown command: ${subcommand}\n\n`);
  process.stderr.write(USAGE);
  process.exit(1);
}
