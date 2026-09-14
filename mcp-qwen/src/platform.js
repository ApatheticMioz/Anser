/**
 * src/platform.js — Single resolver for host-specific (machine) values.
 *
 * Every hardcoded machine path / distro / user in the codebase is routed
 * through this module so there is exactly one place that knows about the
 * host layout. All resolvers are:
 *   - env-overridable (QWEN_*),
 *   - lazily resolved and cached,
 *   - safe (never throw; fall back to a sane default).
 *
 * The Windows<->POSIX path translators are re-exported from wsl_bridge.js
 * (NOT reimplemented here).
 */
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { IS_WINDOWS } from "./env.js";
import {
  wslDistro,
  wslUser,
  wslHome,
  winHomeWsl,
  setWslUserProbe,
  _resetWslUserCache,
} from "./wsl_env.js";
import {
  isWslLocation,
  toPosixWslPath,
  toWindowsPath,
  normalizeWorkspacePath,
} from "./wsl_bridge.js";

// Re-export the Windows<->POSIX path translators (do NOT reimplement them).
export { isWslLocation, toPosixWslPath, toWindowsPath, normalizeWorkspacePath };

// ---------------------------------------------------------------------------
// WSL distro / user / home — re-exported from the leaf wsl_env.js.
//
// These resolvers (and their whoami probe cache + test seams) were extracted
// into wsl_env.js via dependency inversion so config.js can import winHomeWsl
// without importing platform.js (breaking the cycle that caused the Linux CI
// TDZ). They are re-exported here so existing consumers are unchanged.
// ---------------------------------------------------------------------------
export {
  wslDistro,
  wslUser,
  wslHome,
  winHomeWsl,
  setWslUserProbe,
  _resetWslUserCache,
};

// ---------------------------------------------------------------------------
// Windows home (host-side user home, e.g. C:\Users\<user>)
// ---------------------------------------------------------------------------

/** Windows host home directory (e.g. C:\Users\<user>). Env QWEN_WIN_HOME; default os.homedir(). */
export function winHome() {
  if (process.env.QWEN_WIN_HOME) return process.env.QWEN_WIN_HOME;
  if (IS_WINDOWS) return os.homedir();
  const wslWin = winHomeWsl();
  if (wslWin) return toWindowsPath(wslWin);
  return os.homedir();
}

// winHomeWsl() is re-exported from wsl_env.js (see the re-export block above);
// its body now lives in the leaf module so config.js can import it without
// importing platform.js.

// ---------------------------------------------------------------------------
// Bare-command resolution (P8 bridge: spawnable absolute paths)
// ---------------------------------------------------------------------------

const _cmdPathCache = new Map();

/**
 * Resolve a bare command name to a spawnable absolute path via which/where.
 * Node's spawn does NOT resolve Windows .cmd shims (npx, uvx) without a
 * shell — and shell mode would break argv-array purity — so callers that
 * must spawn bare package runners on Windows resolve first. Absolute or
 * path-bearing commands pass through untouched. Returns null when the
 * command cannot be found. Lazily probed and cached; never throws.
 * @param {string} command
 * @returns {string|null}
 */
