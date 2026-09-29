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
import { createRequire } from "node:module";
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
import { LoopDetector } from "./loop_detector.js";
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
  CONTEXT_EMERGENCY_CEILING_TOKENS,
  TOOL_SPILL_BYTES,
  PROMPT_BUDGET_CHARS,
  BASE_TURN_BUDGET,
  MAX_ELASTIC_TURNS,
  KV_CACHE_HEADROOM_CEILING,
  SPEC_ACCEPTANCE_FLOOR,
  LOOP_DETECTION_WINDOW,
  LOOP_DETECTION_REPETITIONS,
  SUPERVISOR_PREVIEW_CHARS,
  SALVAGE_MAX_TOKENS,
  MAX_LEN_HUGE,
  READ_GOVERNOR_MAX_BYTES,
  MODEL,
  MAX_CONTEXT,
} from "../config.js";
import { GUARD_MARKER_PREFIX } from "../repetition_detector.js";
import { recordTurnTelemetry, recordToolExecution, sampleLiveVllmMetrics } from "../telemetry.js";

// Single source of truth for the harness version: read from package.json
// (same createRequire idiom as index.js and mcp_bridge.js).
const require = createRequire(import.meta.url);
const PKG_VERSION = require("../../package.json").version;

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

            // Exponential backoff before retry attempt.
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

export const DEFAULT_SYSTEM_PROMPT = `You are the Autonomous Execution Coworker (${MODEL}) running in the Anser harness.
You pair with the Lead Architect (Gemini in Antigravity / GLM in Claude Code) as a senior peer engineer. The Lead Architect holds high-level architecture and task decomposition; you hold hands-on execution, empirical testing, and codebase navigation.

Operating Principles:
1. Peer Partnership & Two-Way Discussion:
   - You are an autonomous engineering peer, not a blind batch executor. Discussion and collaborative alignment from both sides is the foundational operating principle.
   - Autonomous Slicing on Clear Tasks: When objectives and acceptance criteria are clearly defined, execute the complete slice (investigate, modify, verify) autonomously across your toolset without micro-confirmations.
   - Collaborative Pause on Ambiguity or Impasse: Never treat a dispatch as "life or death" where you must silently force solutions at all costs. When an empirical test fails an acceptance gate, when requirements are ambiguous, or when multiple paths exist, DO NOT loop in solitary trial-and-error.
   - State your verified findings concisely, present the concrete trade-offs or root causes, and provide your technical recommendation to the Lead Architect in plain text. Concluding your turn with a clear, grounded inquiry or status report IS successful fulfillment of the turn.
2. Ground Truth in Code & Tests:
   - Ground truth lives exclusively in active source code, test suites, and verifiable build artifacts. Never assume or hallucinate.
3. Workspace Scratchpads for Audits, Exploration & Empirical Reproduction:
   - You have full, unrestricted write and execution access to '<workspace>/.scratch/' (and repository-local helper scripts) at all times, including during exploration turns.
   - When diagnosing issues, verifying edge cases, or conducting multi-item audits, write minimal reproduction scripts (e.g. '.scratch/repro.py', '.scratch/test_case.js') and dump structured data tables to '.scratch/'.
   - Isolating and verifying a failure empirically with a clean script in '.scratch/' is always preferred over mentally simulating complex logic or running long inline bash one-liners.
4. Mutation & Tool Discipline:
   - When requirements and reproduction are verified and a dispatch requests a code change, modify production source files directly in ONE targeted pass with native editing tools ('edit_file' / 'apply_patch'). Do NOT run blind measurement probe loops against production files.
   - Reserve 'bash' strictly for compilation, test execution, benchmarks, git operations, package managers, or running project runtimes/binaries.
   - Pure Text-Only Engine: You run in text mode with Universal 245K context. Do NOT call image inspection tools on binary images (.png, .jpg). Multimodal inspection is handled exclusively by the Lead Architect.
5. Deliverables: Provide concise, direct technical summaries of your actions and findings.`;

