import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { IS_WINDOWS, BOOT_TIMEOUT_MS } from "./config.js";
import { wslDistro, wslHome, winHome, apiKeyCandidates } from "./platform.js";

const execFileAsync = promisify(execFile);

/**
 * Checks if a target path resides inside the WSL filesystem.
 */
export function isWslLocation(inputPath) {
  if (!inputPath) return false;
  const p = inputPath.trim();
  return (
    p.startsWith("/home/") ||
    p.startsWith("/root/") ||
    p.startsWith("/etc/") ||
    p.startsWith("/var/") ||
    p.startsWith("/usr/") ||
    p.startsWith("/tmp/") ||
    /^\\\\wsl(?:\.localhost|\$)\\/i.test(p)
  );
}

/**
 * Normalizes any path to a clean POSIX WSL path (e.g. <wslHome>/Work).
 */
export function toPosixWslPath(inputPath) {
  if (!inputPath) return wslHome();
  let p = inputPath.trim();
  const uncMatch = p.match(/^\\\\wsl(?:\.localhost|\$)\\[^\\]+\\(.*)/i);
  if (uncMatch) {
    return `/${uncMatch[1].replace(/\\/g, "/")}`;
  }
  const winMatch = p.match(/^([a-zA-Z]):[\\/](.*)/);
  if (winMatch) {
    const drive = winMatch[1].toLowerCase();
    const sub = winMatch[2].replace(/\\/g, "/");
    return `/mnt/${drive}/${sub}`;
  }
  return p.replace(/\\/g, "/");
}

/**
 * Normalizes any path to a valid Windows path (e.g. D:\LLM_Ecosystem or \\wsl.localhost\<distro>\home\...).
 */
export function toWindowsPath(inputPath) {
  if (!inputPath) return process.cwd();
  let p = inputPath.trim();
  if (p.startsWith("/home/")) {
    return `\\\\wsl.localhost\\${wslDistro()}${p.replace(/\//g, "\\")}`;
  }
  const mntMatch = p.match(/^\/mnt\/([a-zA-Z])\/(.*)/);
  if (mntMatch) {
    const drive = mntMatch[1].toUpperCase();
    const sub = mntMatch[2].replace(/\//g, "\\");
    return `${drive}:\\${sub}`;
  }
  return p;
}

/**
 * Normalizes workspace paths bidirectionally across Windows host and WSL POSIX.
 */
export function normalizeWorkspacePath(inputPath) {
  if (!inputPath) return process.cwd();
  let p = inputPath.trim();
  return IS_WINDOWS ? toWindowsPath(p) : toPosixWslPath(p);
}

/**
 * P4i: Canonicalize a path through the OS symlink/junction resolution layer.
 *
 * On Windows, `fs.realpathSync` resolves NTFS junctions (e.g. the
 * `D:\mnt\d -> D:\` junction on this machine) and reparse points. On
 * Linux/WSL it resolves POSIX symlinks. The result is the "real" path
 * that the filesystem actually uses, which is what containment checks
 * must compare against.
 *
 * Never-throw discipline: if the path does not yet exist (e.g. a root
 * directory that has not been created), or if realpath fails for any
 * reason, we fall back to the normalized literal. This keeps the
 * constructor safe for not-yet-created roots while still canonicalizing
 * every path that actually exists on disk.
 *
 * @param {string} p A path (Windows or POSIX form).
 * @returns {string} The realpath-resolved path, or the normalized literal
 *   if realpath could not be performed.
 */
export function canonicalizePath(p) {
  if (!p) return p;
  const normalized = path.normalize(p);
  try {
    // Fast path: the full path exists → resolve it entirely (junctions,
    // symlinks, reparse points). This is the common case for existing files.
    return fs.realpathSync(normalized);
  } catch {
    // The full path does not exist yet (e.g. a new file being written).
    // Resolve the LONGEST EXISTING PREFIX through the OS symlink/junction
    // layer, then re-append the non-existent tail verbatim. This keeps the
    // "real" form of the path consistent with the real root so containment
    // comparisons never produce a false escape, while a genuinely outside
    // path still resolves to a real location outside the real root.
    let dir = path.dirname(normalized);
    let tail = path.basename(normalized);
    while (dir && dir !== path.dirname(dir)) {
      try {
        const realDir = fs.realpathSync(dir);
        return path.join(realDir, tail);
      } catch {
        // This ancestor does not exist either — climb one level up and fold
        // its basename into the pending tail.
        const parent = path.dirname(dir);
        if (parent === dir) break; // reached the filesystem root
        tail = path.join(path.basename(dir), tail);
        dir = parent;
      }
    }
    // No existing ancestor could be resolved (should be rare); fall back to
    // the normalized literal. Never throw from a constructor.
    return normalized;
  }
}

export function getGooseExecutable() {
  if (IS_WINDOWS) {
    return path.join(winHome(), ".local", "bin", "goose.exe");
  }
  const wslGoose = `${wslHome()}/.local/bin/goose`;
  if (existsSync(wslGoose)) {
    return wslGoose;
  }
  return "goose";
}

let cachedApiKey = null;
export function getApiKeySync() {
  if (cachedApiKey) return cachedApiKey;
  const candidatePaths = apiKeyCandidates();

  for (const cp of candidatePaths) {
    try {
      if (existsSync(cp)) {
        cachedApiKey = readFileSync(cp, "utf8").trim();
        return cachedApiKey;
      }
    } catch {}
  }
  return "EMPTY";
}

export function killProcessTree(child, sessionId) {
  if (sessionId) {
    if (IS_WINDOWS) {
      execFile("wsl.exe", ["-d", wslDistro(), "--", "pkill", "-9", "-f", `goose run --name ${sessionId}`], () => {});
    } else {
      execFile("pkill", ["-9", "-f", `goose run --name ${sessionId}`], () => {});
    }
  }
  if (!child?.pid) return;
  if (IS_WINDOWS) {
    execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], () => {});
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {}
    }
  }
}

export function killProcessTreeSync(child, tag) {
  if (tag) {
    try {
      if (IS_WINDOWS) {
        execFileSync("wsl.exe", ["-d", wslDistro(), "--", "pkill", "-9", "-f", tag], {
          timeout: 3000,
          stdio: "ignore",
        });
      } else {
        execFileSync("pkill", ["-9", "-f", tag], {
          timeout: 3000,
          stdio: "ignore",
        });
      }
    } catch {}
  }
  if (!child?.pid) return;
  if (IS_WINDOWS) {
    try {
      execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        timeout: 3000,
        stdio: "ignore",
      });
    } catch {}
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {}
    }
  }
}

export function runWslCommand(cmd) {
  if (IS_WINDOWS) {
    return execFileAsync("wsl.exe", ["-d", wslDistro(), "--", "bash", "-c", cmd], {
      timeout: BOOT_TIMEOUT_MS + 10_000,
    });
  } else {
    return execFileAsync("bash", ["-c", cmd], {
      timeout: BOOT_TIMEOUT_MS + 10_000,
    });
  }
}
