/**
 * ============================================================================
 * ⚠️ DANGER DANGER DANGER — LIVE HOST PROCESS SPAWNING BOUNDARY — READ THIS ⚠️
 * ============================================================================
 *
 * ATTENTION ALL FUTURE AGENTS & DEVELOPERS:
 * 1. THIS MODULE SPAWNS LIVE OPERATING SYSTEM PROCESSES (cmd.exe, wsl.exe, bash).
 * 2. NEVER, UNDER ANY CIRCUMSTANCES, PASS REAL DESTRUCTIVE OR SYSTEM-NUKE
 *    COMMANDS (e.g. `rm -rf /`, `del C:\*`, `format C:`) TO `execute()` FOR "TESTING".
 * 3. ALL DESTRUCTIVE COMMAND TESTS MUST BE PASSED EXCLUSIVELY TO
 *    `validateShellSafety` IN `shell_validator.js` (ZERO-EXECUTION ENCLAVE).
 * 4. TO TEST THIS EXECUTOR SERVICE, YOU MUST:
 *    - USE ONLY HARMLESS CANARY COMMANDS (e.g. `echo "test"`), OR
 *    - CONSTRUCT WITH `{ dryRun: true }` OR SET `QWEN_SHELL_DRY_RUN=1`.
 * 5. A LOW-LEVEL DEAD-MAN FUSE GUARDS THE PRE-SPAWN LINE, BUT YOU MUST NEVER
 *    RELY ON RUNTIME INTERCEPTION FOR SYSTEM SAFETY.
 * ============================================================================
 *
 * Sandboxed Shell Executor Service (DeepSeek AVO Subprocess Runner)
 *
 * Provides:
 * - Cross-environment command execution (Windows Host + WSL)
 * - Process group tracking with synchronous tree termination to eliminate zombies
 * - Bounded execution timeouts and stdout/stderr capture
 * - Cordis plugin integration exposing bash/exec_command tools
 * - Multi-layer defense: delegates validation to zero-child-process shell_validator.js
 * - Low-level dead-man fuse and dry-run execution gating
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { IS_WINDOWS } from "../../config.js";
import { isWslLocation, normalizeWorkspacePath, killProcessTreeSync } from "../../wsl_bridge.js";
import { toPosixWslPath } from "../../platform.js";
import {
  validateShellSafety,
  assertDeadManFuse,
  CANARY_DISASTER_FUSE_TOKEN,
} from "./shell_validator.js";

// Re-export validator and canary token for backwards compatibility
export { validateShellSafety, assertDeadManFuse, CANARY_DISASTER_FUSE_TOKEN };

export class ShellExecutorService {
  constructor(options = {}) {
    this.defaultCwd = options.cwd ? normalizeWorkspacePath(options.cwd) : process.cwd();
    this.defaultTimeoutMs = options.defaultTimeoutMs || 60_000;
    this.dryRun = Boolean(options.dryRun || process.env.QWEN_SHELL_DRY_RUN === "1");
  }

  /**
   * Executes a shell command with synchronous timeout protection.
   *
   * @param {object} params
   * @param {string} params.command
   * @param {string} [params.cwd]
   * @param {number} [params.timeout_ms]
   * @param {boolean} [params.use_wsl] Force execution inside WSL bash
   * @returns {Promise<{ stdout: string, stderr: string, exitCode: number, timedOut: boolean, latencyMs: number }>}
   */
  async execute({ command, cwd, timeout_ms, use_wsl = false }) {
    const t0 = Date.now();
    const effectiveCwd = cwd ? normalizeWorkspacePath(cwd) : this.defaultCwd;
    const timeout = timeout_ms || this.defaultTimeoutMs;

    // Layer 1: Strict path-aware and recursive wrapper validation
    validateShellSafety(command, effectiveCwd, this.defaultCwd);

    // Layer 2: Dead-man fuse check (halts catastrophic signatures even if bypassed)
    assertDeadManFuse(command);

    // Layer 3: Dry-run simulation gate (bypasses spawn completely in test/simulation modes)
    if (this.dryRun || process.env.QWEN_SHELL_DRY_RUN === "1") {
      return {
        stdout: "[DRY-RUN SIMULATED]",
        stderr: "",
        exitCode: 0,
        timedOut: false,
        latencyMs: Date.now() - t0,
      };
    }

    const isWslTarget = use_wsl || isWslLocation(effectiveCwd);

    let executable;
    let args;
    let spawnCwd = effectiveCwd;

    const execTag = `qwen_sh_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

    if (IS_WINDOWS) {
      if (isWslTarget) {
        executable = "wsl.exe";
        const posixCwd = toPosixWslPath(effectiveCwd);
        args = ["-d", "Ubuntu", "--", "bash", "-c", `EXEC_TAG="${execTag}" && cd "${posixCwd}" && ${command}`];
        spawnCwd = undefined; // let WSL handle cd
      } else {
        executable = process.env.ComSpec || "cmd.exe";
        args = ["/d", "/s", "/c", command];
      }
    } else {
      executable = "bash";
      args = ["-c", `EXEC_TAG="${execTag}" && ${command}`];
    }

    // Final pre-spawn dead-man assertion barrier
    assertDeadManFuse(command);

    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;

      const child = spawn(executable, args, {
        cwd: spawnCwd,
        env: { ...process.env, PAGER: "cat", CI: "1", EXEC_TAG: execTag },
        stdio: ["ignore", "pipe", "pipe"],
        detached: !IS_WINDOWS,
        windowsHide: true,
      });

      const timer = setTimeout(() => {
        if (settled) return;
        timedOut = true;
        settled = true;
        killProcessTreeSync(child, execTag);
        resolve({
          stdout: stdout.trim(),
          stderr: (stderr + `\n[Command timed out after ${timeout}ms]`).trim(),
          exitCode: 124,
          timedOut: true,
          latencyMs: Date.now() - t0,
        });
      }, timeout);

      const MAX_OUTPUT_BYTES = 4 * 1024 * 1024; // 4MB

      child.stdout.on("data", (chunk) => {
        if (stdout.length < MAX_OUTPUT_BYTES) {
          stdout += chunk.toString("utf8");
          if (stdout.length >= MAX_OUTPUT_BYTES) {
            stdout += "\n...[stdout truncated at 4MB]";
          }
        }
      });

      child.stderr.on("data", (chunk) => {
        if (stderr.length < MAX_OUTPUT_BYTES) {
          stderr += chunk.toString("utf8");
          if (stderr.length >= MAX_OUTPUT_BYTES) {
            stderr += "\n...[stderr truncated at 4MB]";
          }
        }
      });

      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          stdout: stdout.trim(),
          stderr: (stderr + `\n[Spawn error: ${err.message}]`).trim(),
          exitCode: 1,
          timedOut: false,
          latencyMs: Date.now() - t0,
        });
      });

      child.on("close", (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const resolvedExitCode = code !== null ? code : signal ? 137 : 1;
        resolve({
          stdout: stdout.trim(),
          stderr: (stderr + (signal ? `\n[Process terminated by signal ${signal}]` : "")).trim(),
          exitCode: resolvedExitCode,
          timedOut: false,
          latencyMs: Date.now() - t0,
        });
      });
    });
  }
}

/**
 * Cordis Plugin to mount ShellExecutorService into Context.
 */
export function shellExecutorPlugin(ctx, options = {}) {
  const executor = new ShellExecutorService(options);
  ctx.provide("shell", executor);

  ctx.registerTool("bash", {
    description: "Execute a shell command with timeout protection and process group cleanup",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command line to execute" },
        cwd: { type: "string", description: "Working directory (optional)" },
        timeout_ms: { type: "integer", description: "Timeout in milliseconds (default 60000)", default: 60000 },
      },
      required: ["command"],
    },
    execute: (args) => executor.execute(args),
  });

  ctx.registerTool("exec_command", {
    description: "Alias for bash tool: run commands safely in workspace",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Command line to run" },
        cwd: { type: "string", description: "Working directory" },
      },
      required: ["command"],
    },
    execute: (args) => executor.execute(args),
  });
}
