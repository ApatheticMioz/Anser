/**
 * Generic MCP Extension Bridge (Anser primary engine)
 *
 * Makes `extensions[]` first-class on the native engine by porting onto the
 * official `@modelcontextprotocol/sdk` Client and StdioClientTransport.
 *
 * `extensions[]` on a dispatch (e.g. custom user tools, domain APIs) is honored
 * directly by the native engine: each spec is normalized, spawned via
 * StdioClientTransport, connected via SDK Client, and its tools are registered
 * on the Anser Context.
 *
 * Features:
 *   - Normalizes each extension spec (string or { command, args, name }).
 *   - Spawns each extension via StdioClientTransport and buildSpawnProfile
 *     with Windows/WSL cross-platform path resolution. NEVER shell-interpolated.
 *   - Speaks full modern MCP specification through `@modelcontextprotocol/sdk`.
 *   - Registers each remote tool on Anser Context under `ext_<server>_<tool>`.
 *   - Teardown: dispose() cleanly closes the Client and enforces process-tree
 *     reaping (killProcessTreeSync) so zero child processes survive.
 *   - Bounded timeouts (initTimeoutMs, callTimeoutMs) and per-server tool caps.
 */

import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { IS_WINDOWS } from "../../config.js";
import { buildSpawnProfile, resolveCommandPath } from "../../platform.js";
import { killProcessTree, killProcessTreeSync } from "../../wsl_bridge.js";

const require = createRequire(import.meta.url);
let PKG_VERSION = "0.0.0";
try {
  PKG_VERSION = require("../../package.json").version || "0.0.0";
} catch {}

// ---------------------------------------------------------------------------
// Extension-spec normalization
// ---------------------------------------------------------------------------

/**
 * Tokenize a command string into an argv array, respecting double-quoted
 * segments. No shell is ever invoked - this is a pure string split.
 * @param {string} s
 * @returns {string[]}
 */