export function resolveCommandPath(command) {
  if (!command || typeof command !== "string") return null;
  if (command.includes("/") || command.includes("\\") || path.isAbsolute(command)) {
    return command;
  }
  if (_cmdPathCache.has(command)) return _cmdPathCache.get(command);
  let resolved = null;
  try {
    const probe = IS_WINDOWS ? "where.exe" : "which";
    const out = execFileSync(probe, [command], {
      timeout: 5000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const first = out
      .toString()
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find(Boolean);
    if (first) resolved = first;
  } catch {}
  _cmdPathCache.set(command, resolved);
  return resolved;
}

/** Clear the resolved-command cache so the next call re-probes. Test-only. */
export function _resetCommandPathCache() {
  _cmdPathCache.clear();
}

// ---------------------------------------------------------------------------
// POSIX shell (bash-compatible) resolver
// ---------------------------------------------------------------------------

let _posixShell = null;
let _posixShellResolved = false;

/**
 * Cheap probe: run `<candidate> -c "echo __ok__"` and check the output.
 * Returns true if the candidate is a working bash-compatible shell.
 * Never throws.
 */
function _probeShellCandidate(candidate) {
  if (!candidate) return false;
  try {
    const out = execFileSync(candidate, ["-c", "echo __ok__"], {
      timeout: 3_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.toString().includes("__ok__");
  } catch {
    return false;
  }
}

// Test seam: lets offline tests inject a fake candidate probe (mirrors the
// setWslUserProbe seam). Pass null to restore the real probe.
let _probeCandidate = _probeShellCandidate;
export function setPosixShellProbeCandidate(fn) {
  _probeCandidate = typeof fn === "function" ? fn : _probeShellCandidate;
}

/** Find `bash` (or `bash.exe`) on PATH. Returns the first match or null. */
function _findBashOnPath() {
  try {
    const cmd = IS_WINDOWS ? "where.exe" : "which";
    const target = IS_WINDOWS ? "bash.exe" : "bash";
    const out = execFileSync(cmd, [target], {
      timeout: 3_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const first = out.toString().split(/\r?\n/)[0].trim();
    return first || null;
  } catch {
    return null;
  }
}

/**
 * Probe the POSIX shell candidates in resolution order:
 *   1. QWEN_POSIX_SHELL env override
 *   2. Git Bash standard locations
 *   3. bash on PATH (last resort, might be the WSL System32 stub)
 * Returns the first candidate that passes the probe, or null.
 */
function _probePosixShell() {
  const candidates = [];
  if (process.env.QWEN_POSIX_SHELL) {
    candidates.push(process.env.QWEN_POSIX_SHELL);
  }
  if (IS_WINDOWS) {
    candidates.push(
      "C:\\Program Files\\Git\\bin\\bash.exe",
      "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
    );
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      candidates.push(path.join(localAppData, "Programs", "Git", "bin", "bash.exe"));
    }
  }
  const onPath = _findBashOnPath();
  if (onPath) candidates.push(onPath);

  for (const c of candidates) {
    if (_probeCandidate(c)) return c;
  }
  return null;
}

/**
 * POSIX shell (bash-compatible) resolver.
 * Env QWEN_POSIX_SHELL overrides; otherwise Git Bash standard locations;
 * otherwise bash on PATH. Lazily resolved and cached. Never throws.
 * Returns null if no working POSIX shell is found.
 */
export function posixShell() {
  if (_posixShellResolved) return _posixShell;
  _posixShell = _probePosixShell();
  _posixShellResolved = true;
  return _posixShell;
}

/** Clear the cached POSIX shell so the next call re-probes. Test-only. */
export function _resetPosixShellCache() {
  _posixShell = null;
  _posixShellResolved = false;
}

// ---------------------------------------------------------------------------
// Stream proxy path (WSL-side)
// ---------------------------------------------------------------------------

/**
 * WSL-side path to the repo's stream_proxy.js, derived from this module's own
 * location (import.meta.url) so it is correct regardless of process.cwd().
 * This file lives at <repo>/src/platform.js; the proxy at <repo>/stream_proxy.js.
 * Env QWEN_STREAM_PROXY_PATH overrides.
 */
export function streamProxyPath() {
  if (process.env.QWEN_STREAM_PROXY_PATH) return process.env.QWEN_STREAM_PROXY_PATH;
  const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  return `${toPosixWslPath(repoRoot)}/stream_proxy.js`;
}

// ---------------------------------------------------------------------------
// API-key candidate paths
// ---------------------------------------------------------------------------

/**
 * Candidate paths for the vLLM API-key file, routed through the resolvers.
 * (Previously a hardcoded list inside wsl_bridge.getApiKeySync.)
 */
export function apiKeyCandidates() {
  const distro = wslDistro();
  const wslHomePath = wslHome();
  // WSL home "/home/<user>" -> "home\<user>" (strip the leading slash so the
  // UNC path stays single-backslash: \\wsl.localhost\<distro>\home\<user>\...).
  const wslHomeWin = wslHomePath.replace(/^\//, "").replace(/\//g, "\\");
  if (IS_WINDOWS) {
    return [
      `\\\\wsl.localhost\\${distro}\\${wslHomeWin}\\qwen-serving\\api_key.txt`,
      `\\\\wsl$\\${distro}\\${wslHomeWin}\\qwen-serving\\api_key.txt`,
      path.join(winHome(), "qwen-serving", "api_key.txt"),
    ];
  }
  return [
    `${wslHomePath}/qwen-serving/api_key.txt`,
    path.join(process.env.HOME || "/root", "qwen-serving", "api_key.txt"),
  ];
}

// ---------------------------------------------------------------------------
// Spawn-profile builder
// ---------------------------------------------------------------------------

/**
 * Build the exact spawn options for a given mode. ONE function replaces the
 * duplicated Windows/WSL branch logic scattered across the codebase.
 *
 *   mode "windows": spawn the command directly (cwd passed through as-is).
 *   mode "wsl":     wrap with `wsl.exe -d <distro> [--user <user>]
 *                   [--cd <posixCwd>] --exec <command> <args...>`.
 *
 * Returns { command, args, options }. This function ONLY spawns — it never
 * kills (kill semantics remain the sole responsibility of wsl_bridge.js).
 *
 * @param {object}   spec
 * @param {string}   spec.command  executable to run (inside the target env)
 * @param {string[]} spec.args     its arguments
 * @param {string}   [spec.cwd]    working dir (Windows or WSL path)
 * @param {object}   [spec.env]    extra env vars (merged over process.env)
 * @param {"windows"|"wsl"} [spec.mode="windows"]
 * @param {Array|string} [spec.stdio]  defaults to ["ignore","pipe","pipe"]
 * @param {string}   [spec.user]   if set, adds `--user <user>` in wsl mode
 * @param {boolean}  [spec.useCd=true] whether to add `--cd` in wsl mode
 * @param {boolean}  [spec.detached] override the default detached flag
 */
export function buildSpawnProfile({
  command,
  args = [],
  cwd,
  env,
  mode = "windows",
  stdio,
  user,
  useCd = true,
  detached,
} = {}) {
  const stdioFinal = stdio || ["ignore", "pipe", "pipe"];
  const mergedEnv = { ...process.env, ...(env || {}) };

  if (mode === "wsl") {
    const distro = wslDistro();
    const wslArgs = ["-d", distro];
    if (user) wslArgs.push("--user", user);
    if (useCd && cwd) wslArgs.push("--cd", toPosixWslPath(cwd));
    wslArgs.push("--exec", command, ...args);
    return {
      command: "wsl.exe",
      args: wslArgs,
      options: {
        env: mergedEnv,
        stdio: stdioFinal,
        detached: false,
      },
    };
  }

  // "windows" mode: spawn directly (cwd passed through as-is).
  return {
    command,
    args,
    options: {
      cwd: cwd || undefined,
      env: mergedEnv,
      stdio: stdioFinal,
      detached: detached !== undefined ? detached : !IS_WINDOWS,
    },
  };
}
