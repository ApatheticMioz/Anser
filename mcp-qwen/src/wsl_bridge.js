import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { IS_WINDOWS, BOOT_TIMEOUT_MS } from "./config.js";
import { wslDistro, wslHome, winHome, apiKeyCandidates } from "./platform.js";
import { pidAlive } from "./semaphore.js";

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

// ---------------------------------------------------------------------------
// P10 — Kill certainty + honest lifecycle
// ---------------------------------------------------------------------------
//
// The legacy kill paths fired a broad `pkill -9 -f 'goose run --name <id>'`
// and never verified the kill landed. Two failure modes were observed live:
//   (a) over-kill: a session id that is a SUBSTRING of another session's id
//       (e.g. "abc" vs "abc123") matched the wrong process;
//   (b) silent failure: the kill was fire-and-forget, so a surviving /
//       zombie process was never detected or escalated.
//
// The hardened path:
//   1. ANCHORS the session-id sweep: it lists candidate pids with a broad
//      `pgrep -f`, then verifies each candidate's full command line has the
//      id at an exact boundary (space or end-of-line) before killing, so a
//      decoy that merely CONTAINS the id as a substring is never over-killed.
//   2. KILLS the direct child pid (taskkill /T /F on Windows, SIGKILL on
//      Linux) and then VERIFIES it is dead via pidAlive (two probes 500ms
//      apart). If still alive it ESCALATES (re-issue the kill) and does a
//      final liveness check.
//   3. Returns a structured { killed, escalations } so callers can log
//      honestly. A pid-less target (already-dead / never a real child) is a
//      no-op success: killed:false, escalations:0 — NOT a failure.

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function sleepSync(ms) {
  // Synchronous sleep for the shutdown-path (killProcessTreeSync) where we
  // cannot await. Blocks the event loop, which is acceptable at process exit.
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

/**
 * Escape a string for use inside a POSIX ERE (pgrep -f pattern).
 */
function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Synchronous WSL command runner (bash -c) for the shutdown path.
 * Returns the raw stdout (Buffer). Never throws.
 */
function runWslCommandSync(cmd) {
  try {
    if (IS_WINDOWS) {
      return execFileSync("wsl.exe", ["-d", wslDistro(), "--", "bash", "-c", cmd], {
        timeout: BOOT_TIMEOUT_MS + 10_000,
        stdio: ["ignore", "pipe", "ignore"],
      });
    }
    return execFileSync("bash", ["-c", cmd], {
      timeout: BOOT_TIMEOUT_MS + 10_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return Buffer.from("");
  }
}

/**
 * Anchored goose-session sweep (async). Lists candidate pids with a broad
 * `pgrep -f`, verifies each candidate's full command line has the session id
 * at an exact boundary (space or end-of-line), and SIGKILLs only the
 * verified pids. A decoy whose command line merely CONTAINS the id as a
 * substring (e.g. "goose run --name <id>123") is never matched.
 *
 * @param {string} sessionId
 * @returns {Promise<number[]>} the verified pids that were killed
 */
export async function killGooseSession(sessionId) {
  const id = String(sessionId);
  let candidates = [];
  try {
    const { stdout } = await runWslCommand(
      `pgrep -f 'goose run --name ${escapeRe(id)}' 2>/dev/null || true`
    );
    candidates = stdout
      .split(/\s+/)
      .map((s) => parseInt(s, 10))
      .filter((n) => Number.isFinite(n) && n > 0);
  } catch {
    return [];
  }
  if (candidates.length === 0) return [];

  // Exact-boundary verification: the id must be followed by a space or
  // end-of-line in the full command line.
  const boundaryRe = new RegExp(`goose run --name ${escapeRe(id)}( |$)`);
  const verified = [];
  for (const pid of candidates) {
    try {
      const { stdout } = await runWslCommand(
        `tr '\\0' ' ' < /proc/${pid}/cmdline 2>/dev/null || true`
      );
      if (boundaryRe.test(stdout)) verified.push(pid);
    } catch {}
  }
  if (verified.length === 0) return [];
  try {
    await runWslCommand(`kill -9 ${verified.join(" ")} 2>/dev/null || true`);
  } catch {}
  return verified;
}

/**
 * Anchored goose-session sweep (synchronous) for the shutdown path.
 * @param {string} sessionId
 */
export function killGooseSessionSync(sessionId) {
  const id = String(sessionId);
  let candidates = [];
  try {
    const out = runWslCommandSync(
      `pgrep -f 'goose run --name ${escapeRe(id)}' 2>/dev/null || true`
    ).toString();
    candidates = out
      .split(/\s+/)
      .map((s) => parseInt(s, 10))
      .filter((n) => Number.isFinite(n) && n > 0);
  } catch {
    return;
  }
  if (candidates.length === 0) return;
  const boundaryRe = new RegExp(`goose run --name ${escapeRe(id)}( |$)`);
  const verified = [];
  for (const pid of candidates) {
    try {
      const cmd = runWslCommandSync(
        `tr '\\0' ' ' < /proc/${pid}/cmdline 2>/dev/null || true`
      ).toString();
      if (boundaryRe.test(cmd)) verified.push(pid);
    } catch {}
  }
  if (verified.length === 0) return;
  try {
    runWslCommandSync(`kill -9 ${verified.join(" ")} 2>/dev/null || true`);
  } catch {}
}

/**
 * Kill a direct child pid (async). Windows: taskkill /T /F. Linux: SIGKILL
 * the process group, falling back to the child handle.
 */
async function killChildDirect(child, pid) {
  if (IS_WINDOWS) {
    await new Promise((resolve) => {
      try {
        execFile("taskkill", ["/PID", String(pid), "/T", "/F"], () => resolve());
      } catch {
        resolve();
      }
    });
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {}
    }
  }
}

/**
 * Kill a direct child pid (synchronous) for the shutdown path.
 */
function killChildDirectSync(child, pid) {
  if (IS_WINDOWS) {
    try {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        timeout: 3000,
        stdio: "ignore",
      });
    } catch {}
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {}
    }
  }
}

