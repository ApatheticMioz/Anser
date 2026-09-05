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
import { IS_WINDOWS, QWEN_STATE_DIR } from "./config.js";
import {
  isWslLocation,
  toPosixWslPath,
  toWindowsPath,
  normalizeWorkspacePath,
} from "./wsl_bridge.js";

// Re-export the Windows<->POSIX path translators (do NOT reimplement them).
export { isWslLocation, toPosixWslPath, toWindowsPath, normalizeWorkspacePath };

// ---------------------------------------------------------------------------
// WSL distro / user / home
// ---------------------------------------------------------------------------

/** WSL distro name. Env QWEN_WSL_DISTRO; default "Ubuntu". */
export function wslDistro() {
  return process.env.QWEN_WSL_DISTRO || "Ubuntu";
}

let _wslUser = null;
let _wslHome = null;
let _wslUserProbeOk = null; // null = unknown, true = probe succeeded, false = probe failed

function _probeWslUser() {
  if (!IS_WINDOWS) {
    // Already inside WSL/Linux: the current user IS the WSL user.
    return process.env.USER || process.env.LOGNAME || "root";
  }
  try {
    const out = execFileSync("wsl.exe", ["-d", wslDistro(), "whoami"], {
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const u = out.toString().trim();
    return u || "root";
  } catch {
    // WSL unavailable / probe failed: signal failure (null) so the caller
    // can fall back to root//root without throwing.
    return null;
  }
}

// Test seam: lets offline tests inject a fake whoami probe (mirrors the
// setWslRunner seam in server_lifecycle.js). Pass null to restore the real
// probe. The real probe never throws (it returns null on failure).
let _wslUserProbe = _probeWslUser;
export function setWslUserProbe(fn) {
  _wslUserProbe = typeof fn === "function" ? fn : _probeWslUser;
}

/** Clear the cached WSL user/home so the next call re-probes. Test-only. */
export function _resetWslUserCache() {
  _wslUser = null;
  _wslHome = null;
  _wslUserProbeOk = null;
}

/** WSL user name. Env QWEN_WSL_USER; otherwise probed once via whoami.
 *  Never throws: any probe failure falls back to "root". */
export function wslUser() {
  if (process.env.QWEN_WSL_USER) return process.env.QWEN_WSL_USER;
  if (_wslUser) return _wslUser;
  let u;
  let ok = true;
  try {
    u = _wslUserProbe();
  } catch {
    u = null;
    ok = false;
  }
  _wslUserProbeOk = ok;
  _wslUser = u || "root";
  return _wslUser;
}

/** WSL home directory. Env QWEN_WSL_HOME; otherwise /home/<wslUser>.
 *  When the whoami probe FAILED (WSL unavailable) it falls back to /root. */
export function wslHome() {
  if (process.env.QWEN_WSL_HOME) return process.env.QWEN_WSL_HOME;
  if (_wslHome) return _wslHome;
  if (_wslUserProbeOk === false) {
    _wslHome = "/root";
    return _wslHome;
  }
  _wslHome = `/home/${wslUser()}`;
  return _wslHome;
}

// ---------------------------------------------------------------------------
// Windows home (host-side user home, e.g. C:\Users\<user>)
// ---------------------------------------------------------------------------

/** Windows host home directory (e.g. C:\Users\<user>). Env QWEN_WIN_HOME; default os.homedir(). */
export function winHome() {
  if (process.env.QWEN_WIN_HOME) return process.env.QWEN_WIN_HOME;
  return os.homedir();
}

/**
 * The Windows user home as seen from WITHIN WSL (e.g. /mnt/c/Users/<user>),
 * used to share the .qwen state dir between the Windows MCP server and the
 * WSL engine. Env QWEN_WIN_HOME_WSL overrides. When unset, derived from
 * QWEN_WIN_HOME if it is a Windows path (C:\Users\X -> /mnt/c/Users/X);
 * otherwise returns "" so callers fall back to the WSL user's own home.
 */
export function winHomeWsl() {
  if (process.env.QWEN_WIN_HOME_WSL) return process.env.QWEN_WIN_HOME_WSL;
  const win = process.env.QWEN_WIN_HOME || (IS_WINDOWS ? os.homedir() : "");
  const m = win.match(/^([a-zA-Z]):[\\\/](.*)$/);
  if (m) return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, "/")}`;
  return "";
}

// ---------------------------------------------------------------------------
// Goose binary
// ---------------------------------------------------------------------------

let _gooseBin = null;
function _probeGooseBin() {
  try {
    const cmd = IS_WINDOWS ? "where.exe" : "which";
    const out = execFileSync(cmd, ["goose"], {
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const first = out.toString().split(/\r?\n/)[0].trim();
    return first || "goose";
  } catch {
    return "goose";
  }
}

/** Goose executable. Env QWEN_GOOSE_BIN; else which/where probe; else "goose". */
export function gooseBin() {
  if (process.env.QWEN_GOOSE_BIN) return process.env.QWEN_GOOSE_BIN;
  if (_gooseBin) return _gooseBin;
  _gooseBin = _probeGooseBin();
  return _gooseBin;
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
// State dir (re-exported from config.js for a single import site)
// ---------------------------------------------------------------------------

/** The Qwen state directory (re-exported from config.js). */
export function stateDir() {
  return QWEN_STATE_DIR;
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
