/**
 * State Directory Streamlining & Retention (Anser Harness)
 *
 * Provides:
 * - pruneOldSessions: evict old session directories based on age, count, and size gates
 * - cleanStateDir: full state-dir cleanup (sessions + orphan .tmp_* files) with throttling
 *
 * Invariant: NEVER prune active/open sessions or sessions referenced by incomplete tasks.
 *
 * Run: node src/state_pruner.js  (self-test mode, optional)
 */

import fs from "node:fs";
import path from "node:path";
import { QWEN_STATE_DIR, TASK_DIR } from "./config.js";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_MAX_AGE_MS = 14 * 86_400_000; // 14 days
const DEFAULT_MAX_COUNT = 200;
const DEFAULT_MAX_SIZE_MB = 50;
const PRUNE_THROTTLE_MS = 24 * 3600_000; // 24 hours

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when the session's event stream carries a terminal event
 * (session_end or session_error). A session without a terminal event is
 * considered "active/open".
 */
function sessionHasTerminalEvent(sessionDir) {
  const logFile = path.join(sessionDir, "events.jsonl");
  if (!fs.existsSync(logFile)) return false;
  let content;
  try {
    content = fs.readFileSync(logFile, "utf8");
  } catch {
    return false;
  }
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev && (ev.type === "session_end" || ev.type === "session_error")) {
      return true;
    }
  }
  return false;
}

/**
 * Returns the set of session IDs referenced by incomplete (not-done) tasks
 * on disk.
 */
function getActiveTaskSessionIds() {
  const ids = new Set();
  if (!fs.existsSync(TASK_DIR)) return ids;
  let entries;
  try {
    entries = fs.readdirSync(TASK_DIR);
  } catch {
    return ids;
  }
  for (const f of entries) {
    if (!f.endsWith(".json")) continue;
    let task;
    try {
      task = JSON.parse(fs.readFileSync(path.join(TASK_DIR, f), "utf8"));
    } catch {
      continue;
    }
    if (task && !task.done && task.sessionId) {
      ids.add(task.sessionId);
    }
  }
  return ids;
}

/**
 * Returns the total size in bytes of a directory (recursive).
 */
function dirSizeBytes(dir) {
  let total = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += dirSizeBytes(full);
    } else if (entry.isFile()) {
      try {
        total += fs.statSync(full).size;
      } catch {
        // ignore
      }
    }
  }
  return total;
}

/**
 * Returns the mtime of a session directory (uses events.jsonl mtime if
 * available, else the directory mtime).
 */
