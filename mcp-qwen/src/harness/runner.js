/**
 * Anser Runtime Engine (Microkernel Orchestrator)
 *
 * Capabilities:
 * - Pure Node.js runtime (no binary compilation or subprocess shell wrappers)
 * - Anser Context lifecycle with reversible plugin mount/unmount
 * - SSE streaming with real-time token dispatch to Antigravity
 * - Sandboxed ripgrep filesystem & bash toolset
 * - Evo closed-loop evolutionary operators
 * - Append-only JSONL event ledger & session branching
 */

import path from "node:path";
import { Context } from "./core/kernel.js";
import { sandboxFsPlugin } from "./services/sandbox_fs.js";
import { shellExecutorPlugin } from "./services/shell_executor.js";
import { eventLoggerPlugin } from "./services/event_logger.js";
import { vllmProviderPlugin } from "./services/provider_vllm.js";
import { evoPlugin } from "./evo/evo_operator.js";
import { astPlugin } from "./services/ast_service.js";
import { webPlugin } from "./services/web_service.js";
import { McpBridge } from "./services/mcp_bridge.js";
import { injectSkills, matchSkills } from "../skills.js";
import { normalizeWorkspacePath, canonicalizePath } from "../wsl_bridge.js";
import {
  MAX_CONTINUATION_TURNS,
  EMPTY_STREAM_RETRIES,
  EMPTY_STREAM_RETRIES_DEEP,
  EMPTY_STREAM_RETRY_DEPTH_CHARS,
  EMPTY_STREAM_RETRY_BACKOFF_BASE_MS,
  EMPTY_STREAM_RETRY_BACKOFF_CAP_MS,
  DEGENERATE_FINAL_SUBSTANTIVE_CHARS,
  DEGENERATE_FINAL_MAX_TURNS,
  getReasoningEffort,
  PROBE_BUDGET,
  SESSION_TURNS_WARN,
  SESSION_TURNS_RECOMMEND,
  CONTEXT_WARN_TOKENS,
  CONTEXT_HIGH_WATERMARK_TOKENS,
  PROMPT_BUDGET_CHARS,
} from "../config.js";
import { GUARD_MARKER_PREFIX } from "../repetition_detector.js";
import { recordTurnTelemetry, recordToolExecution, sampleLiveVllmMetrics } from "../telemetry.js";

// M4: probe-budget watchdog (issue #11 recs 1+2; F4/F12/F14). On open-ended
// layout targets the model ran 30+ consecutive inline-python measurement bash
// calls (~90 min) instead of making the edit. The runner counts CONSECUTIVE
// non-mutating bash calls (bash/exec_command with no file-mutating tool call in
// between); when the streak exceeds PROBE_BUDGET it injects an ADVISORY (not an
// error, not a cancellation) and re-arms the counter. Style reference: the
// advisory-only EvoWatchdog circuit breaker (src/harness/evo/watchdog.js).
//
// MUTATING_TOOLS reset the streak (a file edit means the model is in mutation
// mode, not probe mode). BASH_TOOLS increment it. Every other tool
// (read_file, list_dir, search_code, ast_search, evo_evaluate_candidate,
// evo_status) is neutral — it neither increments nor resets the streak.
const MUTATING_TOOLS = new Set([
  "write_file",
  "edit_file",
  "apply_patch",
  "ast_replace",
  "ast_replace_batch",
  "evo_propose_candidate",
  "evo_select_candidate",
  "evo_revert_candidate",
]);
const BASH_TOOLS = new Set(["bash"]);

// M6b: exponential backoff between empty-stream retries. Before each retry the
// runner sleeps base * 2^(retryNumber-1) ms, capped at capMs. With the defaults
// (base 2000ms, cap 30000ms) this is exactly "2^retryNumber seconds capped at
// 30s": retry 1 waits 2s, retry 2 waits 4s, retry 3 waits 8s, retry 4 waits
// 16s, retry 5+ waits 30s (capped). The backoff gives a transient empty-stream
// cluster time to clear before the next (expensive, deep) re-prefill. The
// computed ms is returned so the caller can record it in the retry event.
function emptyStreamRetryBackoffMs(retryNumber) {
  const exp = Math.max(0, retryNumber - 1);
  const ms = EMPTY_STREAM_RETRY_BACKOFF_BASE_MS * 2 ** exp;
  return Math.min(ms, EMPTY_STREAM_RETRY_BACKOFF_CAP_MS);
}

