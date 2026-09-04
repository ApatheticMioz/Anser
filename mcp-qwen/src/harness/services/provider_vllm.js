/**
 * Direct vLLM HTTP/SSE Streaming Client (DeepSeek AVO Provider)
 *
 * Provides:
 * - Direct HTTP streaming against vLLM (:18020) or Stream Proxy (:18022)
 * - Proactive keep-alive frame handling
 * - OpenAI-compatible function/tool calling parser
 * - Live token velocity (tokens/sec) and TTFT measurement
 * - Reversible Cordis plugin binding
 */

import { STREAM_PROXY_PORT, VLLM_PORT } from "../../config.js";

export class VllmProviderService {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || `http://127.0.0.1:${STREAM_PROXY_PORT}/v1`;
    this.fallbackUrl = options.fallbackUrl || `http://127.0.0.1:${VLLM_PORT}/v1`;
    this.model = options.model || "qwen3.8-27b";
    this.defaultTemperature = options.temperature ?? 0.0;
    this.defaultMaxTokens = options.maxTokens ?? 16384;
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
   *   finishReason: string,
   *   metrics: { promptTokens: number, completionTokens: number, ttftMs: number, totalMs: number, tokensPerSec: number }
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
    let ttft = null;
    let completionTokens = 0;

    const payload = {
      model: this.model,
      messages,
      stream: true,
      temperature,
      max_tokens: maxTokens,
    };

    if (tools && tools.length > 0) {
      payload.tools = tools;
      payload.tool_choice = "auto";
    }

    let activeUrl = this.baseUrl;
    let response;
    try {
      response = await fetch(`${activeUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal,
      });
    } catch (err) {
      // Fallback directly to upstream vLLM port if proxy connection refused
      activeUrl = this.fallbackUrl;
      response = await fetch(`${activeUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal,
      });
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(`vLLM stream error (${response.status} ${response.statusText}): ${errText}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let fullContent = "";
    let finishReason = null;
    const toolCallsMap = new Map(); // index -> { id, name, arguments }

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop(); // keep last incomplete line

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":")) {
          // SSE comment / keep-alive heartbeat frame
          continue;
        }

        if (trimmed === "data: [DONE]") {
          break;
        }

        if (trimmed.startsWith("data: ")) {
          const jsonStr = trimmed.slice(6);
          try {
            const chunk = JSON.parse(jsonStr);
            const choice = chunk.choices?.[0];
            if (!choice) continue;

            if (choice.finish_reason) {
              finishReason = choice.finish_reason;
            }

            const delta = choice.delta;
            if (!delta) continue;

            // Measure Time to First Token
            if (ttft === null && (delta.content || delta.tool_calls)) {
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
          } catch {
            // Ignore partial SSE JSON parse anomalies
          }
        }
      }
    }

    const totalMs = Math.max(1, Date.now() - t0);
    const tokensPerSec = Number(((completionTokens / totalMs) * 1000).toFixed(2));
    const metrics = {
      promptTokens: 0, // In stream mode, vLLM usage summary is optional
      completionTokens,
      ttftMs: ttft ?? totalMs,
      totalMs,
      tokensPerSec,
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

    return {
      content: fullContent,
      toolCalls,
      finishReason: finishReason || (toolCalls.length > 0 ? "tool_calls" : "stop"),
      metrics,
    };
  }
}

/**
 * Cordis Plugin to mount VllmProviderService into Context.
 */
export function vllmProviderPlugin(ctx, options = {}) {
  const provider = new VllmProviderService(options);
  return ctx.provide("llm", provider);
}
