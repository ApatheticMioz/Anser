/**
 * src/env.js — Leaf module: host platform detection.
 *
 * Single source of truth for the platform check. Kept as a LEAF (no imports)
 * so that any module — including config.js and wsl_env.js — can import it
 * without creating a dependency cycle. Previously this constant lived in
 * config.js, which forced platform.js to import config.js (and vice versa),
 * the cycle that produced the TDZ ReferenceError on Linux CI.
 */
export const IS_WINDOWS = process.platform === "win32";