const DEFAULT_SYSTEM_PROMPT = `You are the Autonomous Execution Coworker (Qwen3.8-27B) running in the Anser harness.
You pair with the Lead Architect (Gemini in Antigravity / GLM in Claude Code) to explore, design, edit, test, and optimize software systems.

Operating Guidelines:
1. Ground truth lives in active source code, tests, and build artifacts. Never assume or hallucinate.
2. Conversational Pair-Programming & Inquiries:
   - You are a collaborative pair-programmer, not an isolated batch execution box.
   - When encountering high entropy (contradictory data between files, an overly broad search space, missing architectural decisions, or competing approaches), DO NOT burn deliberation tokens looping in solitary thought.
   - Perform initial exploration, state your verified findings concisely, present the concrete trade-off or question to the Lead Architect, and yield your turn. The Lead Architect will steer you on the next turn.
3. Workspace Scratchpads for Audits & Data Analysis:
   - When performing multi-item audits, log analyses, or batch data extraction, write intermediate helper scripts and dump temporary data tables to the workspace scratchpad (e.g. '<workspace>/.scratch/' or repository-local helper scripts).
   - Writing intermediate files to inspect or extract data is encouraged; never attempt to hold large raw data matrices or logs in mental reasoning context.
4. Tool Selection Hierarchy:
   - Prefer specialized native workspace tools over general-purpose 'bash' commands:
     * Use 'search_code' for searching text or patterns across files (never 'grep' or 'rg' via bash).
     * Use 'list_dir' for directory discovery and file exploration (never 'find' or 'ls' via bash).
     * Use 'read_file' to view file contents with line slicing (never 'cat', 'head', 'tail', or 'sed' via bash).
     * Use 'ast_search' for structural AST pattern matching.
     * Use 'edit_file' or 'apply_patch' for modifications.
     * Reserve 'bash' strictly for compilation, test execution, benchmarks, git operations, package managers, or running project runtimes/binaries.
5. Use sandboxed filesystem tools:
   - 'read_file' to inspect file slices with line numbers (text files only; binary files are rejected fail-fast).
   - 'apply_patch' to apply standard unified diffs atomically using git apply (--unidiff-zero).
   - 'edit_file' for exact search-and-replace (auto-normalizes line endings, preserves file style, transparently validated by AST/LaTeX/syntax gates before disk write).
   - 'write_file', 'list_dir', and 'search_code' (fast git grep indexing).
6. Use structural AST tools for code discovery:
   - 'ast_search' to find code by syntactic pattern with metavariables ($VAR, $$$BODY).
   - Run 'ast-grep' CLI directly via 'bash' for large-scale or multi-file AST surgery.
7. Use web research tools for live documentation, library APIs, and web search:
   - 'web_search' to search the live web for technical documentation, library APIs, and problem solutions.
   - 'web_fetch' to fetch web pages or documentation and convert them directly into clean Markdown.
8. Mutation dispatches are focused: state your hypothesis, make the targeted edit directly with file tools, and run verification once.
9. Deliverables: Provide concise, direct technical summaries of your actions and findings.`;

const EVO_SYSTEM_PROMPT_ADDENDUM = `
8. When optimizing or refactoring, use the Evo tools:
   - 'evo_propose_candidate' to snapshot files before modifying.
   - 'evo_evaluate_candidate' to test and compute fitness score (receives compact failure digests on error).
   - 'evo_select_candidate' to accept improvements, or 'evo_revert_candidate' to rollback regressions.`;

/**
 * User-role directive injected when the model's output is cut off by the
 * token ceiling (finish_reason: "length"). Instructs the model to resume
 * exactly where it stopped without repeating already-emitted content.
 */
export const CONTINUATION_DIRECTIVE =
  "Your previous output was cut off by the token ceiling. " +
  "Resume exactly where you stopped. Do not repeat already-emitted content.";

/**
 * M4: advisory injected when the model has run more than PROBE_BUDGET
 * consecutive non-mutating bash calls (issue #11 recs 1+2; F4/F12/F14).
 *
 * This is ADVISORY ONLY — it is neither an error nor a cancellation. It is
 * pushed as a user-role message into the conversation (the same in-band
 * pattern as CONTINUATION_DIRECTIVE) so the model sees it on the next turn.
 * It reminds the model to use native tools and conclude dispatches efficiently.
 */
export const PROBE_BUDGET_ADVISORY =
  "[Probe-Budget Advisory] You have run several consecutive shell (bash) calls " +
  "without making progress on your deliverable. Prefer native workspace tools (search_code, read_file, list_dir) over ad-hoc shell inspection. " +
  "Mutation dispatches are single-pass: state a hypothesis, make the edit directly with a native file tool (write_file / edit_file / apply_patch), " +
  "then run the stated verification command ONCE. For read-only or exploration tasks, synthesize your findings and emit your final response now.";

/**
 * M5a: advisory injected (ONCE per run) when the session's cumulative turn
 * count crosses SESSION_TURNS_RECOMMEND (issue #11 rec 3). The session's
 * total turns span tasks (prior assistant_message events + this run's
 * turnsTaken); past the recommended rollover boundary the context is deep
 * enough that a fresh session is cheaper than continuing. This is ADVISORY
 * ONLY — it is pushed as a single user-role message into the conversation
 * (the same in-band pattern as PROBE_BUDGET_ADVISORY / CONTINUATION_DIRECTIVE)
 * telling the model to complete the current task and roll to a fresh session
 * on the next dispatch. It never cancels or errors the session, and the hard
 * MAX_TURNS cap (anser_runner) is untouched.
 */
export const SESSION_ROLLOVER_ADVISORY =
  "[Session-Rollover Advisory] This session has crossed the recommended " +
  "turn-count boundary for a single session. Complete the current task, then " +
  "roll to a FRESH session on the next dispatch — a new session starts with a " +
  "clean, low-cost context instead of re-prefilling this deep one.";


export class AnserRunner {
  constructor(options = {}) {
    // P4i: canonicalize the default cwd through the OS symlink/junction layer
    // so a junction/symlink cwd is stored as its real path before it is
    // handed to any sandboxed service.
    this.defaultCwd = canonicalizePath(options.cwd ? normalizeWorkspacePath(options.cwd) : process.cwd());
    this.defaultMaxTurns = options.maxTurns || 100;
    // Optional injection seams (used by offline tests to substitute a mock
    // LLM / logger without touching the network or the real vLLM provider).
    this._llm = options.llm || null;
    this._logger = options.logger || null;
  }

