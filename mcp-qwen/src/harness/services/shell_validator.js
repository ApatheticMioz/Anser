/**
 * ============================================================================
 * ⚠️ DANGER DANGER DANGER — STRICT ISOLATION ENCLAVE — READ BEFORE EDITING ⚠️
 * ============================================================================
 *
 * ATTENTION ALL FUTURE AGENTS & DEVELOPERS:
 * 1. NEVER IMPORT `node:child_process` IN THIS FILE.
 * 2. NEVER ADD ANY PROCESS SPAWNING, EXECUTION, OR SYSTEM-CALL PRIMITIVES HERE.
 * 3. THIS FILE MUST REMAIN A PURE, ZERO-DEPENDENCY IN-MEMORY STRING PARSER.
 * 4. ALL ADVERSARIAL AND DESTRUCTIVE TEST VECTORS (rm, del, format, etc.)
 *    MUST ONLY BE EVALUATED THROUGH THIS MODULE'S VALIDATOR FUNCTIONS.
 *
 * VIOLATION OF THIS INVARIANT CREATES A HOST ESCAPE & DESTRUCTION HAZARD.
 * AUTOMATED AUDIT IN `tests/security.test.js` CATEGORY 5e ENFORCES THIS RULE.
 * ============================================================================
 *
 * Pure In-Memory Shell Security Validator & Policy Enforcement Service
 *
 * ARCHITECTURAL SAFETY GUARANTEE:
 * - ZERO imports of `node:child_process`
 * - ZERO execution primitives (no exec, no spawn, no system calls)
 * - Safe for direct import by test suites, security probes, and validation gates
 *
 * Provides:
 * - Path-aware protected-roots analysis (blocks root, home, Windows/Users, raw dev)
 * - Recursive command unwrapping (sudo, doas, env, nice, nohup, xargs, shell -c)
 * - Fail-closed refusal of unexpanded shell references ($VAR, $(cmd), backticks)
 * - Windows flag disambiguation (/s /q as flags, not path operands)
 * - Hard-coded in-memory dead-man fuse with synthetic canary token support
 */

import path from "node:path";
import { wslHome, winHome, winHomeWsl, toPosixWslPath } from "../../platform.js";

// ---------------------------------------------------------------------------
// Pattern-level blocks (verbatim, not path-aware).
// These match catastrophic commands by signature regardless of target path.
// ---------------------------------------------------------------------------
export const PATTERN_LEVEL_BLOCKS = [
  /\b(mkfs(\.[a-z0-9]+)?|fdisk|parted)\b/i,
  /\bformat\s+[A-Za-z]:/i,
  /\bdd\s+.*of=\/dev\/(sd[a-z]|nvme|hd[a-z]|vd[a-z])/i,
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/
];

// Destructive commands that operate on path operands.
// Includes POSIX (rm) and Windows/PowerShell forms (del, rmdir, rd,
// remove-item, ri, erase) so PowerShell/cmd aliases are analyzed too.
export const DESTRUCTIVE_COMMANDS = new Set([
  "rm", "del", "rmdir", "rd", "remove-item", "ri", "erase",
]);

// Transparent prefix commands that are skipped before the real command.
// `env` may be followed by VAR=value tokens, which are also skipped.
export const TRANSPARENT_PREFIXES = new Set([
  "sudo", "doas", "env", "nice", "nohup", "xargs",
]);

// Shell wrappers: a shell command followed by its string-arg flag carries the
// real command as an inner string. "single" = inner is the next (quoted) token;
// "rest" = inner is the concatenation of all remaining tokens (cmd /c style).
export const SHELL_WRAPPERS = {
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
export const MAX_UNWRAP_DEPTH = 4;

// Known Windows flag tokens (slash-prefixed single-letter flags).
// On Windows, `del /s /q` uses slashes as flags, not path separators.
export const WINDOWS_FLAG_TOKENS = new Set([
  "/f", "/s", "/q", "/p", "/a", "/c", "/e", "/t", "/y", "/i",
]);

// Dedicated non-destructive synthetic canary token for zero-risk fuse testing.
export const CANARY_DISASTER_FUSE_TOKEN = "__CANARY_TRIGGER_DISASTER_FUSE__";

/**
 * Hard-coded in-memory dead-man fuse.
 * Pure string verification designed to sit directly before any live execution boundary.
 * Throws FatalDeadManFuseError if tripped.
 */
export function assertDeadManFuse(command) {
  if (!command || typeof command !== "string") return;

  if (command.includes(CANARY_DISASTER_FUSE_TOKEN)) {
    throw new Error("FatalDeadManFuseError: Execution halted by dead-man fuse (synthetic canary tripped)");
  }

  for (const pattern of PATTERN_LEVEL_BLOCKS) {
    if (pattern.test(command)) {
      throw new Error(`FatalDeadManFuseError: Execution halted by dead-man fuse. Matches catastrophic signature: ${pattern}`);
    }
  }
}

/**
 * Quote-aware tokenizer: splits a command string into tokens,
 * preserving quoted substrings (both single and double quotes).
 */
export function tokenizeCommand(cmd) {
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
export function commandNameOf(token) {
  if (!token) return "";
  const parts = token.split(/[\\/]/);
  return parts[parts.length - 1].toLowerCase();
}

/** Determine whether a token is a flag/option (not a path operand). */
export function isFlag(token) {
  if (token.startsWith("-")) return true; // POSIX flag
  if (WINDOWS_FLAG_TOKENS.has(token.toLowerCase())) return true; // Windows flag
  return false;
}

/**
 * Fail-closed guard: a destructive operand containing an unexpanded shell
 * reference ($VAR, ${VAR}, $(...), backtick) cannot be safely resolved, so it
 * must be blocked. Literal paths (no $) are unaffected.
 */
export function hasUnexpandedReference(operand) {
  return /\$/.test(operand);
}

/**
 * Expand `~` using the platform resolvers.
 * Windows-form commands (del/rmdir/rd) use winHome();
 * POSIX-form commands (rm) use wslHome().
 */
export function expandTilde(operand, isWindowsCmd) {
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
export function normalizeOperand(operand, cwd, isWindowsCmd) {
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
export function buildProtectedRoots() {
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
export function getProtectedRoots() {
  if (!_protectedRoots) {
    _protectedRoots = buildProtectedRoots();
  }
  return _protectedRoots;
}

/**
 * Check whether a normalized POSIX path is a protected root or its direct wildcard.
 * Also blocks /dev/sd* and related raw-device targets.
 */
export function isProtectedRootOrWildcard(posixPath) {
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
export function analyzeCommand(command, cwd, depth) {
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

/**
 * Top-level shell safety validator.
 * Enforces CWD containment within the workspace and runs recursive path-aware analysis.
 */
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
