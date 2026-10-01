/**
 * src/harness/services/searxng_lifecycle.js
 *
 * On-demand Docker lifecycle manager for the local SearXNG container.
 *
 * Design:
 *   - ensureSearxngRunning(baseUrl): health-check → docker compose up -d → wait
 *   - markSearxngActive(): bump last-activity timestamp
 *   - scheduleIdleStop(idleMs): unref'd timer → docker compose down
 *   - shutdownSearxng(): immediate docker compose down (called on process exit)
 *   - sweepOrphans(): docker rm -f any stale castor-searxng container
 *
 * Zero-orphan invariants:
 *   1. Fixed container name "castor-searxng" — `up -d` is idempotent.
 *   2. `restart: "no"` in compose — WSL reboot cannot resurrect it.
 *   3. sweepOrphans() on first ensure — kills any leftover from a crashed session.
 *   4. `docker compose down` (not just stop) on shutdown — no stopped-but-allocated container.
 *
 * Test seams: _setDockerRunner, _setHealthCheck, _resetForTest.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { IS_WINDOWS } from "../../env.js";
import { wslHome } from "../../wsl_env.js";
import { buildSpawnProfile } from "../../platform.js";

const execFileAsync = promisify(execFile);

const CONTAINER_NAME = "castor-searxng";
const DEFAULT_IDLE_MS = 300_000;
const START_TIMEOUT_MS = 30_000;
const HEALTH_TIMEOUT_MS = 2_000;
const HEALTH_POLL_MS = 500;

/** WSL-side path to the docker-compose.yml. */
function composeFile() {
  return `${wslHome()}/.castor/searxng/docker-compose.yml`;
}

// ---------------------------------------------------------------------------
// Docker runner (with test seam)
// ---------------------------------------------------------------------------

async function _realRunDocker(args, timeoutMs = 30_000) {
  const profile = buildSpawnProfile({
    command: "docker",
    args,
    mode: IS_WINDOWS ? "wsl" : "windows",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return execFileAsync(profile.command, profile.args, {
    timeout: timeoutMs,
    ...profile.options,
  });
}

let _dockerRunner = _realRunDocker;
/** Test seam: inject a fake docker runner. Pass null to restore. */
export function _setDockerRunner(fn) {
  _dockerRunner = typeof fn === "function" ? fn : _realRunDocker;
}

// ---------------------------------------------------------------------------
// Health check (with test seam)
// ---------------------------------------------------------------------------

async function _realHealthCheck(baseUrl) {
  try {
    const u = new URL(baseUrl.replace(/\/+$/, "") + "/healthz");
    const res = await fetch(u.toString(), { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    return res.ok;
  } catch {
    return false;
  }
}

let _healthCheck = _realHealthCheck;
/** Test seam: inject a fake health check. Pass null to restore. */
export function _setHealthCheck(fn) {
  _healthCheck = typeof fn === "function" ? fn : _realHealthCheck;
}

// ---------------------------------------------------------------------------
// Local-instance detection
// ---------------------------------------------------------------------------

/**
 * Returns true when the baseUrl points to a local loopback instance
 * (localhost or 127.0.0.1 on any port). External URLs return false.
 *
 * @param {string} baseUrl
 * @returns {boolean}
 */
export function isLocalSearxngUrl(baseUrl) {
  if (!baseUrl || typeof baseUrl !== "string") return false;
  try {
    const u = new URL(baseUrl);
    return u.hostname === "localhost" || u.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Lifecycle state
// ---------------------------------------------------------------------------

let _lastActive = 0;
let _idleMs = DEFAULT_IDLE_MS;
let _idleTimer = null;
let _starting = null;
let _shutdownRegistered = false;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Ensures the local SearXNG container is running and healthy.
 * No-op for external (non-loopback) URLs.
 *
 * @param {string} baseUrl The SearXNG base URL (e.g. "http://127.0.0.1:8888/").
 * @returns {Promise<void>}
 */
export async function ensureSearxngRunning(baseUrl) {
  if (!isLocalSearxngUrl(baseUrl)) return;

  if (await _healthCheck(baseUrl)) return;

  if (_starting) return _starting;

  _starting = (async () => {
    try {
      await sweepOrphans();

      await _dockerRunner(
        ["compose", "-f", composeFile(), "up", "-d"],
        60_000,
      );

      const deadline = Date.now() + START_TIMEOUT_MS;
      while (Date.now() < deadline) {
        if (await _healthCheck(baseUrl)) return;
        await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
      }
      throw new Error(`SearXNG did not become healthy within ${START_TIMEOUT_MS}ms`);
    } finally {
      _starting = null;
    }
  })();

  return _starting;
}

/**
 * Bumps the last-activity timestamp and reschedules the idle-stop timer.
 */
export function markSearxngActive() {
  _lastActive = Date.now();
  _rescheduleIdleStop();
}

/**
 * Schedules (or reschedules) the idle-stop watchdog.
 * The timer is unref'd so it never keeps the process alive.
 *
 * @param {number} [idleMs=300000] Idle period in milliseconds before shutdown.
 */
export function scheduleIdleStop(idleMs = DEFAULT_IDLE_MS) {
  _idleMs = idleMs;
  _rescheduleIdleStop();
}

/**
 * Registers a one-time beforeExit handler that calls shutdownSearxng().
 * Safe to call multiple times (only registers once).
 */
export function registerShutdown() {
  if (_shutdownRegistered) return;
  _shutdownRegistered = true;
  process.once("beforeExit", () => {
    shutdownSearxng().catch(() => {});
  });
}

/**
 * Immediately stops the SearXNG container and clears the idle timer.
 * Safe to call multiple times.
 */
export async function shutdownSearxng() {
  if (_idleTimer) {
    clearTimeout(_idleTimer);
    _idleTimer = null;
  }
  try {
    await _dockerRunner(["compose", "-f", composeFile(), "down"], 30_000);
  } catch (err) {
    process.stderr.write(`[searxng_lifecycle] shutdown: ${err.message}\n`);
  }
}

/**
 * Removes any orphaned castor-searxng containers (from crashed sessions).
 * Safe to call even when no container exists.
 */
export async function sweepOrphans() {
  try {
    const { stdout } = await _dockerRunner(
      ["ps", "-a", "--filter", `name=${CONTAINER_NAME}`, "--format", "{{.Names}}"],
      10_000,
    );
    const names = (stdout || "").trim().split("\n").filter(Boolean);
    for (const name of names) {
      try {
        await _dockerRunner(["rm", "-f", name], 10_000);
      } catch {
        /* best-effort */
      }
    }
  } catch {
    /* docker unavailable — nothing to sweep */
  }
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function _rescheduleIdleStop() {
  if (_idleTimer) clearTimeout(_idleTimer);
  _idleTimer = setTimeout(async () => {
    _idleTimer = null;
    try {
      await shutdownSearxng();
    } catch (err) {
      process.stderr.write(`[searxng_lifecycle] idle stop: ${err.message}\n`);
    }
  }, _idleMs);
  _idleTimer.unref();
}

/** Test-only: reset all module state. */
export function _resetForTest() {
  _lastActive = 0;
  _idleMs = DEFAULT_IDLE_MS;
  if (_idleTimer) {
    clearTimeout(_idleTimer);
    _idleTimer = null;
  }
  _starting = null;
  _shutdownRegistered = false;
  _dockerRunner = _realRunDocker;
  _healthCheck = _realHealthCheck;
}
