#!/usr/bin/env node
/**
 * Unified Local Qwen3.8-27B MCP Server (August 2026 SOTA - v4.5.6)
 *
 * Architecture:
 * - Lead Architect: Claude 5 Sonnet in Claude Code / Gemini 3.8 Flash in Antigravity
 * - Autonomous Execution Coworker: Qwen3.8-27B via Goose Agent Harness ($0 text-only execution)
 * - Serving: Universal 245K context (vLLM + DFlash2 + KVarN @ localhost:18020)
 * - Zero-Turn Async Architecture: Blocking Long-Poll HTTP Coordinator (localhost:18021)
 * - 3 Consolidated SOTA Tools: qwen_coworker, qwen_task, qwen_server
 * - Modularized Clean Architecture (src/)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_CONCURRENT_GOOSE, TASK_DIR } from "./src/config.js";
import { killProcessTree, killProcessTreeSync } from "./src/wsl_bridge.js";
import {
  acquireGooseSlot,
  releaseGooseSlot,
  listGooseSlots,
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
} from "./src/task_registry.js";
import { registerTools } from "./src/tools.js";

const __filename = fileURLToPath(import.meta.url);
const isMain = Boolean(
  process.argv[1] &&
    (path.resolve(process.argv[1]).toLowerCase() === __filename.toLowerCase() ||
      process.argv[1].toLowerCase().endsWith("index.js"))
);

function setupProcessLifecycleHandlers() {
  const cleanup = (signal) => {
    try {
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
      for (let i = 0; i < MAX_CONCURRENT_GOOSE; i++) {
        const file = slotFilePath(i);
        const lease = readLease(file);
        if (lease && lease.pid === process.pid) {
          try {
            fs.rmSync(file, { force: true });
          } catch {}
        }
      }
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
  process.on("beforeExit", () => {
    cleanup("beforeExit");
  });
}

async function main() {
  setupProcessLifecycleHandlers();
  initStatusServer();

  const server = new McpServer({
    name: "qwen38-local",
    version: "4.5.6",
  });

  registerTools(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export {
  acquireGooseSlot,
  releaseGooseSlot,
  listGooseSlots,
  TASK_DIR,
  isTaskOrphaned,
  markTaskOrphanedOnDisk,
};

if (isMain) {
  main().catch((err) => {
    console.error("MCP Server Fatal Error:", err);
    process.exit(1);
  });
}
