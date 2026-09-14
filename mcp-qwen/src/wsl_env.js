/**
 * src/wsl_env.js — Leaf module: stateless WSL environment resolvers.
 *
 * Extracted from platform.js via dependency inversion so that config.js can
 * import winHomeWsl() WITHOUT importing platform.js. This breaks the
 * config.js <-> platform.js import cycle that produced a TDZ ReferenceError
 * on Linux CI: when platform.js was the entry, its `_wslUser` cache (a
 * module-level `let`) was still in the temporal dead zone while config.js's
 * QWEN_STATE_DIR IIFE called winHomeWsl() at module-eval time.
 *
 * This module is a LEAF: it imports only node builtins and the leaf env.js.
 * It carries the WSL user/home probe cache and the test seams. The
 * Windows<->POSIX path translators remain in wsl_bridge.js (re-exported by
 * platform.js) and are NOT reimplemented here.
 */
import fs from "node:fs";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { IS_WINDOWS } from "./env.js";

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

/**
 * The Windows user home as seen from WITHIN WSL (e.g. /mnt/c/Users/<user>),
 * used to share the .qwen state dir between the Windows MCP server and the
 * WSL engine. Env QWEN_WIN_HOME_WSL overrides. When unset, derived from
 * QWEN_WIN_HOME if it is a Windows path (C:\Users\X -> /mnt/c/Users/X);
 * when running inside WSL, auto-probes /mnt/c/Users/<user>; otherwise returns
 * "" so callers fall back to the WSL user's own home.
 *
 * NOTE: the fs.existsSync probe below requires the `fs` import (previously
 * missing in platform.js — a latent Linux bug swallowed by the try/catch).
 */
export function winHomeWsl() {
  if (process.env.QWEN_WIN_HOME_WSL) return process.env.QWEN_WIN_HOME_WSL;
  const win = process.env.QWEN_WIN_HOME || (IS_WINDOWS ? os.homedir() : "");
  const m = win.match(/^([a-zA-Z]):[\\\/](.*)$/);
  if (m) return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, "/")}`;
  if (!IS_WINDOWS) {
    const candidates = [
      `/mnt/c/Users/${wslUser()}`,
      `/mnt/c/Users/${process.env.USER || ""}`,
      `/mnt/c/Users/${process.env.LOGNAME || ""}`,
    ];
    for (const c of candidates) {
      try {
        if (c && c !== "/mnt/c/Users/" && fs.existsSync(c)) return c;
      } catch {}
    }
  }
  return "";
}
