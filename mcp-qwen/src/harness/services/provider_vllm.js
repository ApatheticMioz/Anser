/**
 * Direct vLLM HTTP/SSE Streaming Client (Anser vLLM Provider)
 *
 * Provides:
 * - Direct HTTP streaming against vLLM (:18020) or Stream Proxy (:18022)
 * - Proactive keep-alive frame handling
 * - OpenAI-compatible function/tool calling parser
 * - Live token velocity (tokens/sec) and TTFT measurement
 * - Reversible Anser plugin binding
 */

import {
  STREAM_PROXY_PORT,
  VLLM_PORT,
  MAX_TOKENS,
  MAX_LEN_HUGE,
  getReasoningEffort,
  STREAM_IDLE_TIMEOUT_MS,
  MAX_REASONING_TOKENS,
} from "../../config.js";

export class VllmProviderService {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || `http://127.0.0.1:${STREAM_PROXY_PORT}/v1`;
    this.fallbackUrl = options.fallbackUrl || `http://127.0.0.1:${VLLM_PORT}/v1`;
    this.model = options.model || "qwen3.8-27b";
    this.defaultTemperature = options.temperature ?? 0.0;
    this.defaultMaxTokens = options.maxTokens ?? MAX_TOKENS;
  }

  /**
   * Fetches available models from the vLLM server.
   */
  async listModels() {
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const data = await res.json();
        return (data.data || []).map((m) => m.id);
      }
    } catch {}
    return [this.model];
  }

  /**
   * Streams a chat completion turn from vLLM.
   *
   * @param {object} params
   * @param {Array<object>} params.messages
   * @param {Array<object>} [params.tools] OpenAI-formatted tools
   * @param {number} [params.temperature]
   * @param {number} [params.maxTokens]
   * @param {AbortSignal} [params.signal]
   * @param {(token: string) => void} [params.onToken]
   * @param {(metric: object) => void} [params.onMetrics]
   * @returns {Promise<{
   *   content: string,
   *   toolCalls: Array<{ id: string, name: string, arguments: string }>,
   *   finishReason: string | null,
   *   metrics: { promptTokens: number, completionTokens: number, ttftMs: number, totalMs: number, tokensPerSec: number, reasoningTokens: number, hadReasoning: boolean, reasoningCeilingHit: boolean, streamIdleTimeoutMs: number }
   * }>}
   */
  async streamChat({
    messages,
    tools = [],
    temperature = this.defaultTemperature,
    maxTokens = this.defaultMaxTokens,
    signal,
    onToken,
    onMetrics,
  }) {
    const t0 = Date.now();

    // Dynamic headroom clamping against MAX_LEN_HUGE (245,760)
    const promptChars = JSON.stringify(messages).length + (tools && tools.length > 0 ? JSON.stringify(tools).length : 0);
    const estimatedPromptTokens = Math.ceil(promptChars / 3.5);
    const maxPossibleHeadroom = Math.max(0, MAX_LEN_HUGE - estimatedPromptTokens - 128);

    if (maxPossibleHeadroom < 1024) {
      throw new Error(
        `ContextExhaustedError: Prompt consumes ~${estimatedPromptTokens} tokens, leaving insufficient headroom (<1024) under model context limit (${MAX_LEN_HUGE}).`
      );
    }

    const clampedMaxTokens = Math.min(maxTokens, maxPossibleHeadroom);

    const payload = {
      model: this.model,
      messages,
      stream: true,
      temperature,
      max_tokens: clampedMaxTokens,
    };

    if (tools && tools.length > 0) {
      payload.tools = tools;
      payload.tool_choice = "auto";
    }

    // Reasoning-effort passthrough: when the orchestrator sets
    // QWEN_REASONING_EFFORT, forward it to the vLLM chat template so the
    // engine can trade thinking depth for latency per dispatch. When unset,
    // send nothing and let the server default apply.
    const reasoningEffort = getReasoningEffort();
    if (reasoningEffort) {
      payload.chat_template_kwargs = { reasoning_effort: reasoningEffort };
    }

    let activeUrl = this.baseUrl;
    let response;

    // P7b: compose an internal abort controller with the caller's signal so
    // the stream-idle watchdog and the reasoning ceiling can end the request
    // themselves, while an external cancel still propagates.
    const streamController = new AbortController();
    const onExternalAbort = () => streamController.abort(signal?.reason);
    if (signal) {
      if (signal.aborted) streamController.abort(signal.reason);
      else signal.addEventListener("abort", onExternalAbort, { once: true });
    }

    try {
      try {
        response = await fetch(`${activeUrl}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: streamController.signal,
        });
      } catch (err) {
        // Fallback directly to upstream vLLM port if proxy connection refused.
        // An abort that ORIGINATED from the caller (not a proxy connect
        // failure) must NOT be retried against the fallback.
        if (signal?.aborted) throw err;
        activeUrl = this.fallbackUrl;
        response = await fetch(`${activeUrl}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: streamController.signal,
        });
      }

      if (!response.ok) {
        const errText = await response.text().catch(() => "");
        throw new Error(`vLLM stream error (${response.status} ${response.statusText}): ${errText}`);
      }

      return await this._consumeStream({
        response,
        decoder: new TextDecoder("utf-8"),
        t0,
        onToken,
        onMetrics,
        controller: streamController,
        cleanup: () => {
          if (signal) signal.removeEventListener("abort", onExternalAbort);
        },
      });
    } finally {
      if (signal) signal.removeEventListener("abort", onExternalAbort);
    }
  }

  /**
   * Reads the SSE body of an established streaming response.
   *
   * P7b hardening:
   * - Stream-idle watchdog: if no MEANINGFUL SSE frame arrives within
   *   STREAM_IDLE_TIMEOUT_MS, the request is aborted and the turn fails
   *   loudly instead of blocking forever. Proxy keep-alive comment frames
   *   (": keep-alive") deliberately do NOT reset the watchdog — they keep
   *   the TCP hop alive without masking true engine silence.
   * - Reasoning ceiling: when estimated reasoning tokens exceed
   *   MAX_REASONING_TOKENS in a single turn (a thinking loop hogging the
   *   engine — see P7b forensics), the stream is ended locally with
   *   finish_reason "length" + reasoningCeilingHit so the runner's P2d
   *   reasoning-cutoff continuation directive lands.
   * - Honest finish_reason: a stream that ends WITHOUT any finish_reason
   *   and produced neither content nor tool calls is reported as null, not
   *   synthesized as "stop" (P2b: absent signal is never trusted as success).
   */
  async _consumeStream({
    response,
    decoder,
    t0,
    onToken,
    onMetrics,
    controller,
    cleanup,
  }) {
    const reader = response.body.getReader();
    let buffer = "";
    let fullContent = "";
    let finishReason = null;
    let ttft = null;
    let completionTokens = 0;
    let reasoningTokens = 0;
    let hadReasoning = false;
    let reasoningCeilingHit = false;
    let idleTimedOut = false;
    let idleTimer = null;
    const toolCallsMap = new Map(); // index -> { id, name, arguments }

    const disarmIdle = () => {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
    };
    const armIdle = () => {
      disarmIdle();
      idleTimer = setTimeout(() => {
        idleTimedOut = true;
        controller.abort(new Error(`stream idle > ${STREAM_IDLE_TIMEOUT_MS}ms`));
      }, STREAM_IDLE_TIMEOUT_MS);
      if (typeof idleTimer.unref === "function") idleTimer.unref();
    };

    let currentSseEvent = null;
    try {
      armIdle();
      while (true) {
        let readResult;
        try {
          readResult = await reader.read();
        } catch (err) {
          if (idleTimedOut) {
            throw new Error(
              `vLLM stream idle timeout: no meaningful SSE frame for ${STREAM_IDLE_TIMEOUT_MS}ms`
            );
          }
          throw err;
        }
        const { done, value } = readResult;
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop(); // keep last incomplete line

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(":")) {
            // SSE comment / keep-alive heartbeat frame — NOT engine activity.
            continue;
          }

          // Any meaningful SSE frame proves the engine (or an interceptor)
          // is alive and producing; reset the idle watchdog.
          armIdle();

          if (trimmed.startsWith("event: ")) {
            currentSseEvent = trimmed.slice(7).trim();
            continue;
          }

          if (trimmed === "data: [DONE]") {
            break;
          }

          if (trimmed.startsWith("data: ")) {
            const jsonStr = trimmed.slice(6);
            if (currentSseEvent === "error") {
              let errMsg = jsonStr;
              try {
                const parsedErr = JSON.parse(jsonStr);
                errMsg = parsedErr.error?.message || parsedErr.message || jsonStr;
              } catch {}
              throw new Error(`vLLM upstream SSE error: ${errMsg}`);
            }
            currentSseEvent = null;

            try {
              const chunk = JSON.parse(jsonStr);
              if (chunk.error && !chunk.choices) {
                const errMsg = chunk.error.message || JSON.stringify(chunk.error);
                throw new Error(`vLLM upstream error: ${errMsg}`);
              }
              if (chunk.id === "chatcmpl-stream-err") {
                const errMsg = chunk.choices?.[0]?.delta?.content || "vLLM stream error";
                throw new Error(`vLLM stream error: ${errMsg}`);
              }

              const choice = chunk.choices?.[0];
              if (!choice) continue;

              if (choice.finish_reason) {
                finishReason = choice.finish_reason;
              }

              const delta = choice.delta;
              if (!delta) continue;

              // Server-side reasoning (thinking) is streamed by vLLM's
              // --reasoning-parser qwen3 as delta.reasoning (the LIVE field, per
              // a live SSE capture), while some engines / older parsers use
              // delta.reasoning_content. Normalize BOTH so accounting works
              // regardless of which the engine emits. We account for it (so the
              // ledger shows thinking volume and TTFT reflects the first output
              // of ANY kind) but we do NOT append it to fullContent or forward it
              // to onToken — the user-visible token stream stays clean, and the
              // engine-side /metrics token counters already cover watchdog
              // velocity.
              const reasoningText =
                typeof delta.reasoning === "string"
                  ? delta.reasoning
                  : typeof delta.reasoning_content === "string"
                    ? delta.reasoning_content
                    : null;
              if (reasoningText && reasoningText.length > 0) {
                hadReasoning = true;
                // ~chars/4 is a reasonable token estimate for thinking text.
                reasoningTokens += Math.max(1, Math.round(reasoningText.length / 4));
              }

              // Measure Time to First Token: the first delta of ANY kind
              // (content, tool call, or reasoning) means generation started.
              if (
                ttft === null &&
                (delta.content || delta.tool_calls || reasoningText)
              ) {
                ttft = Date.now() - t0;
              }

              // Stream text content
              if (delta.content) {
                completionTokens++;
                fullContent += delta.content;
                if (onToken) onToken(delta.content);
              }

              // Stream tool calls
              if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
                for (const tc of delta.tool_calls) {
                  const idx = tc.index ?? 0;
                  if (!toolCallsMap.has(idx)) {
                    toolCallsMap.set(idx, {
                      id: tc.id || `call_${Date.now()}_${idx}`,
                      name: tc.function?.name || "",
                      arguments: tc.function?.arguments || "",
                    });
                  } else {
                    const existing = toolCallsMap.get(idx);
                    if (tc.id && !existing.id) existing.id = tc.id;
                    if (tc.function?.name) existing.name += tc.function.name;
                    if (tc.function?.arguments) existing.arguments += tc.function.arguments;
                  }
                }
              }

              // P7b: reasoning-ceiling enforcement. Cutting the stream here
              // reports as a length cutoff (with hadReasoning already true),
              // which routes the runner into the P2d reasoning-cutoff
              // continuation directive instead of a retry/failure path.
              if (
                !reasoningCeilingHit &&
                reasoningTokens >= MAX_REASONING_TOKENS
              ) {
                reasoningCeilingHit = true;
                finishReason = "length";
                console.error(
                  `[VllmProvider] Reasoning ceiling hit (${reasoningTokens} >= ${MAX_REASONING_TOKENS} est. tokens). Ending turn as length cutoff so the reasoning-cutoff continuation can land.`
                );
                break;
              }
            } catch {
              // Ignore partial SSE JSON parse anomalies
            }
          }
        }

        if (reasoningCeilingHit) break;
      }
    } finally {
      disarmIdle();
      if (cleanup) cleanup();
      // Release the underlying connection when we ended the stream early
      // (reasoning ceiling) so the engine sees a closed request promptly.
      try {
        await reader.cancel();
      } catch {}
    }

    const totalMs = Math.max(1, Date.now() - t0);
    const tokensPerSec = Number(((completionTokens / totalMs) * 1000).toFixed(2));
    const metrics = {
      promptTokens: 0, // In stream mode, vLLM usage summary is optional
      completionTokens,
      ttftMs: ttft ?? totalMs,
      totalMs,
      tokensPerSec,
      reasoningTokens,
      hadReasoning,
      reasoningCeilingHit,
      streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
    };

    if (onMetrics) onMetrics(metrics);

    const toolCalls = Array.from(toolCallsMap.values()).map((tc) => ({
      id: tc.id,
      type: "function",
      function: {
        name: tc.name,
        arguments: tc.arguments,
      },
    }));

    // P7b honesty rule: never synthesize a finish reason the engine never
    // sent. A stream that ended with no reason AND no real output stays
    // null so the runner's P2b/P2d guards classify it (retry → honest
    // engine_empty_response) instead of mistaking a dead stream for a
    // clean stop. The tool_calls fallback is retained for engines that
    // legitimately end the stream after complete tool calls.
    let effectiveFinish = finishReason;
    if (!effectiveFinish) {
      if (toolCalls.length > 0) {
        effectiveFinish = "tool_calls";
      } else if (fullContent.length > 0) {
        effectiveFinish = "stop";
      } // else: null — dead/empty stream, honestly reported
    }

    return {
      content: fullContent,
      toolCalls,
      finishReason: effectiveFinish,
      metrics,
      reasoningTokens,
      hadReasoning,
    };
  }
}

/**
 * Anser Plugin to mount VllmProviderService into Context.
 */
export function vllmProviderPlugin(ctx, options = {}) {
  const provider = new VllmProviderService(options);
  return ctx.provide("llm", provider);
}
