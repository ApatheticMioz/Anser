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
  STREAM_IDLE_TIMEOUT_MS_DEEP,
  STREAM_IDLE_DEPTH_TOKENS,
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
   *
   * Every failure path (network error, non-2xx, unparseable body, missing
   * `data` array) throws an error carrying the upstream status/detail; only a
   * genuine 2xx with a parseable `data` array yields a model list.
   * @returns {Promise<string[]>} The list of model ids.
   * @throws {Error} When the probe fails for any reason.
   */
  async listModels() {
    let res;
    try {
      res = await fetch(`${this.baseUrl}/models`, {
        signal: AbortSignal.timeout(5000),
      });
    } catch (err) {
      // Network-level failure (connection refused / timeout / DNS): the
      // engine (or proxy) is unreachable. Surface it verbatim — never a
      // fabricated list.
      throw new Error(
        `listModels: vLLM /models probe failed against ${this.baseUrl}: ${
          err && err.message ? err.message : String(err)
        }`
      );
    }
    if (!res.ok) {
      // Non-2xx: the engine answered but rejected the probe. Carry the
      // upstream status + body so the failure is decidable.
      let detail = "";
      try {
        detail = await res.text();
      } catch {}
      throw new Error(
        `listModels: vLLM /models probe returned HTTP ${res.status} ${res.statusText} from ${this.baseUrl}: ${detail}`
      );
    }
    let data;
    try {
      data = await res.json();
    } catch (err) {
      throw new Error(
        `listModels: vLLM /models returned 200 but an unparseable body from ${this.baseUrl}: ${
          err && err.message ? err.message : String(err)
        }`
      );
    }
    if (!data || !Array.isArray(data.data)) {
      throw new Error(
        `listModels: vLLM /models returned 200 but no 'data' array from ${this.baseUrl} (body: ${JSON.stringify(data)})`
      );
    }
    return data.data.map((m) => m.id);
  }

  /**
   * Streams a chat completion turn from vLLM.
   *
   * @param {object} params
   * @param {Array<object>} params.messages
   * @param {Array<object>} [params.tools] OpenAI-formatted tools
   * @param {number} [params.temperature]
   * @param {number} [params.maxTokens]
   * @param {string} [params.reasoningEffort] Task-local reasoning-effort tier
   *   (one of REASONING_EFFORT_TIERS). When provided it overrides the
   *   QWEN_REASONING_EFFORT env default for THIS request only — no
   *   process.env mutation, so it never leaks across concurrent tasks.
   * @param {AbortSignal} [params.signal]
   * @param {(token: string) => void} [params.onToken]
   * @param {(metric: object) => void} [params.onMetrics]
   * @returns {Promise<{
   *   content: string,
   *   toolCalls: Array<{ id: string, name: string, arguments: string }>,
   *   finishReason: string | null,
   *   metrics: { promptTokens: number, completionTokens: number, ttftMs: number, prefillMs: number, generationMs: number, totalMs: number, reasoningTokens: number, hadReasoning: boolean, reasoningCeilingHit: boolean, streamIdleTimeoutMs: number, streamIdleTier: "shallow" | "deep", promptTokensEstimated?: boolean }
   * }>}
   */
  async streamChat({
    messages,
    tools = [],
    temperature = this.defaultTemperature,
    maxTokens = this.defaultMaxTokens,
    reasoningEffort,
    signal,
    sessionId,
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
      // vLLM 0.28+: request the engine-reported token usage in a terminal
      // SSE chunk (empty choices + a `usage` field). Additive only — engines
      // that ignore it simply never emit the chunk, and we fall back to the
      // chars-based estimate below.
      stream_options: { include_usage: true },
    };

    if (tools && tools.length > 0) {
      payload.tools = tools;
      payload.tool_choice = "auto";
    }

    // Reasoning-effort passthrough: a task-local `reasoningEffort` param
    // (threaded from the qwen_coworker dispatch) takes precedence; when it is
    // absent the existing dynamic QWEN_REASONING_EFFORT read is the fallback
    // (unchanged behavior). Forwarded to the vLLM chat template so the engine
    // can trade thinking depth for latency per dispatch. When neither is set,
    // send nothing and let the server default apply.
    const effectiveReasoningEffort = reasoningEffort || getReasoningEffort();
    if (effectiveReasoningEffort) {
      payload.chat_template_kwargs = {
        reasoning_effort: effectiveReasoningEffort,
      };
    }

    let activeUrl = this.baseUrl;
    let response;

    // Compose an internal abort controller with the caller's signal so the
    // stream-idle watchdog and the reasoning ceiling can end the request
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
        // Threaded from streamChat (where the chars-based estimate is computed
        // for the context-headroom clamp) so _consumeStream can fall back to it
        // when the engine does not emit a stream_options usage chunk.
        estimatedPromptTokens,
        sessionId,
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
   * - Stream-idle watchdog: if no meaningful SSE frame arrives within the
   *   armed idle window, the request is aborted and the turn fails. The
   *   window is STREAM_IDLE_TIMEOUT_MS (shallow) for normal turns, or
   *   STREAM_IDLE_TIMEOUT_MS_DEEP when the estimated prompt tokens reach
   *   STREAM_IDLE_DEPTH_TOKENS (deep-context turns). The fired tier is named
   *   in the thrown error and in metrics.streamIdleTier. Proxy keep-alive
   *   comment frames (": keep-alive") do not reset the watchdog.
   * - Reasoning ceiling: when estimated reasoning tokens exceed
   *   MAX_REASONING_TOKENS in a single turn, the stream is ended locally with
   *   finish_reason "length" and reasoningCeilingHit set.
   * - finish_reason: a stream that ends with no finish_reason and produced
   *   neither content nor tool calls is reported as null, not synthesized as
   *   "stop".
   *
   * @param {object} params
   * @param {Response} params.response
   * @param {TextDecoder} params.decoder
   * @param {number} params.t0
   * @param {number} params.estimatedPromptTokens
   * @param {string} [params.sessionId]
   * @param {(token: string) => void} [params.onToken]
   * @param {(metric: object) => void} [params.onMetrics]
   * @param {AbortController} params.controller
   * @param {() => void} [params.cleanup]
   * @returns {Promise<{
   *   content: string,
   *   reasoning: string,
   *   toolCalls: Array<{ id: string, name: string, arguments: string }>,
   *   finishReason: string | null,
   *   metrics: object,
   *   reasoningTokens: number,
   *   hadReasoning: boolean
   * }>}
   */
  async _consumeStream({
    response,
    decoder,
    t0,
    estimatedPromptTokens,
    sessionId,
    onToken,
    onMetrics,
    controller,
    cleanup,
  }) {
    const reader = response.body.getReader();
    let buffer = "";
    let fullContent = "";
    let fullReasoning = "";
    let finishReason = null;
    let ttft = null;
    let completionTokens = 0;
    let reasoningTokens = 0;
    let hadReasoning = false;
    let reasoningCeilingHit = false;
    let idleTimedOut = false;
    let idleTimer = null;
    // Engine-reported usage from the terminal stream_options chunk (vLLM 0.28+).
    // Null until the engine emits it; the chars-based estimate is the fallback.
    let engineUsage = null;
    const toolCallsMap = new Map(); // index -> { id, name, arguments }

    // Depth-aware idle tier: a deep-context prompt (estimated prompt tokens
    // >= STREAM_IDLE_DEPTH_TOKENS) gets the longer DEEP window; normal turns
    // keep the SHALLOW window. The tier is chosen from the chars-based
    // estimate already computed in streamChat.
    const isDeep = estimatedPromptTokens >= STREAM_IDLE_DEPTH_TOKENS;
    const idleTimeoutMs = isDeep ? STREAM_IDLE_TIMEOUT_MS_DEEP : STREAM_IDLE_TIMEOUT_MS;
    const idleTier = isDeep ? "deep" : "shallow";
    let deepTierLogged = false;

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
        controller.abort(new Error(`stream idle > ${idleTimeoutMs}ms (${idleTier} tier)`));
      }, idleTimeoutMs);
      if (typeof idleTimer.unref === "function") idleTimer.unref();
      // Log once when the deep tier arms.
      if (isDeep && !deepTierLogged) {
        deepTierLogged = true;
        console.error(
          `[VllmProvider] Deep-context turn (est. prompt ${estimatedPromptTokens} tokens >= ${STREAM_IDLE_DEPTH_TOKENS}): arming ${idleTimeoutMs}ms (${idleTier} tier) stream-idle watchdog.`
        );
      }
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
            const sid = sessionId || "SESSION_ID";
            const inspectCmd = `node mcp-qwen/src/harness/services/event_logger.js ${sid} 5`;
            throw new Error(
              `vLLM stream idle timeout (${idleTier} tier, ${idleTimeoutMs}ms): no meaningful SSE tokens emitted within window.\n` +
              `[Orchestrator Advisory]: There might have been an issue (e.g. extended GPU contention or deliberation).\n` +
              `You can run:\n` +
              `  ${inspectCmd}\n` +
              `to inspect the last few traces, and decide whether to roll into a new session (e.g. '${sid}_stage2'), or use the same session and same effort to finish/continue.`
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

              // stream_options { include_usage: true } (vLLM 0.28+): the engine
              // emits a terminal chunk whose `choices` is EMPTY and whose
              // `usage` field carries the authoritative prompt/completion token
              // counts. Capture it here, before the `choice` guard below, so the
              // empty-choices chunk is consumed gracefully and does not
              // contribute to the finish-reason or content signals.
              if (chunk.usage && typeof chunk.usage === "object") {
                engineUsage = chunk.usage;
              }

              const choice = chunk.choices?.[0];
              if (!choice) continue;

              if (choice.finish_reason) {
                finishReason = choice.finish_reason;
              }

              const delta = choice.delta;
              if (!delta) continue;

              // Server-side reasoning (thinking) is streamed by vLLM's
              // --reasoning-parser qwen3 as delta.reasoning, while some engines
              // / older parsers use delta.reasoning_content. Normalize both so
              // accounting works regardless of which the engine emits. It is
              // accounted for (so the ledger shows thinking volume and TTFT
              // reflects the first output of any kind) but is not appended to
              // fullContent or forwarded to onToken — the user-visible token
              // stream stays clean, and the engine-side /metrics token counters
              // already cover watchdog velocity.
              const reasoningText =
                typeof delta.reasoning === "string"
                  ? delta.reasoning
                  : typeof delta.reasoning_content === "string"
                    ? delta.reasoning_content
                    : null;
              if (reasoningText && reasoningText.length > 0) {
                hadReasoning = true;
                fullReasoning += reasoningText;
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

              // Reasoning-ceiling enforcement: cutting the stream here reports
              // as a length cutoff (with hadReasoning already true), which
              // routes the runner into the reasoning-cutoff continuation
              // directive instead of a retry/failure path.
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
            } catch (err) {
              console.error(`[VllmProvider] Partial SSE parse anomaly (token undercount): ${err.message}`);
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
    const prefillMs = ttft ?? totalMs;
    const generationMs = Math.max(0, totalMs - prefillMs);

    // Prompt-token telemetry: prefer the engine-reported usage (authoritative)
    // from the stream_options terminal chunk; when the engine did not emit it,
    // fall back to the chars-based estimate already computed for the
    // context-headroom clamp and mark the metric as estimated so downstream
    // consumers never mistake a guess for a measurement.
    const enginePromptTokens =
      engineUsage && Number.isFinite(engineUsage.prompt_tokens)
        ? engineUsage.prompt_tokens
        : null;
    const promptTokens = enginePromptTokens ?? estimatedPromptTokens;
    const promptTokensEstimated = enginePromptTokens === null;

    // Completion tokens: the engine's usage is authoritative over the local
    // per-delta count when present; reasoning accounting is left untouched.
    const engineCompletionTokens =
      engineUsage && Number.isFinite(engineUsage.completion_tokens)
        ? engineUsage.completion_tokens
        : null;
    const effectiveCompletionTokens =
      engineCompletionTokens ?? completionTokens;

    // Industry-standard throughput rates & per-token latency, derived from the
    // raw timestamps above. All are null when the denominator is non-positive
    // (or, for TPOT, when there is not enough output to divide by) so consumers
    // never see a fabricated rate.
    //   prefillTps: prompt tokens / prefill seconds (prefill throughput)
    //   decodeTps:  completion tokens / decode seconds (decode throughput)
    //   tpotMs:     vLLM Time-Per-Output-Token = decode time / (output tokens - 1)
    const prefillTps =
      prefillMs > 0 ? Number((promptTokens / (prefillMs / 1000)).toFixed(2)) : null;
    const decodeTps =
      generationMs > 0
        ? Number((effectiveCompletionTokens / (generationMs / 1000)).toFixed(2))
        : null;
    const tpotMs =
      effectiveCompletionTokens > 1 && generationMs > 0
        ? Number((generationMs / (effectiveCompletionTokens - 1)).toFixed(2))
        : null;

    const metrics = {
      promptTokens,
      completionTokens: effectiveCompletionTokens,
      ttftMs: prefillMs,
      prefillMs,
      generationMs,
      totalMs,
      reasoningTokens,
      hadReasoning,
      reasoningCeilingHit,
      // Report the actual idle window that armed for this turn (deep vs
      // shallow tier), not the static shallow default.
      streamIdleTimeoutMs: idleTimeoutMs,
      streamIdleTier: idleTier,
      prefillTps,
      decodeTps,
      tpotMs,
      ...(promptTokensEstimated ? { promptTokensEstimated: true } : {}),
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

    // Never synthesize a finish reason the engine never sent. A stream that
    // ended with no reason and no real output stays null so the runner
    // classifies it (retry → engine_empty_response) instead of mistaking a
    // dead stream for a clean stop. The tool_calls fallback is retained for
    // engines that legitimately end the stream after complete tool calls.
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
      reasoning: fullReasoning,
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