  /**
   * Runs an autonomous agent session using the Anser harness.
   *
   * @param {object} params
   * @param {string} params.prompt The user / orchestrator objective
   * @param {string} [params.cwd] Target workspace directory
   * @param {string} [params.sessionId] Unique session ID
   * @param {number} [params.maxTurns] Maximum allowed turns (null = unbounded)
   * @param {string} [params.reasoningEffort] Task-local reasoning-effort tier
   *   (one of REASONING_EFFORT_TIERS). Threaded to the provider's streamChat
   *   for every turn of this session; when absent the provider falls back to
   *   the QWEN_REASONING_EFFORT env default (unchanged behavior).
   * @param {AbortSignal} [params.signal] Cancellation signal
   * @param {(token: string) => void} [params.onToken] Live token streaming callback
   * @param {(metric: object) => void} [params.onMetrics] Performance metric callback
   * @param {(toolCall: object) => void} [params.onToolCall] Live tool call notification
   * @returns {Promise<{
   *   finalText: string,
   *   turnsTaken: number,
   *   status: 'completed' | 'completed_ceiling' | 'aborted' | 'turn_limit_reached'
    *     | 'failed' | 'engine_empty_response' | 'reasoning_budget_exhausted'
    *     | 'length_limit_reached' | 'degenerate_response_truncated',
   *   durationMs: number,
   *   totalCompletionTokens: number,
   *   sessionId: string,
   *   sessionTurns: number
   * }>}
   */
  async run({
    prompt,
    cwd,
    sessionId = `evo_${Date.now()}`,
    maxTurns = this.defaultMaxTurns,
    reasoningEffort,
    signal,
    onToken,
    onMetrics,
    onToolCall,
    extensions,
    targetInWsl = false,
    testCommand,
    enableEvo = false,
  }) {
    const t0 = Date.now();
    // P4i: canonicalize the per-run cwd through the OS symlink/junction layer
    // so every plugin mounted below (sandbox fs, shell, Evo, AST) receives a
    // real path, not a junction literal.
    const effectiveCwd = cwd ? canonicalizePath(normalizeWorkspacePath(cwd)) : this.defaultCwd;

    // Initialize the Anser microkernel context
    const ctx = new Context(null, `session_${sessionId}`);

    // Mount core services. The LLM provider and event logger can be injected
    // via the constructor (this._llm / this._logger) for offline testing; when
    // absent we mount the real vLLM provider and on-disk JSONL logger.
    ctx.plugin(sandboxFsPlugin, { root: effectiveCwd });
    ctx.plugin(shellExecutorPlugin, { cwd: effectiveCwd });
    if (this._logger) {
      ctx.provide("logger", this._logger);
    } else {
      ctx.plugin(eventLoggerPlugin, { sessionId });
    }
    if (this._llm) {
      ctx.provide("llm", this._llm);
    } else {
      ctx.plugin(vllmProviderPlugin);
    }
    ctx.plugin(astPlugin, { root: effectiveCwd });
    ctx.plugin(webPlugin);

    // Conditional Evo mounting: only mount the Evo closed-loop optimization tools
    // when a testCommand / evaluation benchmark or explicit evo flag is active.
    // In standard exploration/editing turns, the toolset remains lean at exactly 8 tools.
    const isEvoActive = Boolean(testCommand || enableEvo);
    if (isEvoActive) {
      ctx.plugin(evoPlugin, { workspaceRoot: effectiveCwd });
    }

    // P8: boot the generic MCP extension bridge BEFORE the runner loop so the
    // remote tools are registered on the Anser Context and visible to the
    // model on the very first turn. The bridge never throws (bad specs /
    // failed handshakes are logged and skipped). It is disposed in the
    // finally block below so no bridge child is ever leaked on failure/cancel.
    let mcpBridge = null;
    if (Array.isArray(extensions) && extensions.length > 0) {
      mcpBridge = new McpBridge({
        cwd: effectiveCwd,
        targetInWsl,
        extensions,
      });
      await mcpBridge.start(ctx);
    }

    const logger = ctx.get("logger");
    const llm = ctx.get("llm");

    const priorEvents = logger.readAll();
    const hasPriorUserMessages = priorEvents.some((e) => e.type === "user_message");
    const priorSkills = new Set();
    for (const ev of priorEvents) {
      if (ev.type === "skills_injected" && Array.isArray(ev.skills)) {
        for (const s of ev.skills) priorSkills.add(s);
      }
    }

    // P9: keyword auto-inject matching skills from the packaged skills/
    // library into the user prompt BEFORE it enters the message list.
    // If skills were already injected in a prior turn of this session, do not
    // re-inject duplicate skill bodies, preserving KV-cache prefix stability.
    let effectivePrompt = prompt;
    let matchedSkillNames = [];
    if (!hasPriorUserMessages || priorSkills.size === 0) {
      matchedSkillNames = matchSkills({ prompt, cwd: effectiveCwd }).map(
        (s) => s.name
      );
      effectivePrompt = injectSkills(prompt, effectiveCwd);
    }

    logger.append({
      type: "session_start",
      harness: "Anser",
      version: "2026.1",
      cwd: effectiveCwd,
      prompt,
      // Effective reasoning-effort tier for this session (task-local param when
      // provided, else the QWEN_REASONING_EFFORT env default). Surfaced for
      // telemetry; the provider re-resolves the same value per request.
      reasoningEffort: reasoningEffort || getReasoningEffort(),
    });

    if (matchedSkillNames.length > 0) {
      logger.append({ type: "skills_injected", skills: matchedSkillNames });
    }

    const systemPrompt = isEvoActive
      ? DEFAULT_SYSTEM_PROMPT + EVO_SYSTEM_PROMPT_ADDENDUM
      : DEFAULT_SYSTEM_PROMPT;

    const messages = [
      { role: "system", content: systemPrompt },
      ...logger.getConversationHistory(),
    ];

    // Add current user prompt (with any auto-injected skills block)
    messages.push({ role: "user", content: effectivePrompt });
    logger.append({ type: "user_message", content: effectivePrompt });

    let turnsTaken = 0;
    let finalText = "";
    let status = "completed";
    let totalCompletionTokens = 0;
    let continuationsInjected = 0;
    let emptyStreamRetries = 0;
    // M4: consecutive non-mutating bash calls (probe streak). Reset by any
    // mutating tool call; incremented by each bash/exec_command call; neutral
    // for every other tool. When it exceeds PROBE_BUDGET an advisory is
    // injected and the counter re-arms (resets to 0) for the next run of N.
    let probeStreak = 0;

    // M5a: session-cumulative turn count (issue #11 rec 3). The session's
    // total turns SPAN tasks: the prior assistant_message events (from
    // logger.readAll() — the same source getConversationHistory() reads) plus
    // this run's turnsTaken. The run loop checks the cumulative count each
    // turn and latches a one-shot flag per tier so each event fires at most
    // once per run (mirroring the probeStreak advisory pattern).
    // Fail-fast (Anser doctrine): the logger contract REQUIRES readAll().
    // A logger without it is a contract violation and must throw loudly —
    // no silent fallback to 0.
    let sessionTurns = logger
      .readAll()
      .filter((e) => e.type === "assistant_message").length;
    let sessionWarnLatched = false;
    let sessionRecommendLatched = false;
    let contextDepthLatched = false;
    let contextHighWatermarkLatched = false;

    // --- M7 (P2, F1/F2): dispatch prompt-budget telemetry ------------------
    // The audit's failure cluster (27/45 dispatches over budget; monolithic
    // mega-prompt failures) correlates with dispatch prompts over ~1,500 chars.
    // The runner is the only component with the session event sink (anser_runner
    // has none — established M5b), so it is the right place to surface this.
    // When the finalTaskPrompt (the `prompt` that arrives as run({prompt}))
    // exceeds PROMPT_BUDGET_CHARS, emit ONE advisory `prompt_over_budget`
    // event (fields: promptChars, budget) into the session event ledger.
    //
    // ADVISORY TELEMETRY ONLY — it never alters flow: it does not cancel,
    // error, truncate, or re-prompt. The prompt is passed to the model
    // verbatim; the event merely makes the over-budget condition observable in
    // the same sink that carries session_warning / context_depth_warning /
    // probe_budget_warning. Emitted ONCE per run() (before the turn loop), so
    // it cannot re-fire on subsequent turns.
    if (prompt.length > PROMPT_BUDGET_CHARS) {
      logger.append({
        type: "prompt_over_budget",
        promptChars: prompt.length,
        budget: PROMPT_BUDGET_CHARS,
      });
    }

    try {
      while (true) {
        if (signal?.aborted) {
          status = "aborted";
          break;
        }

        if (maxTurns && turnsTaken >= maxTurns) {
          status = "turn_limit_reached";
          break;
        }

        turnsTaken++;

        // --- M5a: session-cumulative turn thresholds (issue #11 rec 3) -----
        // The session's total turns span tasks (prior assistant_message events
        // + this run's turnsTaken). Each tier latches once per run (one-shot),
        // mirroring the probeStreak advisory pattern: advisory-only, never
        // cancel or error the session, and the hard MAX_TURNS cap is untouched.
        sessionTurns = sessionTurns + 1;
        if (!sessionWarnLatched && sessionTurns >= SESSION_TURNS_WARN) {
          sessionWarnLatched = true;
          logger.append({
            type: "session_warning",
            sessionTurns,
            threshold: SESSION_TURNS_WARN,
          });
        }
        if (!sessionRecommendLatched && sessionTurns >= SESSION_TURNS_RECOMMEND) {
          sessionRecommendLatched = true;
          logger.append({
            type: "session_turn_limit_recommended",
            sessionTurns,
          });
          // ONE in-band user-role advisory: complete this task, then roll to a
          // fresh session on the next dispatch.
          messages.push({
            role: "user",
            content: SESSION_ROLLOVER_ADVISORY,
          });
        }

        const tools = ctx.listTools();

        const turnResult = await llm.streamChat({
          messages,
          tools,
          // Task-local reasoning-effort override (per-dispatch). Threaded to
          // every turn of this session; the provider falls back to the
          // QWEN_REASONING_EFFORT env default when it is absent.
          reasoningEffort,
          signal,
          sessionId,
          onToken: (tok) => {
            if (onToken) onToken(tok);
          },
          onMetrics: (m) => {
            totalCompletionTokens += m.completionTokens;
            if (onMetrics) onMetrics(m);
            try {
              recordTurnTelemetry({
                completionTokens: m.completionTokens || 0,
                promptTokens: m.promptTokens || 0,
                reasoningTokens: m.reasoningTokens || 0,
                ttftMs: m.ttftMs,
                tokensPerSec: m.tokensPerSec,
                effort: reasoningEffort || "medium",
              });
            } catch {}
          },
        });

        // M6b: hoist the re-prefill size (promptChars) and the effective
        // empty-stream retry budget ONCE per turn, above both retry branches,
        // so the P2b/P2d empty-stream path and the M3b degenerate-final path
        // share the same number. promptChars is the same measure the death
        // context records (JSON.stringify(messages).length). The budget is
        // depth-aware: a DEEP-context prompt (>= EMPTY_STREAM_RETRY_DEPTH_CHARS)
        // gets the longer DEEP budget (a 100k+ token re-prefill has a much
        // longer recovery latency, so a flat budget of 2 exhausts before a
        // transient cluster clears); a shallow prompt keeps the base budget.
        const promptChars = JSON.stringify(messages).length;
        const emptyStreamRetryBudget =
          promptChars >= EMPTY_STREAM_RETRY_DEPTH_CHARS
            ? EMPTY_STREAM_RETRIES_DEEP
            : EMPTY_STREAM_RETRIES;

        // --- Empty-generation guard (P2b) -----------------------------------
        // An aborted / zero-byte stream yields NO content, NO tool calls, and
        // NO real finish_reason frame. The provider default-fills that missing
        // finish_reason as "stop", so the raw signal of "no real finish_reason"
        // is finishReason being undefined / null / "" (NOT the string "stop").
        // Treating such a turn as a clean completion is what made a full
        // ~7k-token generation look like a silent zero-byte "stop" to the
        // client. Instead: do NOT record it as an assistant turn, do NOT set
        // finalText, and retry the turn up to the empty-stream retry budget.
        // A legitimate "stop" turn (with content) is unaffected.
        const isEmptyGeneration =
          (!turnResult.content || turnResult.content.trim() === "") &&
          (!turnResult.toolCalls || turnResult.toolCalls.length === 0) &&
          (turnResult.finishReason === undefined ||
            turnResult.finishReason === null ||
            turnResult.finishReason === "");

        // --- Empty-STOP guard (P2d) -----------------------------------------
        // A turn that ends with finish_reason "stop" yet produced NO content
        // (empty / whitespace) and NO tool calls is pathological: the model
        // ended its turn having said nothing (the classic signature of a
        // reasoning-only turn that burned the whole max_tokens budget on
        // thinking and then "stopped" with zero output). This is distinct from
        // the P2b case (no real finish_reason) and from the P2 length
        // continuation (finish_reason "length"). Route it through the SAME
        // emptyStreamRetries retry path as P2b: do NOT record it as an
        // assistant turn, do NOT set finalText, and retry up to the budget.
        // NOTE: turns with tool calls are never "empty" (a tool call is real
        // output). Turns with hadReasoning + empty content + finish "length"
        // are handled by the existing continuation path below (unchanged).
        const isEmptyStop =
          turnResult.finishReason === "stop" &&
          (!turnResult.content || turnResult.content.trim() === "") &&
          (!turnResult.toolCalls || turnResult.toolCalls.length === 0);

        if (isEmptyGeneration || isEmptyStop) {
          // P7b forensics context: record WHERE in the task the death happened
          // and WHAT the engine claimed to be doing. promptChars (hoisted above,
          // shared with the M3b degenerate path) approximates the re-prefill size
          // (large prompts = minutes of cold TTFT); reasoningTokens on the dead
          // turn exposes invisible thinking loops (the P7b root cause burned
          // 49152 reasoning tokens before dying).
          const deathContext = {
            turnIndex: turnsTaken,
            promptChars,
            metrics: turnResult.metrics ?? null,
            reasoningTokens: turnResult.reasoningTokens ?? 0,
          };
          if (emptyStreamRetries < emptyStreamRetryBudget) {
            emptyStreamRetries++;
            // M6b: exponential backoff before the next (expensive, deep)
            // re-prefill so a transient empty-stream cluster has time to clear.
            const backoffMs = emptyStreamRetryBackoffMs(emptyStreamRetries);
            logger.append({
              type: "empty_stream_retry",
              retryNumber: emptyStreamRetries,
              maxRetries: emptyStreamRetryBudget,
              // "empty_generation" = P2b (no real finish_reason);
              // "empty_stop" = P2d (finish "stop" with zero content + zero tool calls).
              reason: isEmptyStop ? "empty_stop" : "empty_generation",
              backoffMs,
              ...deathContext,
            });
            await new Promise((r) => setTimeout(r, backoffMs));
            continue;
          }
          // Budget exhausted: the engine keeps returning empty generations.
          // Report the honest status instead of a false "completed".
          status = "engine_empty_response";
          logger.append({ type: "engine_empty_response", ...deathContext });
          break;
        }

        // --- Degenerate-final guard (M3b) -----------------------------------
        // The stream proxy circuit-breaks a runaway repetition loop by
        // appending a GUARD_MARKER sentinel and ending the stream with
        // finish_reason "stop". The provider accumulates that marker into the
        // turn's content, so a turn whose ENTIRE message is just the marker
        // (or a tiny sliver of text plus the marker) lands here as a "stop"
        // turn WITH content — and the old code reported a false "completed"
        // (the M3a defect: 7 false-success sessions, e.g. task_mitig-m3a-s3
        // with 0 tool calls and a marker-only result).
        //
        // We strip the marker and measure the substantive remainder:
        //   - remainder < DEGENERATE_FINAL_SUBSTANTIVE_CHARS AND no tool calls
        //     this turn AND the session is still short (turnsTaken <=
        //     DEGENERATE_FINAL_MAX_TURNS)  -> DEGENERATE: retry via the
        //     empty-stream path (reason "degenerate_final"); on budget
        //     exhaustion report the honest status "degenerate_response_truncated"
        //     with the original partial+marker preserved for honesty.
        //   - remainder >= DEGENERATE_FINAL_SUBSTANTIVE_CHARS -> NOT degenerate:
        //     fall through to normal recording + break (a real, if truncated,
        //     deliverable; the marker stays visible in the result).
        //
        // Placed BEFORE the assistant_message recording (like the P2b/P2d
        // empty guards) so a degenerate turn is never recorded as an assistant
        // message and the retry is clean.
        const guardMarkerIdx =
          typeof turnResult.content === "string"
            ? turnResult.content.indexOf(GUARD_MARKER_PREFIX)
            : -1;
        if (guardMarkerIdx !== -1) {
          // Strip the marker (prefix ... closing bracket) and measure the
          // substantive remainder (the real text before/after the marker).
          const closeIdx = turnResult.content.indexOf("]", guardMarkerIdx);
          const substantive =
            closeIdx === -1
              ? turnResult.content.slice(0, guardMarkerIdx)
              : turnResult.content.slice(0, guardMarkerIdx) +
                turnResult.content.slice(closeIdx + 1);
          const substantiveLen = substantive.trim().length;
          const noToolCalls =
            !turnResult.toolCalls || turnResult.toolCalls.length === 0;
          const shortSession = turnsTaken <= DEGENERATE_FINAL_MAX_TURNS;
          if (
            substantiveLen < DEGENERATE_FINAL_SUBSTANTIVE_CHARS &&
            noToolCalls &&
            shortSession
          ) {
            const deathContext = {
              turnIndex: turnsTaken,
              // M6b: shared with the P2b/P2d path (hoisted above both branches).
              promptChars,
              metrics: turnResult.metrics ?? null,
              reasoningTokens: turnResult.reasoningTokens ?? 0,
              substantiveChars: substantiveLen,
            };
            if (emptyStreamRetries < emptyStreamRetryBudget) {
              emptyStreamRetries++;
              // M6b: exponential backoff before the next (expensive, deep)
              // re-prefill so a transient empty-stream cluster has time to clear.
              const backoffMs = emptyStreamRetryBackoffMs(emptyStreamRetries);
              logger.append({
                type: "empty_stream_retry",
                retryNumber: emptyStreamRetries,
                maxRetries: emptyStreamRetryBudget,
                // "degenerate_final" = M3b (guard-truncated final with a
                // substantive remainder below the threshold, no tool calls,
                // short session).
                reason: "degenerate_final",
                backoffMs,
                ...deathContext,
              });
              await new Promise((r) => setTimeout(r, backoffMs));
              continue;
            }
            // Budget exhausted: the engine keeps returning degenerate
            // guard-truncated finals. Report the honest status instead of a
            // false "completed". Preserve the original partial+marker in
            // finalText for honesty (the client sees exactly what the engine
            // produced, including the guard marker).
            status = "degenerate_response_truncated";
            finalText = turnResult.content;
            logger.append({
              type: "degenerate_response_truncated",
              ...deathContext,
            });
            break;
          }
        }

        // --- M5a: context-depth warning (issue #11 rec 3) ------------------
        // When the re-prefill size (promptTokens) reaches the threshold, emit a
        // one-shot context_depth_warning. Placed post-streamChat (via
        // turnResult.metrics.promptTokens) so it fires on every real turn
        // regardless of how the provider surfaces metrics. ESCALATION: if the
        // M4 probeStreak counter is active at that moment, the event gains
        // probeStreakActive:true — a signal sum for the anti-rabbit-hole system
        // (a deep context AND a live probe streak = the model is stuck in a
        // long, deep, non-mutating loop).
        if (
          !contextDepthLatched &&
          typeof turnResult.metrics?.promptTokens === "number" &&
          turnResult.metrics.promptTokens >= CONTEXT_WARN_TOKENS
        ) {
          contextDepthLatched = true;
          logger.append({
            type: "context_depth_warning",
            promptTokens: turnResult.metrics.promptTokens,
            threshold: CONTEXT_WARN_TOKENS,
            ...(probeStreak > 0 ? { probeStreakActive: true } : {}),
          });
        }

        // --- Context High-Watermark Advisory (180,000 tokens) ---------------
        // When promptTokens reaches the 180k high-watermark (~73% of nominal 245K
        // context ceiling), emit a one-shot advisory event and inject an in-band
        // rollover advisory to guide the model to conclude its deliverable rather
        // than crashing with unhandled ContextExhaustedError / 400 Bad Request.
        if (
          !contextHighWatermarkLatched &&
          typeof turnResult.metrics?.promptTokens === "number" &&
          turnResult.metrics.promptTokens >= CONTEXT_HIGH_WATERMARK_TOKENS
        ) {
          contextHighWatermarkLatched = true;
          logger.append({
            type: "context_high_watermark",
            promptTokens: turnResult.metrics.promptTokens,
            threshold: CONTEXT_HIGH_WATERMARK_TOKENS,
          });
          messages.push({
            role: "user",
            content:
              `[Context High-Watermark Advisory] Prompt context has reached ${turnResult.metrics.promptTokens} tokens ` +
              `(high-watermark: ${CONTEXT_HIGH_WATERMARK_TOKENS}, max ceiling: 245,760). ` +
              `Wrap up your deliverable and return your final response now. ` +
              `Advise the user/orchestrator to roll into a fresh session_id for subsequent dispatches to prevent context exhaustion.`,
          });
        }

        // Record assistant response. reasoningTokens is surfaced as a top-level
        // field (in addition to metrics) so ledgers show thinking volume even
        // when the metrics object is summarized or dropped downstream.
        logger.append({
          type: "assistant_message",
          content: turnResult.content,
          toolCalls: turnResult.toolCalls,
          finishReason: turnResult.finishReason,
          reasoningTokens:
            turnResult.metrics?.reasoningTokens ?? turnResult.reasoningTokens ?? 0,
          metrics: turnResult.metrics,
        });

        messages.push({
          role: "assistant",
          content: turnResult.content || null,
          tool_calls: turnResult.toolCalls.length > 0 ? turnResult.toolCalls : undefined,
        });

        if (turnResult.content) {
          finalText = turnResult.content;
        }

        // If no tool calls, the model concluded its turn - UNLESS the output
        // was cut off by the token ceiling (finish_reason: "length"). In that
        // case the answer is truncated, so we re-prompt the model to resume.
        if (!turnResult.toolCalls || turnResult.toolCalls.length === 0) {
          if (turnResult.finishReason === "length") {
            const hadReasoning =
              turnResult.metrics?.hadReasoning ?? turnResult.hadReasoning ?? false;
            if (continuationsInjected < MAX_CONTINUATION_TURNS) {
              continuationsInjected++;
              // Provide clean continuation without artificial stop-thinking directives
              messages.push({ role: "user", content: CONTINUATION_DIRECTIVE });
              logger.append({
                type: "continuation_injected",
                content: CONTINUATION_DIRECTIVE,
                continuationNumber: continuationsInjected,
                maxContinuations: MAX_CONTINUATION_TURNS,
                reason: "length",
                directive: "resume",
                hadReasoning,
              });
              continue;
            }
            // Continuation budget exhausted: report an honest status instead of a
            // false "completed". If the model produced a complete deliverable
            // (non-empty finalText) despite hitting the ceiling, that is
            // "completed_ceiling" — a successful run that merely ran out of room,
            // NOT a failure. Only when nothing usable was produced do we fall
            // through to the honest failure statuses.
            if (finalText.trim() !== "") {
              status = "completed_ceiling";
            } else if (hadReasoning) {
              status = "reasoning_budget_exhausted";
              finalText = "ReasoningBudgetExhaustedError: The model exhausted the continuation reasoning budget without emitting visible actions or content.";
            } else {
              status = "length_limit_reached";
            }
            break;
          }
          // The model concluded its turn with a clean "stop" (or other non-length
          // finish reason). If it had to hit the token ceiling the maximum number
          // of times (continuation budget at the cap) before finally completing,
          // that is "completed_ceiling" — a complete deliverable that only finished
          // after exhausting the continuation budget. A clean "stop" that never
          // exhausted the continuation budget is a plain "completed".
          if (
            continuationsInjected >= MAX_CONTINUATION_TURNS &&
            finalText.trim() !== ""
          ) {
            status = "completed_ceiling";
          }
          break;
        }

        // Execute each requested tool call
        let droppedTruncatedCalls = 0;
        for (const tc of turnResult.toolCalls) {
          if (signal?.aborted) break;

          let parsedArgs;
          let argsParseFailed = false;
          try {
            parsedArgs = JSON.parse(tc.function.arguments || "{}");
          } catch {
            // The tool-call arguments were cut off mid-stream (typically by a
            // token-ceiling "length" cutoff). NEVER execute a mangled payload:
            // drop the call, tell the model, and let it re-emit it completely.
            argsParseFailed = true;
            droppedTruncatedCalls++;
          }

          if (argsParseFailed) {
            // Sanitize the malformed argument string in the assistant message so downstream
            // API parsers (vLLM's qwen3_coder / python json.loads) do not fail with HTTP 400 JSONDecodeError
            tc.function.arguments = "{}";

            const notice =
              `ToolExecutionError: Tool '${tc.function.name}' (id ${tc.id}) was dropped: its arguments ` +
              `were truncated mid-stream and could not be parsed as JSON (finish_reason: "length"). ` +
              `Please re-emit this tool call with complete, valid JSON arguments.`;
            messages.push({
              role: "tool",
              tool_call_id: tc.id,
              content: notice,
            });
            logger.append({
              type: "tool_call_dropped",
              toolCallId: tc.id,
              name: tc.function.name,
              notice,
              reason: "truncated_arguments",
              finishReason: turnResult.finishReason,
            });
            continue;
          }

          if (onToolCall) {
            onToolCall({ id: tc.id, name: tc.function.name, args: parsedArgs });
          }

          logger.append({
            type: "tool_call",
            toolCallId: tc.id,
            name: tc.function.name,
            args: parsedArgs,
          });

          const toolExecution = await ctx.executeTool(tc.function.name, parsedArgs);

          let toolOutputString = toolExecution.isError
            ? `Error: ${toolExecution.error}`
            : typeof toolExecution.result === "string"
              ? toolExecution.result
              : JSON.stringify(toolExecution.result ?? "");

          const MAX_TOOL_OUTPUT_BYTES = 32 * 1024; // 32 KB observation limit (SWE-agent standard)
          const MAX_TOOL_OUTPUT_LINES = 1000;

          if (Buffer.byteLength(toolOutputString, "utf8") > MAX_TOOL_OUTPUT_BYTES) {
            const originalBytes = Buffer.byteLength(toolOutputString, "utf8");
            toolOutputString =
              toolOutputString.slice(0, MAX_TOOL_OUTPUT_BYTES) +
              `\n\n[Observation Truncated: Tool output exceeded 32KB limit (original: ${originalBytes} bytes). Narrow your query with head/tail/grep or redirect to disk.]`;
          } else {
            const lines = toolOutputString.split("\n");
            if (lines.length > MAX_TOOL_OUTPUT_LINES) {
              toolOutputString =
                lines.slice(0, MAX_TOOL_OUTPUT_LINES).join("\n") +
                `\n\n[Observation Truncated: Tool output exceeded 1,000 lines (original: ${lines.length} lines). Narrow your query with head/tail/grep or redirect to disk.]`;
            }
          }

          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: toolOutputString,
          });

          logger.append({
            type: "tool_result",
            toolCallId: tc.id,
            toolName: tc.function.name,
            result: toolExecution.result,
            error: toolExecution.error,
            isError: toolExecution.isError,
            latencyMs: toolExecution.latencyMs,
          });

          try {
            recordToolExecution({
              toolName: tc.function.name,
              isError: !!toolExecution.isError,
            });
          } catch {}

          // --- M4: probe-budget watchdog (issue #11 recs 1+2) ---------------
          // Count CONSECUTIVE non-mutating bash calls. A bash/exec_command call
          // increments the streak; a file-mutating tool call (write/edit/patch/
          // ast_replace/evo mutation) resets it (the model is in mutation mode,
          // not probe mode); every other tool (read_file, list_dir, search_code,
          // ast_search, evo_evaluate, evo_status) is neutral — it neither
          // increments nor resets. When the streak exceeds PROBE_BUDGET, inject
          // an ADVISORY (not an error, not a cancellation) and re-arm the
          // counter for the next run of N. This is the harness-enforced form of
          // the single-pass mutation directive (F4/F12/F14: 30+ consecutive
          // inline-python measurement bash calls on open-ended layout targets).
          const toolName = tc.function.name;
          if (MUTATING_TOOLS.has(toolName)) {
            probeStreak = 0;
          } else if (BASH_TOOLS.has(toolName)) {
            probeStreak++;
            if (probeStreak > PROBE_BUDGET) {
              messages.push({
                role: "user",
                content: PROBE_BUDGET_ADVISORY,
              });
              logger.append({
                type: "probe_budget_warning",
                consecutiveNonMutatingBash: probeStreak,
                budget: PROBE_BUDGET,
                advisory: PROBE_BUDGET_ADVISORY,
              });
              // Re-arm: reset for the next run of N consecutive non-mutating
              // bash calls (the advisory is advisory-only; it does not cancel
              // or error the session).
              probeStreak = 0;
            }
          }
        }

        // If the turn was cut off by the token ceiling AND it carried tool
        // calls, the model may have been mid-way through emitting them. Send a
        // continuation signal so it re-emits any dropped/incomplete calls.
        if (
          turnResult.finishReason === "length" &&
          droppedTruncatedCalls > 0 &&
          continuationsInjected < MAX_CONTINUATION_TURNS
        ) {
          continuationsInjected++;
          const hadReasoning =
            turnResult.metrics?.hadReasoning ?? turnResult.hadReasoning ?? false;
          messages.push({ role: "user", content: CONTINUATION_DIRECTIVE });
          logger.append({
            type: "continuation_injected",
            content: CONTINUATION_DIRECTIVE,
            continuationNumber: continuationsInjected,
            maxContinuations: MAX_CONTINUATION_TURNS,
            reason: "length",
            directive: "resume",
            hadReasoning,
            droppedToolCalls: droppedTruncatedCalls,
          });
        }
      }
    } catch (err) {
      const isContextExhausted = /maximum context length|context length exceeded|context_exhausted/i.test(err.message || "");
      if (isContextExhausted) {
        status = "context_exhausted";
        finalText =
          `[Context Exhausted] The session's cumulative context exceeded the model's 245,760 token ceiling.\n` +
          `Prior session events and tool outputs remain intact in the local event ledger.\n` +
          `Action: Roll into a fresh session_id (e.g. "${sessionId}_stage2") for subsequent dispatches.`;
        logger.append({
          type: "session_error",
          error: "context_exhausted",
          detail: err.message,
        });
      } else {
        status = "failed";
        finalText = `Anser execution error: ${err.message}`;
        logger.append({ type: "session_error", error: err.message, stack: err.stack });
      }
    } finally {
      const durationMs = Date.now() - t0;
      logger.append({
        type: "session_end",
        status,
        turnsTaken,
        continuationsInjected,
        durationMs,
        totalCompletionTokens,
      });

      try {
        sampleLiveVllmMetrics();
      } catch {}

      // P8: tear down the MCP extension bridge (kill every bridge child via
      // the process-tree helper + unregister the bridged tools) BEFORE the
      // kernel context is disposed, so the reversible tool disposers still
      // have a live context to unbind from. Never leaks children on
      // failure/cancel/timeout.
      if (mcpBridge) {
        try {
          mcpBridge.dispose();
        } catch {}
      }

      // Cleanly dispose microkernel and unmount all plugins
      ctx.dispose();
    }

    return {
      finalText,
      turnsTaken,
      // M5b: the session-CUMULATIVE turn count (prior assistant_message events
      // + this run's turnsTaken). Exposed so the dispatch layer (anser_runner)
      // can surface the 80-turn rollover recommendation to the ORCHESTRATOR in
      // the result text — today it only lands in session events, which the
      // orchestrator rarely reads. Advisory data only; never alters status.
      sessionTurns,
      status,
      durationMs: Date.now() - t0,
      totalCompletionTokens,
      sessionId,
    };
  }
}
