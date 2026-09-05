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
import path from "node:path";
import { IS_WINDOWS } from "../../config.js";
import { isWslLocation, normalizeWorkspacePath, killProcessTreeSync } from "../../wsl_bridge.js";
import { wslHome, winHome, winHomeWsl, toPosixWslPath } from "../../platform.js";

// ---------------------------------------------------------------------------
// Pattern-level blocks (verbatim, not path-aware).
// These match catastrophic commands by signature regardless of target path.
// ---------------------------------------------------------------------------
const PATTERN_LEVEL_BLOCKS = [
  /\b(mkfs(\.[a-z0-9]+)?|fdisk|parted)\b/i,
  /\bformat\s+[A-Za-z]:/i,
  /\bdd\s+.*of=\/dev\/(sd[a-z]|nvme|hd[a-z]|vd[a-z])/i,
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/
];

// Destructive commands that operate on path operands.
// Includes POSIX (rm) and Windows/PowerShell forms (del, rmdir, rd,
// remove-item, ri, erase) so PowerShell/cmd aliases are analyzed too.
const DESTRUCTIVE_COMMANDS = new Set([
  "rm", "del", "rmdir", "rd", "remove-item", "ri", "erase",
]);

// Transparent prefix commands that are skipped before the real command.
// `env` may be followed by VAR=value tokens, which are also skipped.
const TRANSPARENT_PREFIXES = new Set([
  "sudo", "doas", "env", "nice", "nohup", "xargs",
]);

// Shell wrappers: a shell command followed by its string-arg flag carries the
// real command as an inner string. "single" = inner is the next (quoted) token;
// "rest" = inner is the concatenation of all remaining tokens (cmd /c style).
const SHELL_WRAPPERS = {
  bash: { flags: new Set(["-c"]), inner: "single" },
  sh: { flags: new Set(["-c"]), inner: "single" },
  dash: { flags: new Set(["-c"]), inner: "single" },
  zsh: { flags: new Set(["-c"]), inner: "single" },
  cmd: { flags: new Set(["/c"]), inner: "rest" },
  "cmd.exe": { flags: new Set(["/c"]), inner: "rest" },
  powershell: { flags: new Set(["-command"]), inner: "single" },
  pwsh: { flags: new Set(["-command"]), inner: "single" },
};

// Bounded recursion depth for unwrapping nested shell wrappers.
const MAX_UNWRAP_DEPTH = 4;

// Known Windows flag tokens (slash-prefixed single-letter flags).
// On Windows, `del /s /q` uses slashes as flags, not path separators.
const WINDOWS_FLAG_TOKENS = new Set([
  "/f", "/s", "/q", "/p", "/a", "/c", "/e", "/t", "/y", "/i",
]);

/**
 * Quote-aware tokenizer: splits a command string into tokens,
 * preserving quoted substrings (both single and double quotes).
 */
function tokenizeCommand(cmd) {
  const tokens = [];
  let cur = "";
  let quote = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        cur += ch;
      }
    } else {
      if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === " " || ch === "\t") {
        if (cur.length) tokens.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }
  }
  if (cur.length) tokens.push(cur);
  return tokens;
}

/** Extract the command name (basename, lowercased) from the first token. */
function commandNameOf(token) {
  if (!token) return "";
  const parts = token.split(/[\\/]/);
  return parts[parts.length - 1].toLowerCase();
}

/** Determine whether a token is a flag/option (not a path operand). */
function isFlag(token) {
  if (token.startsWith("-")) return true; // POSIX flag
  if (WINDOWS_FLAG_TOKENS.has(token.toLowerCase())) return true; // Windows flag
  return false;
}

/**
 * Fail-closed guard: a destructive operand containing an unexpanded shell
 * reference ($VAR, ${VAR}, $(...), backtick) cannot be safely resolved, so it
 * must be blocked. Literal paths (no $) are unaffected.
 */
function hasUnexpandedReference(operand) {
  return /\$/.test(operand);
}

/**
 * Expand `~` using the platform resolvers.
 * Windows-form commands (del/rmdir/rd) use winHome();
 * POSIX-form commands (rm) use wslHome().
 */
