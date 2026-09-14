import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { winHomeWsl } from "./platform.js";

export const IS_WINDOWS = process.platform === "win32";

export const VLLM_PORT = parseInt(process.env.VLLM_PORT || "18020", 10);
export const STATUS_PORT = parseInt(process.env.STATUS_PORT || "18021", 10);
export const STREAM_PROXY_PORT = parseInt(process.env.STREAM_PROXY_PORT || "18022", 10);

export const BASE_URL = `http://localhost:${VLLM_PORT}/v1`;
export const MAX_LEN_HUGE = 245760;
// 2026-09-12: 180s -> 480s. Cold boot with MAX_SEQS=2 (multi-stream CUDA graph
// capture restored) observed >180s in production: model load 15s + torch.compile
// 45s + profiling/warmup 138s + DFlash-head compile/capture. The old deadline
// was tuned for the 1-seat boot that eliminated those graphs.
export const BOOT_TIMEOUT_MS = 480_000;
export const BOOT_POLL_MS = 3000;

// Output budget: default max_tokens for a single generation turn. Raised from
// 16384 to 49152 so that server-side reasoning (thinking) tokens no longer
// consume the entire budget before any content / tool calls are emitted.
// Overridable per-dispatch via QWEN_MAX_TOKENS (the 245K context window easily
// fits ~100k prompt + 49k output).
export const DEFAULT_MAX_TOKENS = 49152;
export const MAX_TOKENS = (() => {
  const parsed = parseInt(process.env.QWEN_MAX_TOKENS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_TOKENS;
})();

// Reasoning-effort passthrough: read dynamically (at call time) so callers and
// tests can toggle it per-dispatch. Defaults to "xhigh" per SOTA reasoning
// test-time compute depth findings. Can be overridden via QWEN_REASONING_EFFORT.
export function getReasoningEffort() {
  const v = process.env.QWEN_REASONING_EFFORT;
  return v ? v : "xhigh";
}

// Valid reasoning-effort tiers the engine's chat template accepts. Verified
// against the LIVE Qwen3.8-27B chat_template.jinja (both AutoRound variants):
// the template raises an exception for any value outside this set, and the
// live vLLM engine returns 400 for "off"/"high" (200 for xhigh/medium/low).
// The documented family behavior ("off/low/medium/xhigh") is NOT what this
// engine implements — "off" is rejected. Single source of truth for the
// qwen_coworker `reasoning_effort` schema and the provider's fallback.
export const REASONING_EFFORT_TIERS = ["xhigh", "medium", "low"];

export const DEFAULT_RACE_MS = 15_000;
export const RACE_MS = process.env.QWEN_RACE_MS
  ? parseInt(process.env.QWEN_RACE_MS, 10)
  : DEFAULT_RACE_MS;

export const DEFAULT_TIMEOUT_MS = 14_400_000; // 4 hours
export const DEFAULT_MIN_TIMEOUT_MS = 600_000;
export const MIN_TIMEOUT_MS = (() => {
  const parsed = parseInt(process.env.QWEN_MIN_TIMEOUT_MS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MIN_TIMEOUT_MS;
})();

export const INACTIVITY_TIMEOUT_MS = (() => {
  const parsed = parseInt(process.env.QWEN_INACTIVITY_TIMEOUT_MS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1_800_000; // 30 min
})();

export const FIRST_TOKEN_TIMEOUT_MS = (() => {
  const parsed = parseInt(process.env.QWEN_FIRST_TOKEN_TIMEOUT_MS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 240_000; // 4 min
})();

// P7b: streaming idle tolerance for a single generation turn. This is the
// first-byte AND inter-chunk idle watchdog on the provider's SSE read loop.
// A legitimate first token can take many minutes on a cold 200K prefill
// (prefix-cache miss) or behind a queued request on a MAX_SEQS=1 engine, so
// the default is 15 minutes (900000ms) — well above any realistic TTFT — and
// is overridable via QWEN_STREAM_IDLE_TIMEOUT_MS. This is a DIFFERENT axis
// from max_tokens (generation-length cap); it only bounds how long the stream
// may go SILENT before we declare the connection dead.
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 900_000; // 15 min
export const STREAM_IDLE_TIMEOUT_MS = (() => {
  const parsed = parseInt(process.env.QWEN_STREAM_IDLE_TIMEOUT_MS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_STREAM_IDLE_TIMEOUT_MS;
})();

// M6a (P1, F6/N3): depth-aware idle timeout. The SHALLOW tier above (900s) is
// correct for normal turns, but a DEEP-context prompt (estimated prompt tokens
// >= STREAM_IDLE_DEPTH_TOKENS) legitimately spends >15 min in a single healthy
// thinking turn before any content is emitted — the 900s watchdog was aborting
// those mid-deliberation (3 observed deaths, all >100k ctx: anomaly-probe-s2
// 2410s, paper_history, ui_ovh_review_p5; worst healthy turn 978s). When the
// prompt is deep, the provider arms this longer DEEP window instead so a
// healthy long-thinking turn is not killed; the SHALLOW tier still bounds
// normal turns. Both are overridable via env for tests / operators.
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS_DEEP = 1_800_000; // 30 min
export const STREAM_IDLE_TIMEOUT_MS_DEEP = (() => {
  const parsed = parseInt(process.env.QWEN_STREAM_IDLE_TIMEOUT_DEEP_MS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_STREAM_IDLE_TIMEOUT_MS_DEEP;
})();

// M6a: prompt-token depth threshold. A turn whose estimated prompt tokens reach
// this value is treated as "deep" and gets the DEEP idle tier. Default 100k
// matches the observed death signature (all three aborted deep turns were
// >100k ctx). Overridable via QWEN_STREAM_IDLE_DEPTH_TOKENS.
export const DEFAULT_STREAM_IDLE_DEPTH_TOKENS = 100_000;
export const STREAM_IDLE_DEPTH_TOKENS = (() => {
  const parsed = parseInt(process.env.QWEN_STREAM_IDLE_DEPTH_TOKENS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_STREAM_IDLE_DEPTH_TOKENS;
})();

// P7b: per-turn ceiling on reasoning (thinking) tokens, enforced CLIENT-side
// by the provider's SSE read loop. Ground truth (P7b forensics): a reasoning
// loop burned a single uninterrupted ~18-minute generation to the full 49152
// max_tokens ceiling (engine /metrics: one Running request, spec-decode
// acceptance pinned at the 8.0 maximum = literal repetition). The stream-proxy
// circuit breaker now catches LITERAL loops (it was blind to delta.reasoning
// — field-name mismatch, fixed same pass), but a SEMANTIC loop (re-phrasing
// without exact repetition) is only boundable by a token budget. When the
// ceiling is hit the provider ends the turn with finish_reason "length" +
// hadReasoning, so the runner's P2d reasoning-cutoff continuation directive
// lands ("stop deliberating, emit edits with tools now") and the agent
// CONTINUES instead of hogging the engine. Never suppresses thinking in
// prompts — bounds it mechanically and hands the turn back.
export const DEFAULT_MAX_REASONING_TOKENS = 32_768;
export const MAX_REASONING_TOKENS = (() => {
  const parsed = parseInt(process.env.QWEN_MAX_REASONING_TOKENS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_REASONING_TOKENS;
})();

export const EXTENSION_BONUS_TIMEOUT_MS = 600_000; // 10 min
// Invariant: retention must always outlive the longest legal task
// (DEFAULT_TIMEOUT_MS), or it can unlink a LIVE task's JSON mid-run.
// The floor is DEFAULT_TIMEOUT_MS + 30 min (the 30-min margin covers the
// inactivity watchdog's grace window past the hard timeout).
export const TASK_RETENTION_FLOOR_MS = DEFAULT_TIMEOUT_MS + 1_800_000; // 4h + 30min
// Default retention: 7 days — long enough that audit telemetry survives a full
// work week. Overridable via QWEN_TASK_RETENTION_MS; any configured value
// below the floor is clamped up to the floor (the invariant above must never
// be violated, even by an operator misconfiguration).
export const DEFAULT_TASK_RETENTION_MS = 604_800_000; // 7 days
export const TASK_RETENTION_MS = (() => {
  const parsed = parseInt(process.env.QWEN_TASK_RETENTION_MS, 10);
  const requested =
    Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TASK_RETENTION_MS;
  return Math.max(requested, TASK_RETENTION_FLOOR_MS);
})();

// 2026-09-12: default raised 1 -> 2 to match the engine launcher's MAX_SEQS=2
// (user-authorized; upstream huge-profile validated seat count). Keep 1:1 with
// scripts/wsl/start_huge.sh. QWEN_MAX_CONCURRENT still overrides.
export const MAX_CONCURRENT_TASKS = process.env.QWEN_MAX_CONCURRENT
  ? Math.max(1, parseInt(process.env.QWEN_MAX_CONCURRENT, 10))
  : 2;

export const SLOT_HEARTBEAT_MS = 15_000;
export const SLOT_WEDGED_MS = 300_000;
export const SLOT_POLL_MS = 1_000;

export const QWEN_STATE_DIR = process.env.QWEN_STATE_DIR || (() => {
  if (IS_WINDOWS) return path.join(os.homedir(), ".qwen");
  const winHomeWslPath = winHomeWsl();
  if (winHomeWslPath) {
    const winUserHomeQwen = path.join(winHomeWslPath, ".qwen");
    try {
      if (fs.existsSync(winUserHomeQwen)) return winUserHomeQwen;
    } catch {}
  }
  return path.join(os.homedir(), ".qwen");
})();

export const TASK_DIR = path.join(QWEN_STATE_DIR, "tasks");
export const SLOTS_DIR = path.join(TASK_DIR, "slots");

// Wedge detection & Auto-Heal (Preserves GPU headroom against core deadlocks)
export const WEDGE_STATS_SILENCE_S = process.env.QWEN_WEDGE_SILENCE_S
  ? parseInt(process.env.QWEN_WEDGE_SILENCE_S, 10)
  : 120;
export const AUTO_HEAL = process.env.QWEN_AUTO_HEAL !== "0";
export const HEAL_LOCK_FILE = path.join(TASK_DIR, ".engine_heal.lock");
export const HEAL_LOCK_TTL_MS = 5 * 60_000;
export const ENGINE_BOOT_LOCK_FILE = path.join(TASK_DIR, ".engine_boot.lock");
export const ENGINE_BOOT_LOCK_TTL_MS = BOOT_TIMEOUT_MS;
export const ENGINE_LOG_PATH = process.env.QWEN_LOG_PATH || "/tmp/mcp_launch_huge.log";
export const WEDGE_COUNTER_FILE = path.join(TASK_DIR, ".wedge_counter.json");
export const PROXY_MAX_BODY_BYTES = 50 * 1024 * 1024; // 50MB

// Execution engine: the native Anser runner is hard-wired; there is no engine selection.

// Execution & Turn limits
export const MAX_TURNS = process.env.QWEN_MAX_TURNS
  ? parseInt(process.env.QWEN_MAX_TURNS, 10)
  : null; // null = unbounded, let orchestrator govern

// Continuation budget: max times we re-prompt the model after a
// finish_reason: "length" (token-ceiling) cutoff before giving up.
export const DEFAULT_MAX_CONTINUATION_TURNS = 8;
export const MAX_CONTINUATION_TURNS = (() => {
  const parsed = parseInt(process.env.QWEN_MAX_CONTINUATION_TURNS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_CONTINUATION_TURNS;
})();

// Empty-stream retry budget: max times we re-issue a turn when the engine
// returns an EMPTY generation (no content, no tool calls, and no real
// finish_reason — the signature of an aborted/zero-byte stream that the
// provider default-fills as "stop"). After this many empty turns we report
// the honest status "engine_empty_response" instead of a false "completed".
export const DEFAULT_EMPTY_STREAM_RETRIES = 2;
export const EMPTY_STREAM_RETRIES = (() => {
  const parsed = parseInt(process.env.QWEN_EMPTY_STREAM_RETRIES, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_EMPTY_STREAM_RETRIES;
})();

// M6b (P1, completes M6): depth-aware empty-stream retry budget. The flat
// EMPTY_STREAM_RETRIES above (default 2) is correct for normal turns, but a
// DEEP-context prompt (estimated prompt chars >= EMPTY_STREAM_RETRY_DEPTH_CHARS)
// has a much longer recovery latency on retry: re-prefilling 100k+ tokens takes
// minutes, so a transient empty-stream cluster (the audit §5.2 signature: 36
// empty streams, 3 unrecovered, ALL during extended deliberation at high
// context) exhausts the flat budget of 2 before it clears. When the prompt is
// deep, the runner arms this longer DEEP budget instead so a transient cluster
// has room to clear; the base budget still bounds normal (shallow) turns. Both
// are overridable via env for tests / operators.
export const DEFAULT_EMPTY_STREAM_RETRIES_DEEP = 4;
export const EMPTY_STREAM_RETRIES_DEEP = (() => {
  const parsed = parseInt(process.env.QWEN_EMPTY_STREAM_RETRIES_DEEP, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_EMPTY_STREAM_RETRIES_DEEP;
})();

// M6b: prompt-CHARS depth threshold for the empty-stream retry budget. A turn
// whose re-prefill size (JSON.stringify(messages).length, the same measure the
// runner already records as deathContext.promptChars) reaches this value is
// treated as "deep" and gets the DEEP retry budget. Default 525000 chars
// (~150k tokens at ~3.5 chars/token) matches the observed death signature
// (all three unrecovered empty streams were >100k ctx). Overridable via
// QWEN_EMPTY_STREAM_RETRY_DEPTH_CHARS.
export const DEFAULT_EMPTY_STREAM_RETRY_DEPTH_CHARS = 525_000;
export const EMPTY_STREAM_RETRY_DEPTH_CHARS = (() => {
  const parsed = parseInt(process.env.QWEN_EMPTY_STREAM_RETRY_DEPTH_CHARS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_EMPTY_STREAM_RETRY_DEPTH_CHARS;
})();

// M6b: exponential backoff between empty-stream retries. Before each retry the
// runner sleeps base * 2^(retryNumber-1) ms, capped at capMs. With the defaults
// (base 2000ms, cap 30000ms) this is exactly "2^retryNumber seconds capped at
// 30s": retry 1 waits 2s, retry 2 waits 4s, retry 3 waits 8s, retry 4 waits
// 16s, retry 5+ waits 30s (capped). The backoff gives a transient empty-stream
// cluster time to clear before the next (expensive, deep) re-prefill. Both are
// overridable via env so tests can shrink the sleep to milliseconds (the
// recorded backoffMs still reflects the configured value).
export const DEFAULT_EMPTY_STREAM_RETRY_BACKOFF_BASE_MS = 2000;
export const EMPTY_STREAM_RETRY_BACKOFF_BASE_MS = (() => {
  const parsed = parseInt(process.env.QWEN_EMPTY_STREAM_RETRY_BACKOFF_BASE_MS, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_EMPTY_STREAM_RETRY_BACKOFF_BASE_MS;
})();

export const DEFAULT_EMPTY_STREAM_RETRY_BACKOFF_CAP_MS = 30_000;
export const EMPTY_STREAM_RETRY_BACKOFF_CAP_MS = (() => {
  const parsed = parseInt(process.env.QWEN_EMPTY_STREAM_RETRY_BACKOFF_CAP_MS, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_EMPTY_STREAM_RETRY_BACKOFF_CAP_MS;
})();

// M3b: degenerate-final guard. When the stream proxy circuit-breaks a runaway
// repetition loop it appends a GUARD_MARKER sentinel and ends the stream with
// finish_reason "stop". The provider accumulates that marker into the turn's
// content, so a turn whose ENTIRE message is just the marker (or a tiny
// sliver of text plus the marker) lands in the runner as a "stop" turn with
// content — and the old code reported a false "completed" (the M3a defect:
// 7 false-success sessions, e.g. task_mitig-m3a-s3 with 0 tool calls and a
// marker-only result).
//
// The runner now strips the marker and measures the substantive remainder:
//   - remainder < DEGENERATE_FINAL_SUBSTANTIVE_CHARS AND no tool calls this
//     turn AND the session is still short (turnsTaken <=
//     DEGENERATE_FINAL_MAX_TURNS)  -> DEGENERATE: retry via the empty-stream
//     path (reason "degenerate_final"); on budget exhaustion report the honest
//     status "degenerate_response_truncated" (isError) with the original
//     partial+marker preserved for honesty.
//   - remainder >= DEGENERATE_FINAL_SUBSTANTIVE_CHARS -> keep "completed"
//     (the marker stays visible in the result; the deliverable is real).
//
// 200 chars is well below any legitimate final answer but far above the
// marker's own length (~110 chars), so a marker-only or near-marker final is
// always caught while a real (even short) answer is never misclassified.
export const DEFAULT_DEGENERATE_FINAL_SUBSTANTIVE_CHARS = 200;
export const DEGENERATE_FINAL_SUBSTANTIVE_CHARS = (() => {
  const parsed = parseInt(process.env.QWEN_DEGENERATE_FINAL_SUBSTANTIVE_CHARS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DEGENERATE_FINAL_SUBSTANTIVE_CHARS;
})();

// A degenerate final is only "short" if the session has not already run many
// turns. A long session that ends with a marker-truncated final has clearly
// done real work (many tool calls / turns) and is NOT degenerate — it is a
// normal (if truncated) completion. Default 3 keeps the guard scoped to the
// early-dead-session signature (the M3a repro died on turn 1).
export const DEFAULT_DEGENERATE_FINAL_MAX_TURNS = 3;
export const DEGENERATE_FINAL_MAX_TURNS = (() => {
  const parsed = parseInt(process.env.QWEN_DEGENERATE_FINAL_MAX_TURNS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DEGENERATE_FINAL_MAX_TURNS;
})();

// M4: probe-budget watchdog (issue #11 recs 1+2; F4/F12/F14). On open-ended
// layout targets the model ran 30+ consecutive inline-python measurement bash
// calls (~90 min) instead of making the edit. The runner now counts
// CONSECUTIVE non-mutating bash calls (bash/exec_command with no file-mutating
// tool call in between); when the count exceeds this budget it injects an
// ADVISORY (not an error, not a cancellation) reminding the model that
// mutation dispatches are single-pass, and re-arms the counter for the next
// run of N. Default 4 (the warning fires on the 5th consecutive non-mutating
// bash call). Overridable via QWEN_PROBE_BUDGET.
export const DEFAULT_PROBE_BUDGET = 4;
export const PROBE_BUDGET = (() => {
  const parsed = parseInt(process.env.QWEN_PROBE_BUDGET, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PROBE_BUDGET;
})();

// M5a: session-cumulative turn thresholds (issue #11 rec 3). The session's
// total turn count spans tasks: the prior assistant_message events (from
// logger.readAll(), the same source getConversationHistory() reads) plus this
// run's turnsTaken. The runner's run loop checks the cumulative count each
// turn. At SESSION_TURNS_WARN it emits a one-shot `session_warning` event; at
// SESSION_TURNS_RECOMMEND it emits a one-shot `session_turn_limit_recommended`
// event AND pushes a single in-band user-role advisory telling the model to
// complete the task and roll to a fresh session next dispatch. These are
// ADVISORY ONLY — they never cancel or error the session, and the hard
// MAX_TURNS cap (anser_runner) is untouched. Overridable via
// QWEN_SESSION_WARN_TURNS / QWEN_SESSION_RECOMMEND_TURNS.
export const DEFAULT_SESSION_TURNS_WARN = 60;
export const SESSION_TURNS_WARN = (() => {
  const parsed = parseInt(process.env.QWEN_SESSION_WARN_TURNS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SESSION_TURNS_WARN;
})();

export const DEFAULT_SESSION_TURNS_RECOMMEND = 80;
export const SESSION_TURNS_RECOMMEND = (() => {
  const parsed = parseInt(process.env.QWEN_SESSION_RECOMMEND_TURNS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SESSION_TURNS_RECOMMEND;
})();

// M5a: context-depth warning threshold (issue #11 rec 3). When a turn's
// promptTokens (the re-prefill size) reaches this value the runner emits a
// one-shot `context_depth_warning` event. If the M4 probeStreak counter is
// active at that moment the event gains `probeStreakActive: true` — a signal
// sum for the anti-rabbit-hole system (a deep context AND a live probe streak
// means the model is stuck in a long, deep, non-mutating loop). Overridable
// via QWEN_CONTEXT_WARN_TOKENS.
export const DEFAULT_CONTEXT_WARN_TOKENS = 65536;
export const CONTEXT_WARN_TOKENS = (() => {
  const parsed = parseInt(process.env.QWEN_CONTEXT_WARN_TOKENS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CONTEXT_WARN_TOKENS;
})();