const EVO_SYSTEM_PROMPT_ADDENDUM = `
6. When optimizing, refactoring, or evolving procedural skills, use the Evo tools:
   - 'evo_propose_candidate' to snapshot files or skills before modifying.
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
 * Balanced, non-coercive directive injected when the model hits a reasoning ceiling
 * (finish_reason: "length" with reasoningCeilingHit or empty content).
 * Gives permission to conclude or report blockers to the supervisor without hallucinating actions.
 */
export const REASONING_CONTINUATION_DIRECTIVE =
  "Your deliberation was paused at the token ceiling. " +
  "If you have reached a resolution, proceed with your tool call or response. " +
  "If you are facing an ambiguous requirement or an impasse, state what you have determined so far and request guidance from the supervisor.";

/**
 * Non-coercive salvage directive injected when the reasoning budget is exhausted.
 * Requests that the model persist accumulated findings and incomplete items
 * to a designated scratch file before session termination.
 */
export const SALVAGE_DIRECTIVE =
  "Your deliberation has reached the token ceiling and this session is about to conclude. " +
  "Do not reason further. In one short message, record the findings, tables, and conclusions you have " +
  "already accumulated to the file <SALVAGE_PATH>, and briefly state what remains incomplete. " +
  "This is a best-effort salvage of your partial work — if you have nothing concrete to record, simply say so.";

/**
 * Advisory message injected when consecutive non-mutating bash executions
 * exceed the configured probe budget threshold.
 */
export const PROBE_BUDGET_ADVISORY =
  "[Probe-Budget Advisory] You have run several consecutive shell (bash) calls " +
  "without making progress on your deliverable. Prefer native workspace tools (search_code, read_file, list_dir) over ad-hoc shell inspection. " +
  "Mutation dispatches are single-pass: state a hypothesis, make the edit directly with a native file tool (write_file / edit_file / apply_patch), " +
  "then run the stated verification command ONCE. For read-only or exploration tasks, synthesize your findings and emit your final response now.";

/**
 * Advisory message injected when cumulative session turns reach the recommended
 * rollover threshold, advising session consolidation.
 */
export const SESSION_ROLLOVER_ADVISORY =
  "[Session-Rollover Advisory] This session has crossed the recommended " +
  "turn-count boundary for a single session. Complete the current task, then " +
  "roll to a FRESH session on the next dispatch — a new session starts with a " +
  "clean, low-cost context instead of re-prefilling this deep one.";

/**
 * Spills oversized tool execution results to scratch storage.
 *
 * When a tool output exceeds thresholdBytes, persists the full payload to disk
 * under the workspace scratch directory and replaces the in-band observation
 * with preview metadata and a file pointer.
 *
 * @param {object} params
 * @param {string} params.output Full tool output string.
 * @param {number} params.thresholdBytes Output size threshold before triggering spill.
 * @param {string} params.id Unique tool invocation identifier.
 * @param {string} params.scratchDir Relative scratchpad directory path.
 * @param {object} [params.fsService] Sandboxed filesystem service instance.
 * @returns {Promise<{output: string, spilled: boolean, path?: string, bytes?: number}>}
 */
export async function spillToolOutput({
  output,
  thresholdBytes,
  id,
  scratchDir,
  fsService,
}) {
  const bytes = Buffer.byteLength(output, "utf8");
  if (!fsService || bytes <= thresholdBytes) {
    return { output, spilled: false, bytes };
  }

  const safeId = String(id).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "out";
  const relPath = `${scratchDir}/tool_out_${safeId}.txt`;
  const head = output.slice(0, 1024);
  const tail = output.slice(-1024);

  let writtenPath;
  try {
    const res = await fsService.writeFile({ path: relPath, content: output, overwrite: true });
    writtenPath = res && res.path ? res.path : relPath;
  } catch (err) {
    // Fail-fast: a failed spill is surfaced, never silently truncated.
    return {
      output:
        `[ToolOutputSpillError] The full ${bytes}-byte tool output could not be ` +
        `saved to ${relPath} (${err.message}). The payload was NOT truncated in-band; ` +
        `re-run the tool with a narrower query (head/tail/grep, start_line/end_line) ` +
        `to retrieve a smaller result.`,
      spilled: false,
      bytes,
      error: err.message,
    };
  }

  const pointer =
    `[Tool output spilled to disk: ${bytes} bytes > ${thresholdBytes}-byte threshold. ` +
    `Full payload saved to: ${writtenPath}]\n\n` +
    `--- Head preview (first 1024 bytes) ---\n${head}\n` +
    `... [${bytes - 2048} bytes elided] ...\n` +
    `--- Tail preview (last 1024 bytes) ---\n${tail}\n\n` +
    `Hint: use read_file with start_line/end_line or search_code to inspect ` +
    `specific regions of ${writtenPath}.`;

  return { output: pointer, spilled: true, path: writtenPath, bytes };
}


export class AnserRunner {
  constructor(options = {}) {
    // Canonicalize working directory through OS symlink/junction layer.
    this.defaultCwd = canonicalizePath(options.cwd ? normalizeWorkspacePath(options.cwd) : process.cwd());
    this.defaultMaxTurns = options.maxTurns || BASE_TURN_BUDGET;
    // Optional injection seams (used by offline tests to substitute a mock
    // LLM / logger without touching the network or the real vLLM provider).
    this._llm = options.llm || null;
    this._logger = options.logger || null;
  }

  /**
   * Executes a bounded extraction pass to salvage partial deliberation output.
   * Invoked upon reasoning budget exhaustion to record intermediate findings
   * to workspace scratch storage.
   *
   * @param {object} params
   * @param {object} params.llm LLM provider instance.
   * @param {object} params.logger Event logger instance.
   * @param {object} [params.fsService] Sandboxed filesystem service.
   * @param {string} params.sessionId Session identifier.
   * @param {AbortSignal} [params.signal] Cancellation abort signal.
   * @returns {Promise<{ salvaged: boolean, path?: string, error?: string }>}
   */
  async salvageReasoningBudget({ llm, logger, fsService, sessionId, signal }) {
    const safeId = String(sessionId).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "session";
    const salvagePath = `.scratch/salvage_${safeId}.md`;
    const directive = SALVAGE_DIRECTIVE.replace("<SALVAGE_PATH>", salvagePath);

    let salvageContent = "";
    try {
      // CRITICAL: use a MINIMAL message set (system prompt + directive only),
      // NOT the full conversation history. The session is about to terminate
      // precisely because the context is deep (near the 245K ceiling); passing
      // the full history would re-trigger ContextExhaustedError. The salvage
      // is a fresh, short extraction turn.
      const salvageMessages = [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: directive },
      ];
      const salvageResult = await llm.streamChat({
        messages: salvageMessages,
        tools: [],
        reasoningEffort: "low",
        maxTokens: SALVAGE_MAX_TOKENS,
        signal,
        sessionId,
      });
      salvageContent = (salvageResult?.content || "").trim();
    } catch (err) {
      logger.append({
        type: "salvage_failed",
        error: err.message,
        path: salvagePath,
      });
      return { salvaged: false, error: err.message };
    }

    if (salvageContent === "") {
      logger.append({
        type: "salvage_empty",
        path: salvagePath,
      });
      return { salvaged: false };
    }

    if (!fsService) {
      logger.append({
        type: "salvage_failed",
        error: "No FS service available",
        path: salvagePath,
      });
      return { salvaged: false, error: "No FS service available" };
    }

    try {
      const res = await fsService.writeFile({
        path: salvagePath,
        content: salvageContent,
        overwrite: true,
      });
      const writtenPath = res?.path || salvagePath;
      logger.append({
        type: "salvage_extracted",
        path: writtenPath,
        bytes: Buffer.byteLength(salvageContent, "utf8"),
      });
      return { salvaged: true, path: writtenPath };
    } catch (err) {
      logger.append({
        type: "salvage_failed",
        error: err.message,
        path: salvagePath,
      });
      return { salvaged: false, error: err.message };
    }
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
   *   sessionTurns: number,
   *   lastPromptTokens: number | null,
   *   contextHeadroom: number | null
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
    onActivity,
    getDynamicBudget,
    extensions,
    targetInWsl = false,
    testCommand,
    enableEvo = false,
  }) {
    const t0 = Date.now();
    const loopDetector = new LoopDetector({
      windowSize: LOOP_DETECTION_WINDOW,
      threshold: LOOP_DETECTION_REPETITIONS,
    });
    // Canonicalize working directory through OS symlink/junction layer.
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

    // Initialize stdio MCP extension bridge before runner execution.
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

    // Match and inject applicable workflow skills before entering message list.
    let effectivePrompt = prompt;
    let matchedSkillNames = [];
    if (!hasPriorUserMessages || priorSkills.size === 0) {
      if (!prompt.includes("--- Matching skills (auto-injected from skills/) ---")) {
        matchedSkillNames = matchSkills({ prompt, cwd: effectiveCwd }).map(
          (s) => s.name
        );
        effectivePrompt = injectSkills(prompt, effectiveCwd);
      }
    }

    logger.append({
      type: "session_start",
      harness: "Anser",
      version: PKG_VERSION,
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
    let consecutiveReasoningContinuations = 0;
    let emptyStreamRetries = 0;
    // Track consecutive non-mutating command invocations.
    let probeStreak = 0;

    // Track session-cumulative turn counts across tasks.
    let sessionTurns = logger
      .readAll()
      .filter((e) => e.type === "assistant_message").length;
    let sessionWarnLatched = false;
    let sessionRecommendLatched = false;
    let contextDepthLatched = false;
    let contextHighWatermarkLatched = false;
    let contextEmergencyCeilingLatched = false;
    let contextEmergencySynthesisEmitted = false;
    let lastPromptTokens = 0;

    // Emit prompt_over_budget advisory event when prompt exceeds PROMPT_BUDGET_CHARS.
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

        const currentMaxTurns = typeof getDynamicBudget === "function" ? getDynamicBudget() : (maxTurns || BASE_TURN_BUDGET);

        if (contextEmergencySynthesisEmitted && continuationsInjected === 0) {
          status = "completed_budget_exhausted";
          break;
        }

        if (currentMaxTurns && turnsTaken >= currentMaxTurns && continuationsInjected === 0) {
          status = finalText.trim() !== "" ? "completed_budget_exhausted" : "turn_limit_reached";
          break;
        }

        // Cooperative landing: on the final turn before currentMaxTurns OR when context emergency ceiling is latched,
        // strip tools and mandate synthesis.
        const isCeilingTurn = Boolean(
          contextEmergencyCeilingLatched ||
          (currentMaxTurns && currentMaxTurns > 1 && turnsTaken === currentMaxTurns - 1) ||
          (currentMaxTurns && turnsTaken >= currentMaxTurns && continuationsInjected > 0)
        );
        if (isCeilingTurn && continuationsInjected === 0) {
          if (contextEmergencyCeilingLatched) {
            contextEmergencySynthesisEmitted = true;
          }
          const synthesisPrompt = contextEmergencyCeilingLatched
            ? `[Emergency Context Landing (${lastPromptTokens || "215,000+"}/${MAX_CONTEXT.toLocaleString("en-US")} tokens)]: Context space is near capacity. Tools are now disabled to prevent an unhandled engine crash. Synthesize your final deliverable, findings, code changes, and grounded conclusions immediately.`
            : `[Dispatch Budget Notice (${turnsTaken + 1}/${currentMaxTurns})]: You have reached the final turn of your allotted budget for this dispatch. Synthesize your final deliverable, findings, code changes, and grounded conclusions immediately based on the facts gathered so far.`;

          messages.push({
            role: "user",
            content: synthesisPrompt,
          });
          logger.append({
            type: contextEmergencyCeilingLatched ? "context_emergency_synthesis" : "turn_ceiling_synthesis",
            turnsTaken: turnsTaken + 1,
            maxTurns: currentMaxTurns,
          });
        }

        turnsTaken++;

        // Emit session warning telemetry when cumulative turn thresholds are reached.
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

        const tools = isCeilingTurn ? [] : ctx.listTools();

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
                prefillMs: m.prefillMs ?? m.ttftMs,
                generationMs: m.generationMs ?? (m.totalMs && m.ttftMs ? Math.max(0, m.totalMs - m.ttftMs) : 0),
                totalMs: m.totalMs,
                prefillTps: m.prefillTps,
                decodeTps: m.decodeTps,
                tpotMs: m.tpotMs,
                effort: reasoningEffort || "medium",
              });
            } catch {}
          },
        });

        // Hoist re-prefill size and depth-aware empty-stream retry budget.
        const promptChars = JSON.stringify(messages).length;
        const emptyStreamRetryBudget =
          promptChars >= EMPTY_STREAM_RETRY_DEPTH_CHARS
            ? EMPTY_STREAM_RETRIES_DEEP
            : EMPTY_STREAM_RETRIES;

        // Guard against empty generation streams with missing finish reason.
        const isEmptyGeneration =
          (!turnResult.content || turnResult.content.trim() === "") &&
          (!turnResult.toolCalls || turnResult.toolCalls.length === 0) &&
          (turnResult.finishReason === undefined ||
            turnResult.finishReason === null ||
            turnResult.finishReason === "");

        // Guard against empty stop turns (zero content and zero tool calls with stop finish reason).
        const isEmptyStop =
          turnResult.finishReason === "stop" &&
          (!turnResult.content || turnResult.content.trim() === "") &&
          (!turnResult.toolCalls || turnResult.toolCalls.length === 0);

        if (isEmptyGeneration || isEmptyStop) {
          // Record task execution coordinates and metrics at point of stream termination.
          const deathContext = {
            turnIndex: turnsTaken,
            promptChars,
            metrics: turnResult.metrics ?? null,
            reasoningTokens: turnResult.reasoningTokens ?? 0,
          };
          if (emptyStreamRetries < emptyStreamRetryBudget) {
            emptyStreamRetries++;
            // Exponential backoff before retry attempt.
            const backoffMs = emptyStreamRetryBackoffMs(emptyStreamRetries);
            logger.append({
              type: "empty_stream_retry",
              retryNumber: emptyStreamRetries,
              maxRetries: emptyStreamRetryBudget,
              // Reason: empty generation stream.
              reason: isEmptyStop ? "empty_stop" : "empty_generation",
              backoffMs,
              ...deathContext,
            });
            // If the model completed deliberation inside thinking tags but omitted visible content or tool calls,
            // prompt it directly to emit its conclusion instead of repeating the identical prompt.
            if (isEmptyStop && (turnResult.hadReasoning || (turnResult.reasoning && turnResult.reasoning.trim()))) {
              messages.push({
                role: "user",
                content: "You concluded your internal deliberation without emitting a response or tool call. Please output your conclusion or next action directly now.",
              });
            }
            await new Promise((r) => setTimeout(r, backoffMs));
            continue;
          }
          // Budget exhausted: the engine keeps returning empty generations.
          // Report the honest status instead of a false "completed".
          status = "engine_empty_response";
          logger.append({ type: "engine_empty_response", ...deathContext });
          break;
        }

        // Degenerate-final guard: catch sentinel-truncated repetition outputs lacking substantive content.
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
              // Context size hoisted above retry branches.
              promptChars,
              metrics: turnResult.metrics ?? null,
              reasoningTokens: turnResult.reasoningTokens ?? 0,
              substantiveChars: substantiveLen,
            };
            if (emptyStreamRetries < emptyStreamRetryBudget) {
              emptyStreamRetries++;
            // Exponential backoff before retry attempt.
              const backoffMs = emptyStreamRetryBackoffMs(emptyStreamRetries);
              logger.append({
                type: "empty_stream_retry",
                retryNumber: emptyStreamRetries,
                maxRetries: emptyStreamRetryBudget,
                // Reason: degenerate sentinel-truncated final.
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

        // Emit context-depth advisory telemetry when prompt token accumulation reaches warning threshold.
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

        if (typeof turnResult.metrics?.promptTokens === "number") {
          lastPromptTokens = turnResult.metrics.promptTokens;
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
          // E4: arm the adaptive read-size governor. The context is under
          // pressure (near the 180k high-watermark), so a whole-file read
          // (64KB default) could blow the 245K ceiling (F6.1). Lower the
          // session's read cap to 16KB so subsequent read_file calls are
          // bounded. The governor only LOWERS the cap and is per-session
          // (the SandboxFsService is a fresh per-run instance), so it cannot
          // leak across tasks. Best-effort: a missing FS service is a no-op.
          const fsService = ctx.get("fs");
          if (fsService && typeof fsService.setReadGovernor === "function") {
            fsService.setReadGovernor(READ_GOVERNOR_MAX_BYTES);
            logger.append({
              type: "read_governor_armed",
              maxBytes: READ_GOVERNOR_MAX_BYTES,
              promptTokens: turnResult.metrics.promptTokens,
            });
          }
          messages.push({
            role: "user",
            content:
              `[Context High-Watermark Advisory] Prompt context has reached ${turnResult.metrics.promptTokens} tokens ` +
              `(high-watermark: ${CONTEXT_HIGH_WATERMARK_TOKENS}, max ceiling: ${MAX_CONTEXT.toLocaleString("en-US")}). ` +
              `Wrap up your deliverable and return your final response now. ` +
              `Advise the user/orchestrator to roll into a fresh session_id for subsequent dispatches to prevent context exhaustion.`,
          });
        }

        // --- Context Emergency Ceiling Latch (215,000 tokens) ----------------
        // When promptTokens approaches the 245K ceiling (~87%), strip tools on the
        // subsequent turn to trigger emergency synthesis and prevent an unhandled
        // context_exhausted crash.
        if (
          !contextEmergencyCeilingLatched &&
          typeof turnResult.metrics?.promptTokens === "number" &&
          turnResult.metrics.promptTokens >= CONTEXT_EMERGENCY_CEILING_TOKENS
        ) {
          contextEmergencyCeilingLatched = true;
          logger.append({
            type: "context_emergency_ceiling",
            promptTokens: turnResult.metrics.promptTokens,
            threshold: CONTEXT_EMERGENCY_CEILING_TOKENS,
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

        if (
          (turnResult.content && turnResult.content.trim() !== "") ||
          (turnResult.toolCalls && turnResult.toolCalls.length > 0)
        ) {
          consecutiveReasoningContinuations = 0;
        }

        if (turnResult.content && turnResult.content.trim() !== "") {
          finalText = turnResult.content;
          if (onActivity) {
            onActivity(turnResult.content.trim().slice(-SUPERVISOR_PREVIEW_CHARS));
          }
        }

        // If no tool calls, the model concluded its turn - UNLESS the output
        // was cut off by the token ceiling (finish_reason: "length"). In that
        // case the answer is truncated, so we re-prompt the model to resume.
        if (!turnResult.toolCalls || turnResult.toolCalls.length === 0) {
          if (turnResult.finishReason === "length") {
            const hadReasoning =
              turnResult.metrics?.hadReasoning ?? turnResult.hadReasoning ?? false;
            const isReasoningCutoff =
              Boolean(turnResult.metrics?.reasoningCeilingHit) ||
              (hadReasoning && (!turnResult.content || turnResult.content.trim() === ""));

            if (isReasoningCutoff) {
              consecutiveReasoningContinuations++;
              if (consecutiveReasoningContinuations > 1) {
                status = "reasoning_budget_exhausted";
                finalText = "ReasoningBudgetExhaustedError: The model reached the deliberation ceiling across consecutive continuation turns without taking action or concluding.";
                // E2: bounded salvage extraction pass (F6.3). Best-effort;
                // never alters the honest status above.
                const salvage = await this.salvageReasoningBudget({
                  llm,
                  logger,
                  fsService: ctx.get("fs"),
                  sessionId,
                  signal,
                });
                if (salvage.salvaged) {
                  finalText += `\n\n[Salvage] Partial findings saved to: ${salvage.path}`;
                }
                break;
              }
              continuationsInjected++;
              messages.push({ role: "user", content: REASONING_CONTINUATION_DIRECTIVE });
              logger.append({
                type: "continuation_injected",
                content: REASONING_CONTINUATION_DIRECTIVE,
                continuationNumber: continuationsInjected,
                maxContinuations: MAX_CONTINUATION_TURNS,
                reason: "reasoning_ceiling",
                directive: "balanced_landing",
                hadReasoning: true,
              });
              continue;
            }

            consecutiveReasoningContinuations = 0;
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
            if (isCeilingTurn) {
              status = finalText.trim() !== "" ? "completed_budget_exhausted" : "turn_limit_reached";
            } else if (finalText.trim() !== "") {
              status = "completed_ceiling";
            } else if (hadReasoning) {
              status = "reasoning_budget_exhausted";
              finalText = "ReasoningBudgetExhaustedError: The model exhausted the continuation reasoning budget without emitting visible actions or content.";
              // E2: bounded salvage extraction pass (F6.3). Best-effort;
              // never alters the honest status above.
              const salvage = await this.salvageReasoningBudget({
                llm,
                logger,
                fsService: ctx.get("fs"),
                sessionId,
                signal,
              });
              if (salvage.salvaged) {
                finalText += `\n\n[Salvage] Partial findings saved to: ${salvage.path}`;
              }
            } else {
              status = "length_limit_reached";
            }
            break;
          }
          if (isCeilingTurn) {
            status = "completed_budget_exhausted";
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
        consecutiveReasoningContinuations = 0;
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

          // E1: FS-as-context spillover. Large tool results are written in full
          // to <workspace>/.scratch/ and the in-band observation is replaced with
          // a pointer (head + tail preview + re-read hint) instead of being
          // hard-truncated. Suffix-scoped, so KV prefix stability is preserved.
          const spill = await spillToolOutput({
            output: toolOutputString,
            thresholdBytes: TOOL_SPILL_BYTES,
            id: tc.id,
            scratchDir: ".scratch",
            fsService: ctx.get("fs"),
          });
          toolOutputString = spill.output;
          if (spill.spilled) {
            logger.append({
              type: "tool_output_spilled",
              toolCallId: tc.id,
              toolName: tc.function.name,
              bytes: spill.bytes,
              path: spill.path,
            });
          }

          if (onActivity) {
            const previewSnippet = `[${tc.function.name}] ${toolOutputString.trim().slice(-SUPERVISOR_PREVIEW_CHARS)}`;
            onActivity(previewSnippet);
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

          // Track consecutive non-mutating command executions and inject advisory when threshold is exceeded.
          const toolName = tc.function.name;
          if (MUTATING_TOOLS.has(toolName)) {
            loopDetector.recordMutation();
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

          // Action-hash loop detection: fingerprint non-mutating repetitions
          const loopCheck = loopDetector.recordAction(tc.function.name, parsedArgs, toolExecution);
          if (loopCheck.isLoop) {
            logger.append({
              type: "action_loop_detected",
              fingerprint: loopCheck.fingerprint,
              repeats: loopCheck.repeats,
              threshold: loopDetector.threshold,
              toolName: tc.function.name,
            });
            messages.push({
              role: "user",
              content: `[Action Loop Detected]: You have executed identical action '${tc.function.name}' ${loopCheck.repeats} times consecutively with no state mutation. Alter your approach, inspect alternative files, or synthesize conclusions.`,
            });
            if (loopCheck.repeats >= loopDetector.threshold + 1) {
              status = "stagnant_action_loop";
              finalText = `StagnantActionLoopError: Execution terminated after repeated non-mutating action '${tc.function.name}' (${loopCheck.repeats} consecutive calls).`;
              break;
            }
          }
        }

        if (status === "stagnant_action_loop") {
          break;
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
          `[Context Exhausted] The session's cumulative context exceeded the model's ${MAX_CONTEXT.toLocaleString("en-US")} token ceiling.\n` +
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

      // Terminate MCP extension bridge and clean up child processes and registered tools.
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
      // Cumulative turn count across session lifetime.
      sessionTurns,
      status,
      durationMs: Date.now() - t0,
      totalCompletionTokens,
      sessionId,
      // Prompt token count and remaining context headroom under nominal ceiling.
      lastPromptTokens: lastPromptTokens > 0 ? lastPromptTokens : null,
      contextHeadroom:
        lastPromptTokens > 0
          ? Math.max(0, MAX_LEN_HUGE - lastPromptTokens)
          : null,
    };
  }
}