function expandTilde(operand, isWindowsCmd) {
  if (operand === "~") {
    return isWindowsCmd ? winHome() : wslHome();
  }
  if (operand.startsWith("~/") || operand.startsWith("~\\")) {
    const home = isWindowsCmd ? winHome() : wslHome();
    return home + operand.slice(1).replace(/\\/g, "/");
  }
  return operand;
}

/**
 * Normalize a path operand to a canonical POSIX form (lowercased, no trailing slash).
 * Uses the wsl_bridge translators (re-exported from platform.js) for Windows<->POSIX.
 */
function normalizeOperand(operand, cwd, isWindowsCmd) {
  let p = expandTilde(operand, isWindowsCmd);
  // Convert to POSIX form via the existing translator
  let posix = toPosixWslPath(p);
  // Preserve a trailing wildcard component (e.g. "/*", "C:\Users\*") so it is
  // not collapsed away by path normalization.
  let wildcard = "";
  if (posix.endsWith("/*")) {
    wildcard = "/*";
    posix = posix.slice(0, -2);
  } else if (posix.endsWith("*")) {
    wildcard = "*";
    posix = posix.slice(0, -1);
  }
  // A bare "/*" collapses to an empty string after stripping; treat as root.
  if (posix === "") {
    posix = "/";
  }
  // Resolve relative operands against the sandbox cwd
  if (!posix.startsWith("/")) {
    const cwdPosix = toPosixWslPath(cwd || process.cwd());
    posix = path.posix.join(cwdPosix, posix);
  }
  // Normalize (resolve . and ..)
  posix = path.posix.normalize(posix);
  // Strip trailing slash (except for the filesystem root)
  if (posix !== "/" && posix.endsWith("/")) {
    posix = posix.replace(/\/+$/, "");
  }
  // Re-attach the preserved wildcard. For the filesystem root the direct
  // wildcard is "/*" (not "//*"), so attach without a leading slash.
  if (wildcard) {
    posix = posix === "/" ? wildcard : posix + wildcard;
  }
  return posix.toLowerCase();
}

/**
 * Build the set of protected roots in canonical POSIX form (lowercased).
 * Includes: filesystem root, WSL home, Windows home (as /mnt/c/Users/<user>),
 * all drive roots (/mnt/a/ through /mnt/z/), C:\Windows, C:\Users, C:\Program Files.
 */
function buildProtectedRoots() {
  const roots = new Set();
  roots.add("/"); // filesystem root
  // WSL home (~)
  const wh = wslHome();
  if (wh) roots.add(wh.toLowerCase());
  // Windows home as seen from WSL
  const whw = winHomeWsl();
  if (whw) roots.add(whw.toLowerCase());
  // Drive roots: /mnt/a through /mnt/z
  for (let i = 0; i < 26; i++) {
    const letter = String.fromCharCode(97 + i);
    roots.add(`/mnt/${letter}`);
  }
  // C:\Windows, C:\Users, C:\Program Files
  roots.add("/mnt/c/windows");
  roots.add("/mnt/c/users");
  roots.add("/mnt/c/program files");
  return roots;
}

// Lazy cache for protected roots (platform resolvers are cached; this is cheap).
let _protectedRoots = null;
function getProtectedRoots() {
  if (!_protectedRoots) {
    _protectedRoots = buildProtectedRoots();
  }
  return _protectedRoots;
}

/**
 * Check whether a normalized POSIX path is a protected root or its direct wildcard.
 * Also blocks /dev/sd* and related raw-device targets.
 */
function isProtectedRootOrWildcard(posixPath) {
  const p = posixPath.toLowerCase();
  // Raw device targets: /dev/sdX, /dev/nvmeXnY, /dev/hdX, /dev/vdX (and direct wildcards)
  if (/^\/dev\/(sd[a-z]+|nvme\d+n\d+|hd[a-z]+|vd[a-z]+)(\/\*)?$/.test(p)) return true;
  for (const root of getProtectedRoots()) {
    if (p === root) return true;
    // The filesystem root's direct wildcard is "/*" (not "//*").
    const directWildcard = root === "/" ? "/*" : root + "/*";
    if (p === directWildcard) return true;
  }
  return false;
}