function sessionMtime(sessionDir) {
  const logFile = path.join(sessionDir, "events.jsonl");
  try {
    if (fs.existsSync(logFile)) {
      return fs.statSync(logFile).mtimeMs;
    }
  } catch {}
  try {
    return fs.statSync(sessionDir).mtimeMs;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// pruneOldSessions
// ---------------------------------------------------------------------------

/**
 * Prunes old session directories from the state directory.
 *
 * @param {object} [options]
 * @param {string} [options.stateDir]  Root state dir (default: QWEN_STATE_DIR)
 * @param {number} [options.maxAgeMs]  Max age in ms (default: 14 days)
 * @param {number} [options.maxCount]  Max number of sessions to keep (default: 200)
 * @param {number} [options.maxSizeMb] Max total size in MB (default: 50)
 * @param {boolean} [options.dryRun]  If true, report without deleting
 * @param {number} [options.now]      Override current time (for tests)
 * @returns {{ pruned: number, bytesReclaimed: number, protected: number, skipped: number }}
 */
export function pruneOldSessions(options = {}) {
  const stateDir = options.stateDir || QWEN_STATE_DIR;
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const maxCount = options.maxCount ?? DEFAULT_MAX_COUNT;
  const maxSizeMb = options.maxSizeMb ?? DEFAULT_MAX_SIZE_MB;
  const dryRun = Boolean(options.dryRun);
  const now = options.now ?? Date.now();

  const sessionsDir = path.join(stateDir, "sessions");
  if (!fs.existsSync(sessionsDir)) {
    return { pruned: 0, bytesReclaimed: 0, protected: 0, skipped: 0 };
  }

  // Collect session directories with metadata.
  let entries;
  try {
    entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return { pruned: 0, bytesReclaimed: 0, protected: 0, skipped: 0 };
  }

  const sessions = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sessionDir = path.join(sessionsDir, entry.name);
    const mtime = sessionMtime(sessionDir);
    const size = dirSizeBytes(sessionDir);
    const hasTerminal = sessionHasTerminalEvent(sessionDir);
    sessions.push({
      id: entry.name,
      dir: sessionDir,
      mtime,
      size,
      hasTerminal,
    });
  }

  // Get active task session IDs (invariant: never prune these).
  const activeTaskSessionIds = getActiveTaskSessionIds();

  // Classify: protected vs candidates.
  const protectedSessions = [];
  const candidates = [];
  for (const s of sessions) {
    // Invariant: never prune active/open sessions.
    if (!s.hasTerminal) {
      protectedSessions.push(s);
      continue;
    }
    // Invariant: never prune sessions referenced by incomplete tasks.
    if (activeTaskSessionIds.has(s.id)) {
      protectedSessions.push(s);
      continue;
    }
    candidates.push(s);
  }

  // Sort candidates by mtime ascending (oldest first).
  candidates.sort((a, b) => a.mtime - b.mtime);

  // Determine which candidates to prune.
  const toPrune = new Set();
  const maxSizeBytes = maxSizeMb * 1024 * 1024;

  // Gate 1: age — prune sessions older than maxAgeMs.
  for (const s of candidates) {
    if (now - s.mtime > maxAgeMs) {
      toPrune.add(s.id);
    }
  }

  // Gate 2: count — if total sessions (protected + candidates) exceeds maxCount,
  // evict oldest candidates until we're at or below maxCount.
  const totalSessions = sessions.length;
  if (totalSessions > maxCount) {
    let excess = totalSessions - maxCount;
    for (const s of candidates) {
      if (excess <= 0) break;
      if (!toPrune.has(s.id)) {
        toPrune.add(s.id);
        excess--;
      }
    }
  }

  // Gate 3: size — if total size of all sessions exceeds maxSizeMb,
  // evict oldest candidates until total is at or below the limit.
  let totalSize = 0;
  for (const s of sessions) {
    totalSize += s.size;
  }
  if (totalSize > maxSizeBytes) {
    let remaining = totalSize;
    for (const s of candidates) {
      if (remaining <= maxSizeBytes) break;
      if (!toPrune.has(s.id)) {
        toPrune.add(s.id);
        remaining -= s.size;
      }
    }
  }

  // Execute (or simulate) the prune.
  let pruned = 0;
  let bytesReclaimed = 0;
  for (const s of candidates) {
    if (!toPrune.has(s.id)) continue;
    if (dryRun) {
      pruned++;
      bytesReclaimed += s.size;
    } else {
      try {
        fs.rmSync(s.dir, { recursive: true, force: true });
        pruned++;
        bytesReclaimed += s.size;
      } catch {
        // Best-effort: skip on failure.
      }
    }
  }

  return {
    pruned,
    bytesReclaimed,
    protected: protectedSessions.length,
    skipped: candidates.length - pruned,
  };
}

// ---------------------------------------------------------------------------
// cleanStateDir
// ---------------------------------------------------------------------------

/**
 * Full state-directory cleanup: prunes old sessions and removes orphan
 * .tmp_* files in the tasks directory.
 *
 * @param {object} [options]
 * @param {string} [options.stateDir]  Root state dir (default: QWEN_STATE_DIR)
 * @param {number} [options.maxAgeMs]  Max age in ms (default: 14 days)
 * @param {number} [options.maxCount]  Max number of sessions (default: 200)
 * @param {number} [options.maxSizeMb] Max total size in MB (default: 50)
 * @param {boolean} [options.dryRun]  If true, report without deleting
 * @param {boolean} [options.throttled] If true, skip if last prune was < 24h ago
 * @param {number} [options.now]      Override current time (for tests)
 * @returns {{
 *   sessionsPruned: number,
 *   bytesReclaimed: number,
 *   tmpFilesCleaned: number,
 *   tmpBytesReclaimed: number,
 *   skipped: boolean,
 *   protected: number,
 * }}
 */
export function cleanStateDir(options = {}) {
  const stateDir = options.stateDir || QWEN_STATE_DIR;
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const maxCount = options.maxCount ?? DEFAULT_MAX_COUNT;
  const maxSizeMb = options.maxSizeMb ?? DEFAULT_MAX_SIZE_MB;
  const dryRun = Boolean(options.dryRun);
  const throttled = Boolean(options.throttled);
  const now = options.now ?? Date.now();

  // Throttle: check .last_prune timestamp.
  if (throttled) {
    const lastPruneFile = path.join(stateDir, ".last_prune");
    try {
      if (fs.existsSync(lastPruneFile)) {
        const lastPrune = parseInt(
          fs.readFileSync(lastPruneFile, "utf8").trim(),
          10
        );
        if (Number.isFinite(lastPrune) && now - lastPrune < PRUNE_THROTTLE_MS) {
          return {
            sessionsPruned: 0,
            bytesReclaimed: 0,
            tmpFilesCleaned: 0,
            tmpBytesReclaimed: 0,
            skipped: true,
            protected: 0,
          };
        }
      }
    } catch {
      // Corrupt or unreadable .last_prune: proceed with cleanup.
    }
  }

  // Prune sessions.
  const sessionResult = pruneOldSessions({
    stateDir,
    maxAgeMs,
    maxCount,
    maxSizeMb,
    dryRun,
    now,
  });

  // Clean orphan .tmp_* files in the tasks directory.
  let tmpFilesCleaned = 0;
  let tmpBytesReclaimed = 0;
  if (fs.existsSync(TASK_DIR)) {
    let entries;
    try {
      entries = fs.readdirSync(TASK_DIR);
    } catch {
      entries = [];
    }
    for (const f of entries) {
      if (!f.includes(".tmp_")) continue;
      const tmpPath = path.join(TASK_DIR, f);
      try {
        const st = fs.statSync(tmpPath);
        if (dryRun) {
          tmpFilesCleaned++;
          tmpBytesReclaimed += st.size;
        } else {
          fs.unlinkSync(tmpPath);
          tmpFilesCleaned++;
          tmpBytesReclaimed += st.size;
        }
      } catch {
        // Best-effort.
      }
    }
  }

  // Write .last_prune timestamp (only when not dryRun).
  if (!dryRun) {
    try {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(path.join(stateDir, ".last_prune"), String(now), "utf8");
    } catch {
      // Best-effort.
    }
  }

  return {
    sessionsPruned: sessionResult.pruned,
    bytesReclaimed: sessionResult.bytesReclaimed,
    tmpFilesCleaned,
    tmpBytesReclaimed,
    skipped: false,
    protected: sessionResult.protected,
  };
}