function tokenize(s) {
  const out = [];
  let cur = "";
  let inQ = false;
  for (const ch of s) {
    if (ch === '"') {
      inQ = !inQ;
      continue;
    }
    if (/\s/.test(ch) && !inQ) {
      if (cur) {
        out.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Derive a human/server name from a command + args. Picks the last non-flag
 * token (the package / entrypoint) and strips scope + path segments.
 * @param {string} command
 * @param {string[]} args
 * @returns {string}
 */
function deriveServerName(command, args) {
  const candidates = (args || []).filter((a) => !a.startsWith("-"));
  const pick = candidates.length ? candidates[candidates.length - 1] : command;
  let name = String(pick).replace(/^@/, "").split("/").pop();
  return name || "ext";
}

/**
 * Sanitize an identifier to the safe charset [a-z0-9_].
 * @param {string} s
 * @returns {string}
 */
export function sanitizeName(s) {
  let n = String(s)
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return n || "ext";
}

/**
 * Normalize a raw extension spec into { command, args, serverName }.
 *
 * Input contract:
 *   - a string like "npx -y @upstash/context7-mcp" or "uvx free-search-mcp"
 *   - a structured object { command, args, name? }
 *
 * When `targetInWsl` is set, Windows `.cmd`/`.exe` suffixes and aliases are
 * normalized so the spec is interpreted cleanly inside WSL.
 *
 * @param {string|object} raw
 * @param {{ targetInWsl?: boolean }} [opts]
 * @returns {{ command: string, args: string[], serverName: string }}
 */
export function normalizeExtensionSpec(raw, { targetInWsl = false } = {}) {
  if (raw && typeof raw === "object") {
    const command = raw.command;
    if (!command || typeof command !== "string") {
      throw new Error("extension spec object must provide a string `command`");
    }
    const args = Array.isArray(raw.args) ? raw.args.map(String) : [];
    const name = raw.name || deriveServerName(command, args);
    return { command, args, serverName: sanitizeName(name) };
  }

  if (typeof raw !== "string") {
    throw new Error("extension spec must be a string or an object");
  }

  let s = raw;
  if (targetInWsl) {
    s = s.replace(/^npx\.cmd\b/, "npx").replace(/^uvx\.exe\b/, "uvx");
    if (s.includes("context7@latest") && !s.includes("@upstash/context7-mcp")) {
      s = s.replace("context7@latest", "@upstash/context7-mcp");
    }
  }

  const tokens = tokenize(s);
  if (tokens.length === 0) {
    throw new Error("empty extension spec");
  }
  const command = tokens[0];
  const args = tokens.slice(1);
  return { command, args, serverName: sanitizeName(deriveServerName(command, args)) };
}

// ---------------------------------------------------------------------------
// Bridge
// ---------------------------------------------------------------------------

/**
 * A single spawned MCP server record + its SDK client state.
 */
function makeServerRecord(spec) {
  return {
    spec,
    serverName: spec.serverName,
    client: null,
    transport: null,
    pid: null,
    stderr: "",
    toolDisposers: [],
    disposed: false,
  };
}

// Module-level registry of live bridges so that process-level shutdown
// (index.js cleanup) and task-cancel can reap every bridge child even when
// the owning runner's finally block has not yet run.
const LIVE_BRIDGES = new Set();

/**
 * Dispose every live bridge (kill all children + unregister tools). Called
 * from the MCP server shutdown hook so no bridge child survives process exit.
 */
export function disposeAllBridges() {
  for (const b of Array.from(LIVE_BRIDGES)) {
    try {
      b.dispose();
    } catch {}
  }
  LIVE_BRIDGES.clear();
}

/**
 * P10 test seam (read-only): pids of every live bridge child across all
 * currently-registered bridges. Lets the cancel-path test observe the
 * runner's internal bridge child (which it cannot reach directly) to prove
 * that an abort lands in the runner's finally block and disposes the bridge.
 * @returns {number[]}
 */
export function getLiveBridgePids() {
  const pids = [];
  for (const b of Array.from(LIVE_BRIDGES)) {
    for (const p of b.getPids()) pids.push(p);
  }
  return pids;
}

export class McpBridge {
  /**
   * @param {object} options
   * @param {string} [options.cwd] working directory for the children
   * @param {boolean} [options.targetInWsl] whether the target runs inside WSL
   * @param {Array<string|object>} [options.extensions] raw extension specs
   * @param {object} [options.timeouts]
   * @param {number} [options.timeouts.initTimeoutMs] per-handshake-step timeout
   * @param {number} [options.timeouts.callTimeoutMs] per tools/call timeout
   * @param {number} [options.timeouts.maxToolsPerServer] tool cap per server
   */
  constructor({ cwd, targetInWsl = false, extensions = [], timeouts = {} } = {}) {
    this.cwd = cwd;
    this.targetInWsl = targetInWsl;
    this.extensions = Array.isArray(extensions) ? extensions : [];
    this.initTimeoutMs = timeouts.initTimeoutMs ?? 60_000;
    this.callTimeoutMs = timeouts.callTimeoutMs ?? 60_000;
    this.maxToolsPerServer = timeouts.maxToolsPerServer ?? 64;
    this.servers = [];
    this.disposed = false;
    this.started = false;
    LIVE_BRIDGES.add(this);
  }

  /**
   * PIDs of all live bridge children (for tests / liveness assertions).
   * @returns {number[]}
   */
  getPids() {
    return this.servers.map((s) => s.pid || s.transport?.pid).filter(Boolean);
  }

  /**
   * Boot every extension, handshake via MCP SDK, and register its tools on the
   * Anser Context. Never throws: a bad spec or a failed handshake is logged to
   * stderr and skipped so it can never take down the dispatch.
   * @param {import("../core/kernel.js").Context} ctx
   */
  async start(ctx) {
    if (this.started) return;
    this.started = true;
    for (const raw of this.extensions) {
      let spec;
      try {
        spec = normalizeExtensionSpec(raw, { targetInWsl: this.targetInWsl });
      } catch (err) {
        process.stderr.write(
          `[mcp-bridge] invalid extension spec ${JSON.stringify(raw)}: ${err.message}\n`
        );
        continue;
      }
      try {
        await this._startOne(ctx, spec);
      } catch (err) {
        process.stderr.write(
          `[mcp-bridge] failed to start extension '${spec.serverName}': ${err.message}\n`
        );
        const srv = this.servers.find((s) => s.serverName === spec.serverName);
        if (srv) this._killServer(srv);
      }
    }
  }

  /**
   * Spawn one extension via SDK StdioClientTransport, run the MCP handshake,
   * and register its tools on Context.
   * @param {import("../core/kernel.js").Context} ctx
   * @param {{ command: string, args: string[], serverName: string }} spec
   */
  async _startOne(ctx, spec) {
    const server = makeServerRecord(spec);
    this.servers.push(server);

    let command = spec.command;
    if (!this.targetInWsl && IS_WINDOWS) {
      command = resolveCommandPath(command) || command;
    }

    const profile = buildSpawnProfile({
      command,
      args: spec.args,
      cwd: this.targetInWsl ? undefined : this.cwd,
      mode: this.targetInWsl ? "wsl" : "windows",
      stdio: ["pipe", "pipe", "pipe"],
      useCd: false,
    });

    const transport = new StdioClientTransport({
      command: profile.command,
      args: profile.args,
      env: profile.options.env,
      cwd: profile.options.cwd,
      stderr: "pipe",
    });
    server.transport = transport;

    if (transport.stderr) {
      transport.stderr.on("data", (chunk) => {
        server.stderr += chunk.toString("utf8");
        if (server.stderr.length > 20_000) server.stderr = server.stderr.slice(-20_000);
      });
    }

    const client = new Client(
      { name: "mcp-qwen-bridge", version: PKG_VERSION },
      { capabilities: {} }
    );
    server.client = client;

    // Timeout-bounded initialize handshake
    let initTimer;
    const timeoutPromise = new Promise((_, reject) => {
      initTimer = setTimeout(() => {
        reject(new Error(`MCP 'initialize' timed out after ${this.initTimeoutMs}ms`));
      }, this.initTimeoutMs);
    });

    try {
      await Promise.race([client.connect(transport), timeoutPromise]);
    } finally {
      clearTimeout(initTimer);
      server.pid = transport.pid;
    }

    // Query tools/list with timeout
    let listTimer;
    const listTimeoutPromise = new Promise((_, reject) => {
      listTimer = setTimeout(() => {
        reject(new Error(`MCP 'tools/list' timed out after ${this.initTimeoutMs}ms`));
      }, this.initTimeoutMs);
    });

    let listResult;
    try {
      listResult = await Promise.race([client.listTools(), listTimeoutPromise]);
    } finally {
      clearTimeout(listTimer);
    }

    const tools = Array.isArray(listResult?.tools) ? listResult.tools : [];
    const capped = tools.slice(0, this.maxToolsPerServer);
    if (tools.length > capped.length) {
      process.stderr.write(
        `[mcp-bridge] ${spec.serverName}: ${tools.length} tools, capped to ${capped.length}\n`
      );
    }

    for (const t of capped) {
      const rawName = t.name || "tool";
      const namespaced = `ext_${spec.serverName}_${sanitizeName(rawName)}`;
      const dispose = ctx.registerTool(namespaced, {
        description: `[ext:${spec.serverName}] ${t.description || ""}`.trim(),
        parameters: t.inputSchema || { type: "object" },
        execute: async (args) => {
          return client.callTool(
            { name: rawName, arguments: args || {} },
            undefined,
            { timeout: this.callTimeoutMs }
          );
        },
      });
      server.toolDisposers.push(dispose);
    }

    process.stderr.write(
      `[mcp-bridge] registered ${capped.length} tool(s) from '${spec.serverName}' (pid ${server.pid || transport.pid})\n`
    );
  }

  /**
   * Kill a single bridge child via process-tree helpers and close SDK client.
   * @param {object} server
   */
  _killServer(server) {
    if (server.disposed) return;
    server.disposed = true;
    const pid = server.pid || server.transport?.pid;
    const child = server.transport?._process || (pid ? { pid } : null);
    try {
      server.client?.close();
    } catch {}
    try {
      server.transport?.close();
    } catch {}
    if (child && pid) {
      try {
        killProcessTreeSync(child, null);
      } catch {}
      try {
        killProcessTree(child, null).catch?.(() => {});
      } catch {}
      try {
        child.kill?.("SIGKILL");
      } catch {}
    }
  }

  /**
   * Teardown: cleanly close all SDK clients, kill every bridge child
   * process-tree, and unregister all bridged tools. Idempotent.
   */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    LIVE_BRIDGES.delete(this);
    for (const server of this.servers) {
      this._killServer(server);
      for (const d of server.toolDisposers || []) {
        try {
          d();
        } catch {}
      }
    }
    this.servers = [];
  }
}

export default McpBridge;
