/**
 * DeepSeek AVO Runtime Engine (Cordis Microkernel Orchestrator)
 *
 * Replaces legacy Goose CLI with:
 * - Pure Node.js runtime (no binary compilation or subprocess shell wrappers)
 * - Cordis Context lifecycle with reversible plugin mount/unmount
 * - SSE streaming with real-time token dispatch to Antigravity
 * - Sandboxed ripgrep filesystem & bash toolset
 * - NVIDIA AVO closed-loop evolutionary operators
 * - Append-only JSONL event ledger & session branching
 */

import path from "node:path";
import { Context } from "./core/kernel.js";
import { sandboxFsPlugin } from "./services/sandbox_fs.js";
import { shellExecutorPlugin } from "./services/shell_executor.js";
import { eventLoggerPlugin } from "./services/event_logger.js";
import { vllmProviderPlugin } from "./services/provider_vllm.js";
import { avoPlugin } from "./avo/avo_operator.js";
import { astPlugin } from "./services/ast_service.js";
import { McpBridge } from "./services/mcp_bridge.js";
import { injectSkills, matchSkills } from "../skills.js";
import { normalizeWorkspacePath, canonicalizePath } from "../wsl_bridge.js";
import { MAX_CONTINUATION_TURNS, EMPTY_STREAM_RETRIES } from "../config.js";

const DEFAULT_SYSTEM_PROMPT = `You are the Autonomous Execution Coworker (Qwen3.8-27B) running in the DeepSeek AVO harness.
You pair with the Lead Architect (Gemini / Claude) to explore, design, edit, test, and optimize software systems.

Operating Guidelines:
1. Ground truth lives in active source code, tests, and build artifacts. Never assume or hallucinate.
2. Use sandboxed filesystem tools: 'read_file', 'write_file', 'edit_file', 'list_dir', 'search_code'.
3. Use structural AST tools for code discovery and refactoring:
   - 'ast_search' to find code by syntactic pattern with metavariables (e.g. 'function $NAME($ARGS) { $$$BODY }').
   - 'ast_replace' to perform AST-verified node replacement with compile-check safety.
4. Use 'bash' to run builds, tests, benchmarks, or git operations safely.
5. When optimizing or refactoring, use NVIDIA AVO tools:
   - 'avo_propose_candidate' to snapshot files before modifying.
   - 'avo_evaluate_candidate' to test and compute fitness score (receives compact failure digests on error).
   - 'avo_select_candidate' to accept improvements, or 'avo_revert_candidate' to rollback regressions.
6. Provide concise, direct technical summaries of your actions and findings.`;

/**
 * User-role directive injected when the model's output is cut off by the
 * token ceiling (finish_reason: "length"). Instructs the model to resume
 * exactly where it stopped without repeating already-emitted content.
 */
export const CONTINUATION_DIRECTIVE =
  "Your previous output was cut off by the token ceiling. " +
  "Resume exactly where you stopped. Do not repeat already-emitted content.";

/**
 * User-role directive injected when the token-ceiling cutoff (finish_reason:
 * "length") happened DURING server-side reasoning (thinking) — i.e. the model
 * burned its output budget deliberating and was cut off before emitting any
 * visible content or tool calls. Unlike the generic resume directive, this one
 * tells the model to STOP deliberating and immediately produce concrete,
 * visible output (content or tool calls) rather than re-entering extended
 * reasoning.
 */
export const REASONING_LANDING_DIRECTIVE =
  "Your reasoning was cut off by the output token ceiling. " +
  "Stop deliberating now — wrap up immediately and emit your concrete next " +
  "actions as visible content or tool calls (edit_file / write_file / bash). " +
  "Do not re-enter extended reasoning.";

