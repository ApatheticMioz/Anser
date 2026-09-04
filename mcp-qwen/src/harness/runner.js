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
import { normalizeWorkspacePath } from "../wsl_bridge.js";

const DEFAULT_SYSTEM_PROMPT = `You are the Autonomous Execution Coworker (Qwen3.8-27B) running in the DeepSeek AVO harness.
You pair with the Lead Architect (Gemini / Claude) to explore, design, edit, test, and optimize software systems.

Operating Guidelines:
1. Ground truth lives in active source code, tests, and build artifacts. Never assume or hallucinate.
2. Use sandboxed filesystem tools: 'read_file', 'write_file', 'edit_file', 'list_dir', 'search_code'.
3. Use 'bash' to run builds, tests, benchmarks, or git operations safely.
4. When optimizing or refactoring, use NVIDIA AVO tools:
   - 'avo_propose_candidate' to snapshot files before modifying.
   - 'avo_evaluate_candidate' to test and compute fitness score.
   - 'avo_select_candidate' to accept improvements, or 'avo_revert_candidate' to rollback regressions.
5. Provide concise, direct technical summaries of your actions and findings.`;

export class DeepSeekAvoRunner {
  constructor(options = {}) {
    this.defaultCwd = options.cwd ? normalizeWorkspacePath(options.cwd) : process.cwd();
    this.defaultMaxTurns = options.maxTurns || 100;
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

    // Mount core services
    ctx.plugin(sandboxFsPlugin, { root: effectiveCwd });
    ctx.plugin(shellExecutorPlugin, { cwd: effectiveCwd });
    ctx.plugin(eventLoggerPlugin, { sessionId });
    ctx.plugin(vllmProviderPlugin);
    ctx.plugin(avoPlugin, { workspaceRoot: effectiveCwd });

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

        // If no tool calls, the model concluded its turn
        if (!turnResult.toolCalls || turnResult.toolCalls.length === 0) {
          break;
        }

        // Execute each requested tool call
        for (const tc of turnResult.toolCalls) {
          if (signal?.aborted) break;

          let parsedArgs = {};
          try {
            parsedArgs = JSON.parse(tc.function.arguments || "{}");
          } catch {
            parsedArgs = { raw: tc.function.arguments };
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
