/**
 * Sandboxed Shell Executor Service (Castor Subprocess Runner).
 *
 * Spawns live operating-system processes (cmd.exe, wsl.exe, bash).
 *
 * Safety invariants:
 * - Destructive or system-level commands must not be passed to execute();
 *   test them via validateShellSafety in shell_validator.js (zero-execution).
 * - To test this executor, use harmless canary commands (e.g. `echo "test"`)
 *   or run in dry-run mode ({ dryRun: true } or QWEN_SHELL_DRY_RUN=1).
 * - A dead-man fuse guards the pre-spawn line; do not rely on runtime
 *   interception for system safety.
 *
 * Provides:
 * - Cross-environment command execution (Windows Host + WSL)
 * - Process group tracking with synchronous tree termination to eliminate zombies
 * - Bounded execution timeouts and stdout/stderr capture
 * - Castor plugin integration exposing bash/exec_command tools
 * - Multi-layer defense: delegates validation to zero-child-process shell_validator.js
 * - Low-level dead-man fuse and dry-run execution gating
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { IS_WINDOWS } from "../../config.js";
import { isWslLocation, normalizeWorkspacePath, killProcessTreeSync, canonicalizePath } from "../../wsl_bridge.js";
import { toPosixWslPath, toWindowsPath, posixShell, wslDistro } from "../../platform.js";
import {
  validateShellSafety,
  assertDeadManFuse,
  CANARY_DISASTER_FUSE_TOKEN,
} from "./shell_validator.js";

// Re-export validator and canary token for backwards compatibility
export { validateShellSafety, assertDeadManFuse, CANARY_DISASTER_FUSE_TOKEN };

// Escapes a single quote for use inside a single-quoted POSIX shell string
// (close-quote / escaped-quote / reopen-quote idiom). Used by all shell
// branches so the command cannot break out of the surrounding single quotes.
function escapeSingleQuote(s) {
  return String(s).replace(/'/g, "'\\''");
}

export class ShellExecutorService {
  constructor(options = {}) {
    // Canonicalize the default cwd through the OS symlink/junction resolution
    // layer so a junction/symlink cwd is stored as its real path; the CWD
    // containment check in validateShellSafety then compares real against real.
    const rawCwd = options.cwd ? normalizeWorkspacePath(options.cwd) : process.cwd();
    this.defaultCwd = canonicalizePath(rawCwd);
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
    // Canonicalize the per-call cwd through the OS symlink/junction layer so
    // the CWD containment check in validateShellSafety compares real against
    // real. A symlink inside the workspace that points outside resolves to
    // its real (outside) location and is blocked, rather than passing a
    // lexical in-root check.
    const effectiveCwd = cwd ? canonicalizePath(normalizeWorkspacePath(cwd)) : this.defaultCwd;
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
        // Windows-side env (childEnv) does not cross into WSL without WSLENV,
        // so the color-forcing vars are sanitized inside the -c payload to
        // keep output plain text (Node >= 24 honors FORCE_COLOR on piped
        // stdout, which would corrupt JSON.parse'd ast-grep output and metric
        // regexes).
        args = ["-d", wslDistro(), "--", "bash", "-c", `exec -a "${execTag}" bash -c 'unset FORCE_COLOR CLICOLOR CLICOLOR_FORCE; export NO_COLOR=1 CI=1 PAGER=cat EXEC_TAG="${execTag}"; cd "${posixCwd}" && ${escapeSingleQuote(command)}'`];
        spawnCwd = undefined; // let WSL handle cd
      } else if (process.env.QWEN_SHELL_MODE !== "cmd" && posixShell()) {
        // POSIX shell routing: the command is handed to a real bash-compatible
        // shell (Git Bash preferred) as a single -c operand via an argv array,
        // never through `cmd.exe /c` string interpolation (which mangles
        // quotes and lacks POSIX pipes/utilities).
        //
        // CWD fidelity: Git Bash consumes Windows paths (D:\foo\bar) as cwd
        // directly, so the normalized path is passed verbatim. If a
        // POSIX-style path (/mnt/d/x) arrives, translate it with
        // toWindowsPath() (maps /mnt/d/x -> D:\x) — never by naive string
        // concat, which can mis-resolve through a junction.
        let posixSpawnCwd = effectiveCwd;
        if (effectiveCwd.startsWith("/")) {
          posixSpawnCwd = toWindowsPath(effectiveCwd);
        }
        executable = posixShell();
        // `exec -a` sets the process argv[0] to the exec tag (so the anchored
        // pgrep sweep can match it) and the command is single-quote-wrapped
        // with the ''' escape idiom so it cannot break out of the quoting.
        args = ["-c", `exec -a "${execTag}" bash -c 'unset FORCE_COLOR CLICOLOR CLICOLOR_FORCE; export NO_COLOR=1 CI=1 PAGER=cat EXEC_TAG="${execTag}"; ${escapeSingleQuote(command)}'`];
        spawnCwd = posixSpawnCwd;
      } else {
        // cmd.exe path: used when no POSIX shell is available or when
        // QWEN_SHELL_MODE=cmd is set.
        executable = process.env.ComSpec || "cmd.exe";
        args = ["/d", "/s", "/c", command];
      }
    } else {
      executable = "bash";
      // `exec -a` sets the process argv[0] to the exec tag and the command is
      // single-quote-wrapped with the ''' escape idiom so it cannot break out
      // of the quoting.
      args = ["-c", `exec -a "${execTag}" bash -c 'unset FORCE_COLOR CLICOLOR CLICOLOR_FORCE; export NO_COLOR=1 CI=1 PAGER=cat EXEC_TAG="${execTag}"; ${escapeSingleQuote(command)}'`];
    }

    // Final pre-spawn dead-man assertion barrier
    assertDeadManFuse(command);

    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;

      // Deterministic plain-text tool output: the orchestrator's terminal
      // env must not leak into command results. Node >= 24 honors
      // FORCE_COLOR even on piped stdout (colorizing e.g. console.log) and
      // ignores NO_COLOR while FORCE_COLOR is set — so strip the
      // color-forcing vars and set NO_COLOR instead.
      const childEnv = { ...process.env, PAGER: "cat", CI: "1", EXEC_TAG: execTag };
      delete childEnv.FORCE_COLOR;
      delete childEnv.CLICOLOR_FORCE;
      delete childEnv.CLICOLOR;
      childEnv.NO_COLOR = "1";

      const child = spawn(executable, args, {
        cwd: spawnCwd,
        env: childEnv,
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

      const MAX_OUTPUT_BYTES = 48 * 1024; // 48KB (~12k tokens, industry standard)
      const MAX_CAPTURE_BYTES = 256 * 1024; // 256KB buffer ceiling to bound process memory

      function truncateHeadTail(text) {
        if (!text || Buffer.byteLength(text, "utf8") <= MAX_OUTPUT_BYTES) return text;
        const half = Math.floor(MAX_OUTPUT_BYTES / 2);
        const head = text.slice(0, half);
        const tail = text.slice(-half);
        const totalKb = (Buffer.byteLength(text, "utf8") / 1024).toFixed(1);
        const retainedKb = (MAX_OUTPUT_BYTES / 1024).toFixed(1);
        return `${head}\n\n... [Output truncated: ${retainedKb}KB retained out of ${totalKb}KB. Showing head and tail. Use grep, head, or tail to isolate specific lines] ...\n\n${tail}`;
      }

      child.stdout.on("data", (chunk) => {
        if (stdout.length < MAX_CAPTURE_BYTES) {
          stdout += chunk.toString("utf8");
        }
      });

      child.stderr.on("data", (chunk) => {
        if (stderr.length < MAX_CAPTURE_BYTES) {
          stderr += chunk.toString("utf8");
        }
      });

      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          stdout: truncateHeadTail(stdout).trim(),
          stderr: truncateHeadTail(stderr + `\n[Spawn error: ${err.message}]`).trim(),
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
          stdout: truncateHeadTail(stdout).trim(),
          stderr: truncateHeadTail(stderr + (signal ? `\n[Process terminated by signal ${signal}]` : "")).trim(),
          exitCode: resolvedExitCode,
          timedOut: false,
          latencyMs: Date.now() - t0,
        });
      });
    });
  }
}

/**
 * Castor Plugin to mount ShellExecutorService into Context.
 */
export function shellExecutorPlugin(ctx, options = {}) {
  const executor = new ShellExecutorService(options);
  ctx.provide("shell", executor);

  ctx.registerTool("bash", {
    description: "Execute a shell command with timeout protection and process group cleanup. Use strictly for builds, test suites, package managers, git commands, and executing project binaries or runtimes. Do not use bash for file reading (use read_file), code search (use search_code), directory listing (use list_dir), or text editing (use edit_file).",
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

}