export class DeepSeekAvoRunner {
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
   * Runs an autonomous agent session using the DeepSeek AVO harness.
   *
   * @param {object} params
   * @param {string} params.prompt The user / orchestrator objective
   * @param {string} [params.cwd] Target workspace directory
   * @param {string} [params.sessionId] Unique session ID
   * @param {number} [params.maxTurns] Maximum allowed turns (null = unbounded)
   * @param {AbortSignal} [params.signal] Cancellation signal
   * @param {(token: string) => void} [params.onToken] Live token streaming callback
   * @param {(metric: object) => void} [params.onMetrics] Performance metric callback
   * @param {(toolCall: object) => void} [params.onToolCall] Live tool call notification
   * @returns {Promise<{
   *   finalText: string,
   *   turnsTaken: number,
   *   status: 'completed' | 'aborted' | 'turn_limit_reached',
   *   durationMs: number,
   *   totalCompletionTokens: number,
   *   sessionId: string
   * }>}
   */
  async run({
    prompt,
    cwd,
    sessionId = `avo_${Date.now()}`,
    maxTurns = this.defaultMaxTurns,
    signal,
    onToken,
    onMetrics,
    onToolCall,
    extensions,
    targetInWsl = false,
  }) {
    const t0 = Date.now();
    // P4i: canonicalize the per-run cwd through the OS symlink/junction layer
    // so every plugin mounted below (sandbox fs, shell, AVO, AST) receives a
    // real path, not a junction literal.
    const effectiveCwd = cwd ? canonicalizePath(normalizeWorkspacePath(cwd)) : this.defaultCwd;

    // Initialize Cordis microkernel context
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
    ctx.plugin(avoPlugin, { workspaceRoot: effectiveCwd });
    ctx.plugin(astPlugin, { root: effectiveCwd });

    // P8: boot the generic MCP extension bridge BEFORE the runner loop so the
    // remote tools are registered on the Cordis Context and visible to the
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

    // P9: keyword auto-inject matching skills from the packaged skills/
    // library into the user prompt BEFORE it enters the message list. This is
    // additive and budget-capped; when nothing matches the prompt is returned
    // unchanged. Never throws (malformed skills are skipped upstream).
    const matchedSkillNames = matchSkills({ prompt, cwd: effectiveCwd }).map(
      (s) => s.name
    );
    const effectivePrompt = injectSkills(prompt, effectiveCwd);

    logger.append({
      type: "session_start",
      harness: "DeepSeek-AVO",
      version: "2026.1",
      cwd: effectiveCwd,
      prompt,
    });

    if (matchedSkillNames.length > 0) {
      logger.append({ type: "skills_injected", skills: matchedSkillNames });
    }

    const messages = [
      { role: "system", content: DEFAULT_SYSTEM_PROMPT },
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
        const tools = ctx.listTools();

        const turnResult = await llm.streamChat({
          messages,
          tools,
          signal,
          onToken: (tok) => {
            if (onToken) onToken(tok);
          },
          onMetrics: (m) => {
            totalCompletionTokens += m.completionTokens;
            if (onMetrics) onMetrics(m);
          },
        });

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
          // and WHAT the engine claimed to be doing. promptChars approximates
          // the re-prefill size (large prompts = minutes of cold TTFT);
          // reasoningTokens on the dead turn exposes invisible thinking loops
          // (the P7b root cause burned 49152 reasoning tokens before dying).
          const deathContext = {
            turnIndex: turnsTaken,
            promptChars: JSON.stringify(messages).length,
            metrics: turnResult.metrics ?? null,
            reasoningTokens: turnResult.reasoningTokens ?? 0,
          };
          if (emptyStreamRetries < EMPTY_STREAM_RETRIES) {
            emptyStreamRetries++;
            logger.append({
              type: "empty_stream_retry",
              retryNumber: emptyStreamRetries,
              maxRetries: EMPTY_STREAM_RETRIES,
              // "empty_generation" = P2b (no real finish_reason);
              // "empty_stop" = P2d (finish "stop" with zero content + zero tool calls).
              reason: isEmptyStop ? "empty_stop" : "empty_generation",
              ...deathContext,
            });
            continue;
          }
          // Budget exhausted: the engine keeps returning empty generations.
          // Report the honest status instead of a false "completed".
          status = "engine_empty_response";
          logger.append({ type: "engine_empty_response", ...deathContext });
          break;
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

        // If no tool calls, the model concluded its turn — UNLESS the output
        // was cut off by the token ceiling (finish_reason: "length"). In that
        // case the answer is truncated, so we re-prompt the model to resume.
        if (!turnResult.toolCalls || turnResult.toolCalls.length === 0) {
          if (turnResult.finishReason === "length") {
            if (continuationsInjected < MAX_CONTINUATION_TURNS) {
              continuationsInjected++;
              // If the cutoff happened DURING thinking (the model burned its
              // budget on reasoning and emitted no visible content), use the
              // reasoning-landing directive to force it to stop deliberating
              // and emit concrete output; otherwise use the generic resume.
              const hadReasoning =
                turnResult.metrics?.hadReasoning ?? turnResult.hadReasoning ?? false;
              const directive = hadReasoning
                ? REASONING_LANDING_DIRECTIVE
                : CONTINUATION_DIRECTIVE;
              messages.push({ role: "user", content: directive });
              logger.append({
                type: "continuation_injected",
                continuationNumber: continuationsInjected,
                maxContinuations: MAX_CONTINUATION_TURNS,
                reason: "length",
                directive: hadReasoning ? "reasoning_landing" : "resume",
              });
              continue;
            }
            // Continuation budget exhausted: the model keeps hitting the
            // ceiling. Report the honest status instead of a false "completed".
            status = "length_limit_reached";
            break;
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
            const notice =
              `Tool call '${tc.function.name}' (id ${tc.id}) was dropped: its arguments ` +
              `were truncated and could not be parsed as JSON (finish_reason: "length"). ` +
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

          const toolOutputString = toolExecution.isError
            ? `Error: ${toolExecution.error}`
            : typeof toolExecution.result === "string"
              ? toolExecution.result
              : JSON.stringify(toolExecution.result ?? "");

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
          // Same directive selection as the no-tool-calls length branch: if the
          // cutoff happened during thinking, force the model to stop
          // deliberating and re-emit concrete output / tool calls.
          const hadReasoning =
            turnResult.metrics?.hadReasoning ?? turnResult.hadReasoning ?? false;
          const directive = hadReasoning
            ? REASONING_LANDING_DIRECTIVE
            : CONTINUATION_DIRECTIVE;
          messages.push({ role: "user", content: directive });
          logger.append({
            type: "continuation_injected",
            continuationNumber: continuationsInjected,
            maxContinuations: MAX_CONTINUATION_TURNS,
            reason: "length",
            directive: hadReasoning ? "reasoning_landing" : "resume",
            droppedToolCalls: droppedTruncatedCalls,
          });
        }
      }
    } catch (err) {
      status = "error";
      finalText = `DeepSeek AVO execution error: ${err.message}`;
      logger.append({ type: "session_error", error: err.message, stack: err.stack });
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
      status,
      durationMs: Date.now() - t0,
      totalCompletionTokens,
      sessionId,
    };
  }
}
