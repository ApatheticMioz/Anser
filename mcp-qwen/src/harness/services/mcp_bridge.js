/**
 * Generic MCP Extension Bridge (Anser primary engine)
 *
 * Makes `extensions[]` first-class on the native engine.
 *
 * `extensions[]` on a dispatch (e.g. `npx -y @upstash/context7-mcp`,
 * `uvx free-search-mcp`) is honored directly by the native engine: each spec
 * is normalized, its MCP server is spawned as a piped stdio child, and its
 * tools are registered on the Anser Context.
 *
 * This module:
 *   - Normalizes each extension spec (a string like "npx -y pkg" OR a
 *     structured { command, args, name }) into a uniform { command, args,
 *     serverName } shape.
 *   - Spawns each extension's MCP server as a piped stdio child through the
 *     platform spawn-profile helpers (buildSpawnProfile) so WSL/Windows stays
 *     abstract. NEVER shell-interpolated - argv arrays only.
 *   - Speaks JSON-RPC over stdio (newline-delimited): initialize ->
 *     notifications/initialized -> tools/list, then tools/call passthrough.
 *   - Registers each remote tool on the Anser Context with a namespaced name
 *     `ext_<server>_<tool>` (reversible via the kernel's disposers).
 *   - Teardown: dispose() kills every bridge child (process-tree kill) and
 *     unregisters the tools.
 *
 * Bounded by design: per-step timeouts (generous ~60s defaults for cold npx
 * downloads) and a per-server tool cap (default 64).
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { IS_WINDOWS } from "../../config.js";
import { buildSpawnProfile, resolveCommandPath } from "../../platform.js";
import { killProcessTree } from "../../wsl_bridge.js";

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
 * When `targetInWsl` is set, the Windows `.cmd`/`.exe` suffixes and the
 * `context7@latest` alias are normalized so the spec is interpreted
 * identically inside WSL.
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
 * A single spawned MCP server child + its JSON-RPC state.
 */
function makeServerRecord(spec) {
  return {
    spec,
    serverName: spec.serverName,
    child: null,
    pending: new Map(),
    nextId: 0,
    buffer: "",
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
    return this.servers.map((s) => s.child?.pid).filter(Boolean);
  }

  /**
   * Boot every extension, handshake, and register its tools on the Anser
   * Context. Never throws: a bad spec or a failed handshake is logged to
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
   * Spawn one extension, run the MCP handshake, and register its tools.
   * @param {import("../core/kernel.js").Context} ctx
   * @param {{ command: string, args: string[], serverName: string }} spec
   */
  async _startOne(ctx, spec) {
    const server = makeServerRecord(spec);
    this.servers.push(server);

    // P8 (orchestrator close-out): bare package runners (npx/uvx) are .cmd
    // shims on Windows, which spawn() cannot resolve without a shell - and
    // shell mode would break argv-array purity and stdio piping. Resolve the
    // bare name to an absolute spawnable path via where/which first. WSL-mode
    // dispatches resolve inside Linux and need nothing here.
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

    let child;
    try {
      child = spawn(profile.command, profile.args, profile.options);
    } catch (err) {
      throw new Error(`spawn failed: ${err.message}`);
    }
    server.child = child;

    child.stdout.on("data", (chunk) => this._onData(server, chunk));
    child.stderr.on("data", (chunk) => {
      server.stderr += chunk.toString("utf8");
      if (server.stderr.length > 20_000) server.stderr = server.stderr.slice(-20_000);
    });
    child.on("error", (err) => this._rejectAll(server, `spawn error: ${err.message}`));
    child.on("close", () => this._rejectAll(server, "child closed before response"));

    // 1. initialize
    await this._request(
      server,
      "initialize",
      {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "mcp-qwen-bridge", version: PKG_VERSION },
      },
      this.initTimeoutMs
    );

    // 2. notifications/initialized (no response expected)
    this._notify(server, "notifications/initialized", {});

    // 3. tools/list
    const listResult = await this._request(server, "tools/list", {}, this.initTimeoutMs);
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
          return this._request(
            server,
            "tools/call",
            { name: rawName, arguments: args || {} },
            this.callTimeoutMs
          );
        },
      });
      server.toolDisposers.push(dispose);
    }

    process.stderr.write(
      `[mcp-bridge] registered ${capped.length} tool(s) from '${spec.serverName}' (pid ${child.pid})\n`
    );
  }

  /**
   * Route an incoming newline-delimited JSON-RPC message to its pending
   * request, if any.
   * @param {object} server
   * @param {Buffer} chunk
   */
  _onData(server, chunk) {
    server.buffer += chunk.toString("utf8");
    let idx;
    while ((idx = server.buffer.indexOf("\n")) >= 0) {
      const line = server.buffer.slice(0, idx).trim();
      server.buffer = server.buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id !== undefined && server.pending.has(msg.id)) {
        const { resolve, reject, timer } = server.pending.get(msg.id);
        server.pending.delete(msg.id);
        clearTimeout(timer);
        if (msg.error) {
          reject(new Error(msg.error.message || "JSON-RPC error"));
        } else {
          resolve(msg.result);
        }
      }
    }
  }

  /**
   * Send a JSON-RPC request and await its response, bounded by a timeout.
   * @param {object} server
   * @param {string} method
   * @param {object} params
   * @param {number} timeoutMs
   */
  _request(server, method, params, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (server.disposed) {
        reject(new Error("bridge disposed"));
        return;
      }
      const id = ++server.nextId;
      const timer = setTimeout(() => {
        if (server.pending.has(id)) {
          server.pending.delete(id);
          reject(new Error(`MCP '${method}' timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      server.pending.set(id, { resolve, reject, timer });
      const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      try {
        server.child.stdin.write(payload + "\n");
      } catch (err) {
        clearTimeout(timer);
        server.pending.delete(id);
        reject(err);
      }
    });
  }

  /**
   * Send a JSON-RPC notification (no response expected).
   * @param {object} server
   * @param {string} method
   * @param {object} params
   */
  _notify(server, method, params) {
    try {
      server.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
    } catch {}
  }

  /**
   * Reject all in-flight requests for a server (child died / bridge disposed).
   * @param {object} server
   * @param {string} reason
   */
  _rejectAll(server, reason) {
    for (const [id, p] of Array.from(server.pending.entries())) {
      server.pending.delete(id);
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
  }

  /**
   * Kill a single bridge child via the process-tree helper and reject any
   * in-flight requests.
   * @param {object} server
   */
  _killServer(server) {
    if (server.disposed) return;
    server.disposed = true;
    this._rejectAll(server, "bridge disposed");
    const child = server.child;
    if (child && child.pid) {
      try {
        killProcessTree(child, null);
      } catch {}
      try {
        child.kill("SIGKILL");
      } catch {}
    }
  }

  /**
   * Teardown: kill every bridge child (process-tree) and unregister all
   * bridged tools via the kernel's reversible disposers. Idempotent.
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
