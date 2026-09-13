# AUDIT MANIFEST — 2026-09-13/14 Audit Mitigation Milestone

Authoritative reconciliation ledger for the 2026-09-13 audit findings (`docs/audits/CROSS_SESSION_VLLM_AND_QWEN_DISPATCH_AUDIT_2026-09-13.md`, `docs/audits/WSL_FINAL_SUPERVISORY_SESSION_AUDIT_2026-09-13.md`, gh issue #11) plus live-observed anomalies from this session's exploration slices (`audit-distill-s1`, `code-gt-s1`, `behavior-forensics-s2`, `anomaly-probe-s2/s3`). Plan of record: `implementation plan` 2026-09-14 (approved).

Gate: milestone closes only when every row is `[RESOLVED: sha]`, `[DEFERRED: id]`, or `[WONTFIX: rationale]`.

## Mitigation slices

| Row | Finding | Slice | Status |
|---|---|---|---|
| F9, N4, N5 | `/wait` 500-on-failure misread as infra crash; 500 retry-storm; connection left open | M1 `task_registry.js` → 200 + `{isError,status,result}` JSON, clean termination | [RESOLVED: this commit] 62/62 canary, full `npm test` gate green (36-suite && chain, exit 0); live smoke deferred to post-restart verification |
| F10, F13 | Binary file ingested as text (647 KB PDF poison pill) | M2 `sandbox_fs.js` readFile/searchCode → `file-type` magic-number guard | [RESOLVED: this commit] `BinaryFileError` fail-fast + honest skipped-binary in searchCode; 6/6 canary, `npm test` exit 0 |
| N1, N6 | Guard-truncated degenerate final messages: deliverable dropped, session false-`completed` (7× `" Register"` class) | M3 honest delivery + `degenerate_response_truncated` status + retry classification | OPEN |
| F4, F12, F14, #11-rec1/2 | Unbounded bash probe loops on open-ended targets; anti-probe clause not harness-enforced | M4 single-pass directive in dispatch + >4-consecutive-non-mutating-bash advisory warning | OPEN |
| F3, N8, #11-rec3 | Session over-retention (ctx-400 death: 196,609+49,152 > 245,760) | M5 60-warn/80-recommend/100-backstop + context-budget preflight w/ output clamp | OPEN |
| F6, N3, N7 | 15-min SSE idle watchdog kills healthy long-thinking streams (3+1 occurrences); EngineCore crash | M6 keep-alive pings during silent streams + depth-scaled empty-stream retries w/ backoff | OPEN |
| F1, F2 | 27/45 dispatches over 1,500-char budget; monolithic mega-prompt failure | M7 `prompt_over_budget` advisory event | OPEN |
| F17, F18 | Exporter: `promptTokens` all-zero; session-cumulative fields double-count reused sessions (~3×) | M8 exporter correctness (per-dispatch tokens, cumulative stamped once, tokensPerSec derivation) | OPEN |
| N2 | Mid-session death froze `task_anomaly-probe-s1` as `running`, unhealed (boot-only sweep) | M9 liveness reaper (heartbeat-stale + dead-PID, live-owner invariant respected) | OPEN |
| F18 (docs) | Audit headline metrics ~3× inflated; `paper_p2` FAILED/call-count conflation; `/wait` body-shape misclaim | D1 append-only errata in both 2026-09-13 audit docs | OPEN |
| F13 (docs) | Orchestrator-side binary-read prohibition missing; numeric-target rule for geometry dispatches; anti-probe in protocol | D1 `CLAUDE.md` + `GEMINI.md` (repo single-source) amendments | OPEN |
| — | Issue #11 tracking + premature "closes #11" note | I1 comment on #11; close after reconciliation w/ per-fix SHAs | OPEN |

## Deferred / Won't fix (with rationale)

| Row | Finding | Rationale |
|---|---|---|
| DEF-1 | SWE-agent-style linter-gated writes (M4 ACI layer) | `[DEFERRED]` Forensics: `edit_file` friction 2/213, zero syntax-class failures — gate solves a dead failure mode; revisit if failure taxonomy shifts |
| WONTFIX-1 | N9 undici `AbortError` cluster (8 sessions) | Triage: intentional cancels (user TaskStop / orchestrator cancel) legitimately surface as aborts; classify 472 ms zero-tool case during M-series; expected cancel semantics, not a defect |
| WONTFIX-2 | F7 Antigravity premature polling; F15 supervision pattern; F16 session bloat | Behavioral/practice notes; no harness code lever |
| WONTFIX-3 | F11 LaTeX float starvation | Resolved in paper repo (out of scope) |
| DEFERRED-2 | #7 MCP SDK client port, #6 Landlock, #10 WSL2 driver docs | Separate backlog items, untouched by this milestone |
| WATCH-1 | A2 stale `.tmp_*` task files | Retention sweep due ~Sep 15; verify sweep reaped them, else fold into M9 |
| WATCH-2 | N7 vLLM EngineCore crash | Engine-level; M6 retry layer is the harness lever; no harness-side prevention |

## Verification ledger (filled per slice)

| Slice | Tests | Live verify | Commit |
|---|---|---|---|
| M1 | wait_endpoint.test.js 62/62; full `npm test` exit 0 | pending MCP-server restart smoke (F9 repro: failed task → curl -fsS exit 0 + isError body) | this commit |
| M2 | binary_guard.test.js 6/6; search_code_guard 9/9; security 123/123; full `npm test` exit 0 | pending MCP-server restart smoke (read_file on repo PDF → structured rejection) | this commit |
| M3 | — | — | — |
| M4 | — | — | — |
| M5 | — | — | — |
| M6 | — | — | — |
| M7 | — | — | — |
| M8 | — | — | — |
| M9 | — | — | — |
| D1 | n/a | n/a | — |
