/**
 * P11 — Shared offline-probe for the vLLM engine.
 *
 * Single source of truth for "is the engine up?" used by every live-engine
 * test to decide run-for-real vs honest-skip.
 *
 * The probe is AVAILABILITY-ONLY: one cheap GET to the engine's /v1/models
 * endpoint with a short timeout. It performs NO generation, so it can never
 * hang when the port is closed (the fetch rejects fast on ECONNREFUSED).
 *
 * The engine is the vLLM server (VLLM_PORT, default 18020). The stream proxy
 * (18022) is a separate process that proxies to it, so probing vLLM directly
 * is the correct "engine alive" signal: if vLLM is down, the proxy cannot
 * serve either and the provider's fallback also fails.
 */
import { VLLM_PORT } from "../../src/config.js";

/**
 * Cheap availability probe. Returns true only when the engine answers
 * /v1/models with an HTTP 2xx within the timeout. Any network error, timeout,
 * or non-2xx response yields false. Never blocks longer than `timeoutMs`.
 *
 * @param {{port?: number, timeoutMs?: number}} [opts]
 * @returns {Promise<boolean>}
 */
export async function isEngineAvailable({ port = VLLM_PORT, timeoutMs = 3000 } = {}) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/models`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Honest skip guard for live-engine tests. If the engine is down, print a
 * visible `[SKIP] engine down` line and exit 0 so the suite stays green
 * offline. If the engine is up, return true and let the caller run for real.
 *
 * @param {string} [label] Optional context appended to the skip line.
 * @returns {Promise<boolean>} true when the engine is available.
 */
export async function requireEngineOrSkip(label = "") {
  const up = await isEngineAvailable();
  if (!up) {
    console.log(
      `[SKIP] engine down${label ? ` (${label})` : ""} - skipping live-engine test`
    );
    process.exit(0);
  }
  return true;
}
