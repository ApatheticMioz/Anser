# AUDIT MANIFEST — 2026-09-13/14 Audit Mitigation Milestone

Authoritative reconciliation ledger for the 2026-09-13 audit findings (`docs/audits/CROSS_SESSION_VLLM_AND_QWEN_DISPATCH_AUDIT_2026-09-13.md`, `docs/audits/WSL_FINAL_SUPERVISORY_SESSION_AUDIT_2026-09-13.md`, gh issue #11) plus live-observed anomalies from this session's exploration slices (`audit-distill-s1`, `code-gt-s1`, `behavior-forensics-s2`, `anomaly-probe-s2/s3`). Plan of record: `implementation plan` 2026-09-14 (approved).

Gate: milestone closes only when every row is `[RESOLVED: sha]`, `[DEFERRED: id]`, or `[WONTFIX: rationale]`.

## Mitigation slices

| Row | Finding | Slice | Status |
|---|---|---|---|
| F9, N4, N5 | `/wait` 500-on-failure misread as infra crash; 500 retry-storm; connection left open | M1 `task_registry.js` → 200 + `{isError,status,result}` JSON, clean termination | [RESOLVED: this commit] 62/62 canary, full `npm test` gate green (36-suite && chain, exit 0); live smoke deferred to post-restart verification |
| F10, F13 | Binary file ingested as text (647 KB PDF poison pill) | M2 `sandbox_fs.js` readFile/searchCode → `file-type` magic-number guard | [RESOLVED: this commit] `BinaryFileError` fail-fast + honest skipped-binary in searchCode; 6/6 canary, `npm test` exit 0 |
| N1, N6 | Guard-truncated degenerate final messages: deliverable dropped, session false-`completed` (7× `" Register"` class) | M3 → single M3b slice after recon (`m3-recon-s1`): breakerChunk already delivers partial+marker in-band, so the genuine defect is status classification only. 4 failed dispatch attempts ledgered (2× empty-stream starvation, 1× degenerate false-success `task_mitig-m3a-s3` 0-tool-calls, 1× post-work starvation) — engine restarted 2026-09-14 with user approval | [RESOLVED: this commit] `GUARD_MARKER` sentinel single-sourced; runner degenerate-final guard (retry via empty-stream budget → `degenerate_response_truncated`, partial+marker preserved); substantive truncations stay `completed`. 6/6 canary, full gate exit 0 |
| F4, F12, F14, #11-rec1/2 | Unbounded bash probe loops on open-ended targets; anti-probe clause not harness-enforced | M4 single-pass directive in dispatch + >4-consecutive-non-mutating-bash advisory warning. Dispatch-discipline regression ledgered: the M4 mutation dispatch itself bundled two subsystems without pre-digested coordinates → 114K-token context inflation, 10.3-min deliberation burn (2026-09-14 architectural directive; recon-then-mutate mandatory for M5+) | [RESOLVED: this commit] Single-Pass Mutation directive in dispatch block; MUTATING/BASH tool classification + probeStreak watchdog, advisory user-role injection + `probe_budget_warning` event, re-arm; `QWEN_PROBE_BUDGET=4` knob. 4/4 canary, full gate exit 0. Work product reviewed extra-critically given inflated-context origin — sound |
| F3, N8, #11-rec3 | Session over-retention (ctx-400 death: 196,609+49,152 > 245,760) | M5a (runner+config): session-cumulative rollover events (`session_warning`@60, `session_turn_limit_recommended`@80 + in-band advisory), `context_depth_warning`@64K w/ `probeStreakActive` escalation; `MAX_TURNS||100` backstop untouched. Doctrine-fix micro-slice: silent readAll duck-type guard removed (fail-fast), reaping noopLogger mock repaired. N8 hard-clamp discovered ALREADY EXISTING (provider_vllm.js:124-132 ContextExhaustedError) — recon finding. M5b: `buildResultText` appends `[SessionTurnLimitRecommendation]` to dispatch result text at ≥80 turns (advisory-only, orchestrator-visible) | [RESOLVED: this commit] full M5 |
| F6, N3, N7 | 15-min SSE idle watchdog kills healthy long-thinking streams (3+1 occurrences); EngineCore crash | M6 revised on recon facts: runner consumes vLLM directly and the idle parser ignores SSE comments, so proxy keep-alives cannot reach the watchdog — replaced with depth-aware idle tiers + retry scaling. M6a (config+provider): `STREAM_IDLE_TIMEOUT_MS_DEEP` (1800s, env) armed when `estimatedPromptTokens >= STREAM_IDLE_DEPTH_TOKENS` (100k, env); tier named in thrown error + `metrics.streamIdleTier`. M6b (runner+config): hoisted `promptChars`, shared depth-scaled budget across both retry paths (2 shallow / 4 deep ≥525k chars), exponential backoff 2^n capped 30s with `backoffMs` recorded. Proxy-path keep-alive deferred (no observed proxy-side idle death). M6a author task died post-mutation at test-run (`engine_empty_response` #5 today) — Lead completed verification + fixed a test-scaffolding escape bug. M6b ran 4,540s surviving empty-stream retries under its own new machinery, delivered clean | [RESOLVED: this commit] |
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
| M3 | degenerate_final.test.js 6/6; runner_mapping 16/16; stream_proxy 4/4; full `npm test` exit 0 | pending MCP-server-restart smoke (marker-only dispatch → degenerate_response_truncated, not completed) | this commit |
| M4 | probe_budget.test.js 4/4; full `npm test` exit 0 | pending MCP-server-restart smoke (probe-run in a live task → advisory surfaces in stream) | this commit |
| M5 | session_rollover.test.js 6/6 (incl. orchestrator-visible vector f); reaping 20/20; full `npm test` exit 0 | pending MCP-server-restart smoke (60-turn session → session_warning event in ledger) | this commit (M5a+fix+M5b) |
| M6 | idle_timeout_tier 4/4; deep_retry_budget 4/4; full `npm test` exit 0 | M1-shape JSON wait observed live on M6b completion (exit 0, clean close); deep-tier idle window armed in production during M6b's own 4,540s run | this commit |
| M7 | — | — | — |
| M8 | — | — | — |
| M9 | — | — | — |
| D1 | n/a | n/a | — |
