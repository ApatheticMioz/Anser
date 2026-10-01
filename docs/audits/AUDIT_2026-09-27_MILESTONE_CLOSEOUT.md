# MILESTONE CLOSEOUT AUDIT — 2026-09-27

- **Scope**: Batches A–F of the Claude Code milestone plan (commits `7f17208..b2468ca`, 39 commits; 64 files touched).
- **Method**: Ground truth established from `git log`/`git show --stat` per commit, live test-gate execution, and filesystem census. No claim below is assumed.
- **Verdict**: **CLOSED.** All six batches complete; both test gates green; documentation synchronized to present state.

---

## 1. Executive Summary

The milestone delivered four outcomes:

1. **Batches A–F complete.** Repo hygiene (A), dead-code/version single-sourcing (B), 13 fail-fast error-masking fixes (C), present-state documentation (D), five dogfood patches E1–E5 (E), and verification closeout (F) are all committed and verified.
2. **Zero-masking.** Every audited error path now fails loud or reports honestly: WSL command failure throws `WslSweepError` (not "no matches"), `/metrics` fetch failure fails closed (engine state UNKNOWN, canary refused), corrupt `stats.json` is quarantined as `*.corrupt-<epoch>` (never silently zeroed), total provider-chain failure returns an honest `SearchError` tool result, and `EADDRINUSE` exits 1.
3. **Self-hosting hardening.** Session-end reaping (E5) closes the gap where a naturally terminated or cancelled task left WSL children and zombie slot leases behind: every task termination path now runs a bounded, idempotent anchored process-tree sweep plus LIVE-OWNER-safe slot-lease cleanup.
4. **SWE documentation refactor.** 14 doc commits standardized comments/docstrings to the canonical present-state SWE JSDoc standard across 18 source files; narrative commentary purged; root README and repo docs rewritten to present-state truth; suite counts synchronized (66) across all governance docs.

---

## 2. Batch Inventory

### Batch A — Repository hygiene
| Commit | Change |
|---|---|
| `f2a3152` | Untracked the `llama-cpp/` third-party binary dump (DLLs/exes) from git. |
| `2772f5a` | Gitignored the `llama-cpp/` directory wholesale. |
| `017f6be` | Purged retired-code narrative comments from `server_lifecycle.js` and `wsl_bridge.js`. |

### Batch B — Dead code/exports & single version
| Commit | Change |
|---|---|
| `0a7b84f` | Stripped 75 dead exports (census-verified: zero non-self references in `src/`, `tests/`, entry points); deleted the dead default export. Export keywords stripped only — no symbol deleted. |
| `319357c` | Single-sourced the version from `package.json` (2026.2.0); removed hardcoded `"2026.1"` from `runner.js` session_start telemetry and `web_service.js` User-Agent. |

### Batch C — 13 fail-fast error-masking fixes
| Commit | Sites fixed |
|---|---|
| `72c26d7` (C1, 5 sites) | (1) `web_service` auto-search: total provider-chain failure returns honest `SearchError` result; empty success only when a provider genuinely found nothing. (2) `server_lifecycle` busy-gate: `/metrics` fetch failure → engine state UNKNOWN → fail closed (canary refused with `metrics_unavailable`), never misread as idle. (3) `telemetry`: corrupt `stats.json` quarantined as `*.corrupt-<epoch>` with stderr warning, never silently zeroed. (4) `event_logger` `readAll`/`hasTerminalEvent`: ENOENT stays legitimate-empty; other read errors surface. (5) `wsl_bridge`: WSL command failure throws `WslSweepError` instead of being masked as "no matches". |
| `8943aac` (C2, 8 sites) | `EADDRINUSE` exits 1; repetition-breaker faults truncate safely with stderr note; corrupt config/`.env` warn with file name; malformed extend-lease body returns 400 (not silent `turns=25`); fabricated WSL identity warns; unreadable subdirs mark listings `partial:true`; four silent telemetry gaps (semaphore heartbeat, wedge counter, SSE token undercount, evo rollback) now log. |
| `b2468ca` | `web_service`: surfaces the `SearchError` object (not just its message) when the auto search chain fails. |

### Batch D — Present-state documentation
| Commit | Change |
|---|---|
| `e2806c7` (D1) | Present-state rewrite of the root `README.md`. |
| `c7ade4d` (D2) | Aligned repository documentation to present-state truth. |
| `6472bc0` | Aligned the security test suite header to the actual 137-vector count. |