export function validateShellSafety(command, effectiveCwd, rootCwd) {
  if (!command || typeof command !== "string" || command.trim().length === 0) {
    throw new Error("InvalidCommandError: Shell command must be a non-empty string");
  }

  // CWD containment check: ensure working directory is within workspace
  if (effectiveCwd && rootCwd) {
    const normTarget = path.normalize(effectiveCwd);
    const normRoot = path.normalize(rootCwd);
    const rel = path.relative(normRoot, normTarget);
    if (rel.startsWith("..") || (path.isAbsolute(rel) && !rel.startsWith(normRoot))) {
      throw new Error(`PathEscapeError: Working directory '${effectiveCwd}' escapes workspace root '${rootCwd}'`);
    }
  }

  // Path-aware protected-roots analysis (recursive: unwraps prefixes/wrappers).
  const cwd = effectiveCwd || rootCwd || process.cwd();
  analyzeCommand(command, cwd, 0);
}

/**
 * Recursively analyze a command string for destructive intent.
 *
 * At each level:
 *   1. Run the verbatim pattern-level blocks (fork bomb, mkfs, format, dd).
 *   2. Tokenize and skip transparent prefixes (sudo/doas/env+VAR=nice/nohup/xargs).
 *   3. If the command is a shell wrapper (bash/sh/dash/zsh -c, cmd /c,
 *      powershell/pwsh -Command), recurse on the inner command string
 *      (bounded depth to avoid pathological nesting).
 *   4. If the command is a destructive path command (rm/del/rmdir/rd/
 *      remove-item/ri/erase), fail closed on unexpanded shell references and
 *      block any operand that normalizes to a protected root or its wildcard.
 */
function analyzeCommand(command, cwd, depth) {
  // Pattern-level blocks (verbatim, not path-aware). Run at every recursion
  // level so wrapped forms (e.g. `bash -c "mkfs ..."`) are caught too.
  for (const pattern of PATTERN_LEVEL_BLOCKS) {
    if (pattern.test(command)) {
      throw new Error(`CommandSecurityError: Execution blocked. Command matches prohibited destructive pattern: ${pattern}`);
    }
  }

  const tokens = tokenizeCommand(command);
  if (tokens.length === 0) return;

  // Skip transparent prefix commands (and env's VAR=value tokens).
  let i = 0;
  while (i < tokens.length) {
    const name = commandNameOf(tokens[i]);
    if (name === "env") {
      i++;
      while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) {
        i++;
      }
      continue;
    }
    if (TRANSPARENT_PREFIXES.has(name)) {
      i++;
      continue;
    }
    break;
  }
  if (i >= tokens.length) return;

  const name = commandNameOf(tokens[i]);

  // Shell wrapper: recurse on the inner command string (bounded depth).
  const wrapper = SHELL_WRAPPERS[name];
  if (wrapper) {
    if (depth < MAX_UNWRAP_DEPTH && i + 1 < tokens.length && wrapper.flags.has(tokens[i + 1].toLowerCase())) {
      let inner;
      if (wrapper.inner === "single") {
        if (i + 2 < tokens.length) inner = tokens[i + 2];
      } else {
        if (i + 2 < tokens.length) inner = tokens.slice(i + 2).join(" ");
      }
      if (inner !== undefined) {
        analyzeCommand(inner, cwd, depth + 1);
      }
    }
    return; // a shell wrapper is not itself a destructive path command
  }

  // Destructive path command: fail closed on unexpanded refs, then check roots.
  if (DESTRUCTIVE_COMMANDS.has(name)) {
    const isWindowsCmd = name !== "rm"; // rm is POSIX; the rest are Windows forms
    const operands = [];
    for (let j = i + 1; j < tokens.length; j++) {
      if (!isFlag(tokens[j])) {
        operands.push(tokens[j]);
      }
    }
    for (const operand of operands) {
      // Fail closed: an unexpanded shell reference cannot be safely resolved.
      if (hasUnexpandedReference(operand)) {
        throw new Error(
          `CommandSecurityError: Execution blocked. Unexpanded shell reference in target '${operand}'`
        );
      }
      const normalized = normalizeOperand(operand, cwd, isWindowsCmd);
      if (isProtectedRootOrWildcard(normalized)) {
        throw new Error(
          `CommandSecurityError: Execution blocked. Target '${operand}' resolves to protected root: ${normalized}`
        );
      }
    }
  }
}


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

    // Strict shell security validation
    validateShellSafety(command, effectiveCwd, this.defaultCwd);

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
