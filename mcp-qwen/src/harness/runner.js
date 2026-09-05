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
import { normalizeWorkspacePath } from "../wsl_bridge.js";
import { MAX_CONTINUATION_TURNS } from "../config.js";

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

export class DeepSeekAvoRunner {
  constructor(options = {}) {
    this.defaultCwd = options.cwd ? normalizeWorkspacePath(options.cwd) : process.cwd();
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
  }) {
    const t0 = Date.now();
    const effectiveCwd = cwd ? normalizeWorkspacePath(cwd) : this.defaultCwd;

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

    const logger = ctx.get("logger");
    const llm = ctx.get("llm");

    logger.append({
      type: "session_start",
      harness: "DeepSeek-AVO",
      version: "2026.1",
      cwd: effectiveCwd,
      prompt,
    });

    const messages = [
      { role: "system", content: DEFAULT_SYSTEM_PROMPT },
      ...logger.getConversationHistory(),
    ];

    // Add current user prompt
    messages.push({ role: "user", content: prompt });
    logger.append({ type: "user_message", content: prompt });

    let turnsTaken = 0;
    let finalText = "";
    let status = "completed";
    let totalCompletionTokens = 0;
    let continuationsInjected = 0;

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

        // Record assistant response
        logger.append({
          type: "assistant_message",
          content: turnResult.content,
          toolCalls: turnResult.toolCalls,
          finishReason: turnResult.finishReason,
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
              messages.push({ role: "user", content: CONTINUATION_DIRECTIVE });
              logger.append({
                type: "continuation_injected",
                continuationNumber: continuationsInjected,
                maxContinuations: MAX_CONTINUATION_TURNS,
                reason: "length",
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
          messages.push({ role: "user", content: CONTINUATION_DIRECTIVE });
          logger.append({
            type: "continuation_injected",
            continuationNumber: continuationsInjected,
            maxContinuations: MAX_CONTINUATION_TURNS,
            reason: "length",
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