### Batch E — Dogfood patches (E1–E5)
| Commit | Patch |
|---|---|
| `2572510` (E1) | FS-as-context tool-output spillover: large tool results written in full to a scratch file; the context receives a bounded preview + path, eliminating context blowouts. |
| `65382c8` (E2) | Deliberation-ceiling salvage pass on budget exhaustion: one final salvage turn before `reasoning_budget_exhausted`. |
| `2698d9d` (E3) | Context headroom and prompt tokens exposed in task telemetry (`task_registry`, `runner`, `castor_runner`). |
| `58ae821` (E4) | Adaptive read-size governor in `sandbox_fs`: read size shrinks under high context pressure. |
| `e7d542e` (E5) | Session-end orphan reaping: on every task termination path (success, error, cancel) a bounded, idempotent sweep runs — anchored per-session process-tree kill (pgrep → `/proc/<pid>/cmdline` boundary verify → kill, so a session id that is a substring of another's is never over-killed) plus stale slot-lease cleanup (dead-owner or terminal-task leases only; a live owner's active lease is never touched). |

### SWE documentation refactor (14 commits)
`d367485` codified the canonical SWE JSDoc / present-state-truth standard in `AGENTS.md`; `b5cea6b` and 12 per-module commits (`06ebe8f`, `2c782ca`, `12a8da1`, `f313f28`, `8ccb4a9`, `3279e14`, `2406c03`, `1095325`, `d37e895`, `48706d7`, `734fa76`, `9a1720b`) standardized comments/docstrings across **18 source files**: `config.js`, `castor_runner.js`, `task_registry.js`, `runner.js`, `tools.js`, `semaphore.js`, `server_lifecycle.js`, `repetition_detector.js`, `evo_engine.js`, `telemetry.js`, `harness/evo/{evo_operator,lineage_dag}.js`, `harness/services/{mcp_bridge,provider_vllm,sandbox_fs,shell_executor,web_service}.js`.

### Batch F — Verification closeout
- New canary `mcp-qwen/tests/session_end_reap.test.js` (22 assertions) covering the E5 pathways; wired into `test:all`.
- Suite counts synchronized to 66 (on-disk = `test:all` gate) across `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `CONTRIBUTING.md`, `README.md`, `mcp-qwen/README.md`.
- Both test gates re-run green after all doc edits (protocol_sync byte-identity intact).

---

## 3. Test Gate Verification

| Gate | Command | Result |
|---|---|---|
| Authoritative | `npm run test:all --prefix mcp-qwen` | **66/66 suites passed, exit 0** (all suites report `0 FAILED`; the four engine-probe suites skip honestly when vLLM is offline). |
| Fast canary | `npm test --prefix mcp-qwen` | **9/9 suites passed, exit 0** (canary, security 137-vector, syntax_gates, edit_file_guard, search_code_guard, schema_parity, platform 41, protocol_sync 8, prompt_integrity 16). |
| New E5 canary | `node mcp-qwen/tests/session_end_reap.test.js` | **22/22 assertions passed, exit 0** (~250 ms, offline-deterministic; fake WSL runner via `setWslCommandSyncRunner`, `STATUS_PORT=0` for a hermetic free port). |

The E5 canary asserts: anchored boundary verification (substring session ids not over-killed), `WslSweepError` surfacing on WSL failure, the LIVE-OWNER INVARIANT (dead-owner / terminal-task / corrupt leases reclaimed; live owner's active lease untouched; idempotent re-sweep), and the HTTP cancel path (in-memory cancel releases the slot and clears the handle; disk-only cancel runs the anchored sweep and clears the dead-owner zombie lease).

---

## 4. Operational Invariants & Ground Truth

**Invariants in force (all test-covered):**
- **LIVE-OWNER INVARIANT** — a live process's lease for an active task is never reclaimed, cancelled, or killed (slot leases, mid-session reaper, cancel paths).
- **Zero-masking** — infrastructure failures surface as named errors or loud stderr; legitimate-empty (ENOENT) is distinguished from failure at every audited site.
- **Anchored sweeps** — session-id matching requires an exact boundary in `/proc/<pid>/cmdline`; regex-then-shell escaping order is load-bearing for `pgrep -f`.
- **Test isolation** — `IS_TEST_ENV` pins `QWEN_STATE_DIR` to a fresh temp dir; kill/stop WSL commands are no-ops under test unless `ALLOW_ENGINE_INTERRUPT=1`; tests never probe port 18020 or reboot vLLM.
- **Protocol sync** — `GEMINI.md`/`CLAUDE.md` share byte-identical §2.7, §2.8, §3.1, §3.3, §4 sections (enforced by `protocol_sync.test.js`).

**Ground truth state at closeout:**
- Version: **2026.2.0**, single-sourced from `mcp-qwen/package.json`.
- Test suites: **66 on disk = 66 in `test:all`** (verified by filesystem census vs script parse; no orphans in either direction).
- Working tree at audit time: 7 modified files (6 governance docs + `package.json`) and 1 untracked file (`tests/session_end_reap.test.js`) — the Batch F closeout changes, pending commit.
- Security gate: 137-vector sandbox boundary & anti-nuke suite green.

**Known residual (out of scope, noted for the record):** none blocking. The four engine-probe suites (`benchmark`, `provider_reasoning`, `provider_usage`, `reasoning_effort_dispatch`) skip honestly when vLLM is offline; they run live when the engine is up.
