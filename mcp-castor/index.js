#!/usr/bin/env node
/**
 * Castor - Unified Local Model Agent Harness & MCP Server (version: package.json)
 *
 * Architecture:
 * - Lead Architect: Claude 5 Sonnet in Claude Code / Gemini 3.8 Flash in Antigravity
 * - Autonomous Execution Coworker: Qwen3.8-27B via Castor Microkernel Harness ($0 text-only execution)
 * - Serving: Universal 245K context (vLLM + DFlash2 + KVarN @ localhost:18020)
 * - Zero-Turn Async Architecture: Blocking Long-Poll HTTP Coordinator (localhost:18021)
 * - 3 Consolidated SOTA Tools: qwen_coworker, qwen_task, qwen_server
 * - Modularized Clean Architecture (src/)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_CONCURRENT_TASKS, TASK_DIR } from "./src/config.js";
import { killProcessTree, killProcessTreeSync } from "./src/wsl_bridge.js";
import {
  acquireTaskSlot,
  releaseTaskSlot,
  listTaskSlots,
  getSlotStatus,
  slotFilePath,
  readLease,
} from "./src/semaphore.js";
import {
  tasks,
  saveTaskToDisk,
  notifyWaiters,
  isTaskOrphaned,
  markTaskOrphanedOnDisk,
  initStatusServer,
  setMcpServerFactory,
  activeSseSessions,
} from "./src/task_registry.js";
import { registerTools } from "./src/tools.js";
import { shutdownSearxng } from "./src/harness/services/searxng_lifecycle.js";
import { disposeAllBridges } from "./src/harness/services/mcp_bridge.js";
import { cleanStateDir } from "./src/state_pruner.js";

const require = createRequire(import.meta.url);
const { name: pkgName, version: pkgVersion } = require("./package.json");
const __filename = fileURLToPath(import.meta.url);

function setupProcessLifecycleHandlers() {
  const cleanup = (signal) => {
    try {
      // P8: reap any live MCP extension bridge children (native engine)
      // so none survive process shutdown.
      disposeAllBridges();
      for (const session of activeSseSessions.values()) {
        try {
          session.transport.close();
          session.server.close();
        } catch {}
      }
      activeSseSessions.clear();
      for (const [id, task] of tasks.entries()) {
        if (!task.done) {
          task.done = true;
          task.status = "cancelled";
          task.isError = true;
          task.finishedAt = Date.now();
          task.result = {
            isError: true,
            text: `Task cancelled: MCP server process terminating (${signal || "shutdown"}).`,
            toolCalls: task.toolCallsCount || 0,
            errors: ["SERVER_PROCESS_TERMINATED"],
            fileOps: task.fileOps || [],
          };
          saveTaskToDisk(task);
          notifyWaiters(task);
          if (task.child) {
            killProcessTreeSync(task.child, task.sessionId);
          }
        }
      }
      for (let i = 0; i < MAX_CONCURRENT_TASKS; i++) {
        const file = slotFilePath(i);
        const lease = readLease(file);
        if (lease && lease.pid === process.pid) {
          try {
            fs.rmSync(file, { force: true });
          } catch {}
        }
      }
      try {
        shutdownSearxng().catch(() => {});
      } catch {}
    } catch {}
  };

  process.once("SIGINT", () => {
    cleanup("SIGINT");
    process.exit(0);
  });
  process.once("SIGTERM", () => {
    cleanup("SIGTERM");
    process.exit(0);
  });
  process.stdin.on("close", () => {
    cleanup("stdin_closed");
    process.exit(0);
  });
  process.stdin.on("end", () => {
    cleanup("stdin_end");
    process.exit(0);
  });
  process.stdout.on("error", (err) => {
    if (err && (err.code === "EPIPE" || err.code === "ERR_STREAM_DESTROYED")) {
      cleanup("stdout_epipe");
      process.exit(0);
    }
  });
  process.stderr.on("error", (err) => {
    if (err && (err.code === "EPIPE" || err.code === "ERR_STREAM_DESTROYED")) {
      process.exit(0);
    }
  });
  process.on("beforeExit", () => {
    cleanup("beforeExit");
  });
}

function createMcpServer() {
  const server = new McpServer({
    name: pkgName ?? "qwen38-local",
    version: pkgVersion,
  });
  registerTools(server);
  return server;
}

setMcpServerFactory(createMcpServer);

/**
 * Starts the Castor MCP server on the stdio transport.
 *
 * Exported so that `bin/castor.js` (the packaged CLI entrypoint) can import
 * and invoke it, while direct execution of `index.js` still works as before.
 *
 * Stdio purity contract: this function must never write to stdout except
 * through the MCP transport (JSON-RPC frames). All diagnostics go to stderr.
 */
export async function startMcpServer() {
  setupProcessLifecycleHandlers();
  initStatusServer();

  // Opportunistic state-dir hygiene: prune old sessions / orphan .tmp_* files.
  // Throttled to at most once per 24h via the .last_prune timestamp, and
  // best-effort — a failure here must never prevent the MCP server from
  // starting. Stdio purity: diagnostics go to stderr only.
  try {
    const pruneResult = cleanStateDir({ throttled: true });
    if (!pruneResult.skipped) {
      const reclaimedMb =
        (pruneResult.bytesReclaimed + pruneResult.tmpBytesReclaimed) /
        (1024 * 1024);
      process.stderr.write(
        `[state-pruner] pruned ${pruneResult.sessionsPruned} session(s), ` +
          `${pruneResult.tmpFilesCleaned} orphan .tmp_* file(s) ` +
          `(${reclaimedMb.toFixed(2)} MB); ` +
          `${pruneResult.protected} protected\n`
      );
    }
  } catch (err) {
    process.stderr.write(
      `[state-pruner] startup cleanup failed (non-fatal): ${
        err && err.message ? err.message : err
      }\n`
    );
  }

  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export {
  acquireTaskSlot,
  releaseTaskSlot,
  listTaskSlots,
  getSlotStatus,
  TASK_DIR,
  isTaskOrphaned,
  markTaskOrphanedOnDisk,
};

// Direct-run guard: only auto-start when this file is the actual entrypoint
// (e.g. `node index.js`), not when imported by bin/castor.js or tests.
const isMain = Boolean(
  process.argv[1] &&
    (path.resolve(process.argv[1]).toLowerCase() === __filename.toLowerCase() ||
      process.argv[1].toLowerCase().endsWith("index.js"))
);

if (isMain) {
  startMcpServer().catch((err) => {
    console.error("MCP Server Fatal Error:", err);
    process.exit(1);
  });
}
