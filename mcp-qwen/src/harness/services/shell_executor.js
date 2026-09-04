/**
 * Sandboxed Shell Executor Service (DeepSeek AVO Subprocess Runner)
 *
 * Provides:
 * - Cross-environment command execution (Windows Host + WSL)
 * - Process group tracking with synchronous tree termination to eliminate zombies
 * - Bounded execution timeouts and stdout/stderr capture
 * - Cordis plugin integration exposing bash/exec_command tools
 */

import { spawn } from "node:child_process";
import { IS_WINDOWS } from "../../config.js";
import { isWslLocation, normalizeWorkspacePath, toPosixWslPath, killProcessTreeSync } from "../../wsl_bridge.js";

export class ShellExecutorService {
  constructor(options = {}) {
    this.defaultCwd = options.cwd ? normalizeWorkspacePath(options.cwd) : process.cwd();
    this.defaultTimeoutMs = options.defaultTimeoutMs || 60_000;
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

    const isWslTarget = use_wsl || isWslLocation(effectiveCwd);

    let executable;
    let args;
    let spawnCwd = effectiveCwd;

    if (IS_WINDOWS) {
      if (isWslTarget) {
        executable = "wsl.exe";
        const posixCwd = toPosixWslPath(effectiveCwd);
        args = ["-d", "Ubuntu", "--", "bash", "-c", `cd "${posixCwd}" && ${command}`];
        spawnCwd = undefined; // let WSL handle cd
      } else {
        executable = process.env.ComSpec || "cmd.exe";
        args = ["/d", "/s", "/c", command];
      }
    } else {
      executable = "bash";
      args = ["-c", command];
    }

    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;

      const child = spawn(executable, args, {
        cwd: spawnCwd,
        env: { ...process.env, PAGER: "cat", CI: "1" },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });

      const timer = setTimeout(() => {
        if (settled) return;
        timedOut = true;
        settled = true;
        killProcessTreeSync(child);
        resolve({
          stdout: stdout.trim(),
          stderr: (stderr + `\n[Command timed out after ${timeout}ms]`).trim(),
          exitCode: 124,
          timedOut: true,
          latencyMs: Date.now() - t0,
        });
      }, timeout);

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString("utf8");
      });

      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
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

      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          exitCode: code ?? 0,
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