/**
 * Post-kill verification: two liveness probes 500ms apart. If either reports
 * the pid alive, the process is considered still alive (a zombie that has not
 * been reaped yet, or a process that ignored the first signal).
 * @returns {Promise<boolean>} true if the pid is still alive
 */
async function verifyDead(pid) {
  const a = pidAlive(pid);
  await sleep(500);
  const b = pidAlive(pid);
  return a || b;
}

/**
 * Synchronous post-kill verification (two probes 500ms apart).
 * @returns {boolean} true if the pid is still alive
 */
function verifyDeadSync(pid) {
  const a = pidAlive(pid);
  sleepSync(500);
  const b = pidAlive(pid);
  return a || b;
}

/**
 * Kill a process tree with post-kill verification and escalation.
 *
 * @param {import("node:child_process").ChildProcess|null} child the direct
 *   child handle (its .pid is the target of the verified kill).
 * @param {string|null} [sessionId] optional goose session id for the anchored
 *   WSL sweep.
 * @returns {Promise<{killed: boolean, escalations: number}>}
 *   - killed: true if the target pid was confirmed dead after verification.
 *   - killed: false for a pid-less target (already-dead / never a real
 *     child) — a documented no-op success, NOT a failure.
 *   - escalations: number of escalation rounds (re-issued kills) performed.
 *
 * Never throws: every WSL / kill operation is wrapped so a failure degrades
 * to an honest {killed:false} rather than an unhandled rejection.
 */
export async function killProcessTree(child, sessionId) {
  const result = { killed: false, escalations: 0 };

  // 1. Anchored session-id sweep (best-effort; never over-kills a decoy).
  if (sessionId) {
    await killGooseSession(sessionId);
  }

  // 2. Direct child pid kill + post-kill verification + escalation.
  const pid = child?.pid;
  if (!pid) {
    // No pid: the target is already dead or was never a real child. Treat as
    // a no-op success (killed:false) — do NOT kill-verify a dead pid.
    return result;
  }

  await killChildDirect(child, pid);

  // Post-kill verification: two liveness probes 500ms apart.
  let alive = await verifyDead(pid);
  if (alive) {
    // Escalate: re-issue the kill, then a final liveness check.
    result.escalations++;
    await killChildDirect(child, pid);
    alive = pidAlive(pid);
  }
  result.killed = !alive;
  return result;
}

/**
 * Synchronous variant of killProcessTree for the process-shutdown path
 * (index.js cleanup), where awaiting is not possible. Same anchored sweep,
 * same verification + escalation, but blocking.
 *
 * @returns {{killed: boolean, escalations: number}}
 */
export function killProcessTreeSync(child, tag) {
  const result = { killed: false, escalations: 0 };

  if (tag) {
    killGooseSessionSync(tag);
  }

  const pid = child?.pid;
  if (!pid) return result;

  killChildDirectSync(child, pid);
  let alive = verifyDeadSync(pid);
  if (alive) {
    result.escalations++;
    killChildDirectSync(child, pid);
    alive = pidAlive(pid);
  }
  result.killed = !alive;
  return result;
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
