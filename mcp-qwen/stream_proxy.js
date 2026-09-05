#!/usr/bin/env node
/**
 * Universal Stateful UTF-8, SSE Stream Sanitizer & Inbound Multimodal Guard Proxy
 *
 * Architecture:
 * - Listens on: 0.0.0.0:18022 (VLLM_PROXY_PORT)
 * - Upstream:   127.0.0.1:18020 (vLLM Engine)
 *
 * Capabilities:
 * 1. Inbound Multimodal Guard:
 *    When clients (e.g. Goose's read_image tool) send image_url/image blocks,
 *    intercepts and converts them to descriptive text placeholders before reaching
 *    vLLM, preventing "Bad request (400): At most 0 image(s) may be provided in one prompt".
 * 2. Stateful UTF-8 Reconstruction:
 *    Maintains per-stream TextDecoder with { stream: true } to assemble split
 *    multi-byte UTF-8 sequences (math symbols, superscripts 2³, Greek letters,
 *    emojis) across raw TCP/SSE chunk boundaries.
 * 3. Mid-Stream Error Translation:
 *    Intercepts mid-stream vLLM error payloads (`data: {"error": ...}`) that
 *    lack `choices` and converts them into valid completion delta chunks before
 *    Goose's serde parser sees them, eliminating `Stream decode error`.
 * 4. Transparent Pass-Through:
 *    Non-SSE / non-chat requests (GET /v1/models, embeddings, health) are piped directly.
 * 5. Zero External Dependencies:
 *    Standard Node.js http/url modules, runs under WSL2 Linux and Windows.
 */

import http from "http";
import { RepetitionDetector } from "./src/repetition_detector.js";

const UPSTREAM_PORT = parseInt(process.env.VLLM_PORT || "18020", 10);
const PROXY_PORT = parseInt(process.env.VLLM_PROXY_PORT || "18022", 10);
const PROXY_HOST = process.env.VLLM_PROXY_HOST || "0.0.0.0";

function forwardToUpstream(req, res, reqBodyBuffer) {
  // Disable socket-level timeouts on incoming client connection
  if (req.socket) {
    req.socket.setTimeout(0);
    req.socket.setKeepAlive(true, 10000);
    req.socket.setNoDelay(true);
  }

  const headers = { ...req.headers, host: `127.0.0.1:${UPSTREAM_PORT}` };
  if (reqBodyBuffer) {
    headers["content-length"] = reqBodyBuffer.length;
  }

  const isStreamRequest = req.url.startsWith("/v1/chat/completions") && (
    (req.headers["accept"] && req.headers["accept"].includes("text/event-stream")) ||
    (reqBodyBuffer && (reqBodyBuffer.includes('"stream":true') || reqBodyBuffer.includes('"stream": true')))
  );

  let pingInterval = null;
  let hasDone = false;

  // For streaming requests, send 200 OK headers immediately and start proactive keep-alive pings.
  // This keeps the TCP socket active and prevents Goose/reqwest from timing out with
  // "Stream decode error: error decoding response body" during long 30-45s vLLM prompt prefills.
  if (isStreamRequest) {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    try {
      res.write(": keep-alive\n\n");
    } catch {}

    pingInterval = setInterval(() => {
      try {
        res.write(": keep-alive\n\n");
      } catch {}
    }, 5000);
  }

  const upstreamUrl = `http://127.0.0.1:${UPSTREAM_PORT}${req.url}`;
  const upstreamReq = http.request(
    upstreamUrl,
    {
      method: req.method,
      headers,
      agent: false,
    },
    (upstreamRes) => {
      const contentType = upstreamRes.headers["content-type"] || "";
      const isEventStream = contentType.includes("text/event-stream") || isStreamRequest;

      // Non-streaming endpoint: pipe directly
      if (!isEventStream) {
        res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
        upstreamRes.pipe(res);
        return;
      }

      // If headers were not pre-flushed, flush them now
      if (!res.headersSent) {
        const cleanHeaders = { ...upstreamRes.headers };
        delete cleanHeaders["content-length"];
        delete cleanHeaders["transfer-encoding"];

        res.writeHead(upstreamRes.statusCode, {
          ...cleanHeaders,
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
        });

        pingInterval = setInterval(() => {
          try {
            res.write(": keep-alive\n\n");
          } catch {}
        }, 5000);
      }

      // If upstream returned an HTTP error (e.g. 400 or 500), intercept and convert to a clean SSE chunk
      if (upstreamRes.statusCode >= 400) {
        let errBody = "";
        const expectedLen = parseInt(upstreamRes.headers["content-length"] || "0", 10);
        function emitError() {
          if (hasDone) return;
          hasDone = true;
          if (pingInterval) clearInterval(pingInterval);
          let errMsg = `HTTP ${upstreamRes.statusCode}`;
          try {
            const parsed = JSON.parse(errBody);
            errMsg = parsed.error?.message || parsed.message || errBody;
          } catch {
            errMsg = errBody || errMsg;
          }
          const safeChunk = {
            id: "chatcmpl-stream-err",
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: "qwen3.8-27b",
            choices: [
              {
                index: 0,
                delta: { content: `\n\n[vLLM Error: ${errMsg}]\n\n` },
                finish_reason: "stop",
              },
            ],
          };
          res.write(`data: ${JSON.stringify(safeChunk)}\n\ndata: [DONE]\n\n`);
          res.end();
          upstreamReq.destroy();
        }
        upstreamRes.on("data", (c) => {
          errBody += c.toString("utf8");
          if (expectedLen > 0 && Buffer.byteLength(errBody, "utf8") >= expectedLen) {
            emitError();
          }
        });
        upstreamRes.on("end", emitError);
        return;
      }

      const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
      const repetitionDetector = new RepetitionDetector();
      let lineBuffer = "";

      upstreamRes.on("data", (chunk) => {
        const text = decoder.decode(chunk, { stream: true });
        if (!text) return;

        lineBuffer += text;
        if (lineBuffer.includes("data: [DONE]")) {
          hasDone = true;
          if (pingInterval) clearInterval(pingInterval);
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }
        const lines = lineBuffer.split("\n");
        lineBuffer = lines.pop(); // Retain incomplete trailing line

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed === "data: [DONE]") {
            hasDone = true;
            if (pingInterval) clearInterval(pingInterval);
            res.write("data: [DONE]\n\n");
            res.end();
            return;
          } else if (trimmed.startsWith("data: ")) {
            const jsonPayload = trimmed.slice(6).trim();
            if (jsonPayload.startsWith("{")) {
              try {
                const parsed = JSON.parse(jsonPayload);
                if (parsed.error && !parsed.choices) {
                  const errMsg = parsed.error.message || JSON.stringify(parsed.error);
                  const safeChunk = {
                    id: "chatcmpl-stream-err",
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000),
                    model: "qwen3.8-27b",
                    choices: [
                      {
                        index: 0,
                        delta: { content: `\n\n[vLLM Mid-Stream Warning: ${errMsg}]\n\n` },
                        finish_reason: "stop",
                      },
                    ],
                  };
                  res.write(`data: ${JSON.stringify(safeChunk)}\n\ndata: [DONE]\n\n`);
                  hasDone = true;
                  continue;
                }

                // Check for degenerate runaway repetition in token deltas (content or reasoning)
                const delta = parsed?.choices?.[0]?.delta;
                if (delta) {
                  const tokenText = delta.content || delta.reasoning_content || "";
                  if (tokenText) {
                    const rep = repetitionDetector.feed(tokenText);
                    if (rep) {
                      console.error(`[StreamProxy Circuit Breaker] Runaway repetition detected (${rep.type}: ${JSON.stringify(rep.pattern)}, count: ${rep.count}). Safely aborting stream.`);
                      if (pingInterval) clearInterval(pingInterval);
                      hasDone = true;
                      const breakerChunk = {
                        id: "chatcmpl-repetition-breaker",
                        object: "chat.completion.chunk",
                        created: Math.floor(Date.now() / 1000),
                        model: "qwen3.8-27b",
                        choices: [
                          {
                            index: 0,
                            delta: { content: `\n\n[StreamProxy Guard: Runaway repetition loop (${rep.type}: ${JSON.stringify(rep.pattern)}) detected and safely truncated]\n\n` },
                            finish_reason: "stop",
                          },
                        ],
                      };
                      res.write(`data: ${JSON.stringify(breakerChunk)}\n\ndata: [DONE]\n\n`);
                      res.end();
                      upstreamReq.destroy();
                      return;
                    }
                  }
                }
              } catch {}
            }
          }
          res.write(line + "\n");
        }
      });

      upstreamRes.on("end", () => {
        if (pingInterval) clearInterval(pingInterval);
        const tail = decoder.decode();
        if (tail) {
          lineBuffer += tail;
        }
        if (lineBuffer) {
          res.write(lineBuffer + (lineBuffer.endsWith("\n") ? "\n" : "\n\n"));
          if (lineBuffer.includes("[DONE]")) {
            hasDone = true;
          }
        }
        if (!hasDone) {
          res.write("data: [DONE]\n\n");
          hasDone = true;
        }
        res.end();
      });

      upstreamRes.on("error", (err) => {
        if (pingInterval) clearInterval(pingInterval);
        try {
          if (!hasDone) {
            const errMsg = err ? (err.message || String(err)) : "upstream stream error";
            const safeChunk = {
              id: "chatcmpl-stream-err",
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: "qwen3.8-27b",
              choices: [
                {
                  index: 0,
                  delta: { content: `\n\n[vLLM Upstream Stream Interrupted: ${errMsg}]\n\n` },
                  finish_reason: "stop",
                },
              ],
            };
            res.write(`data: ${JSON.stringify(safeChunk)}\n\ndata: [DONE]\n\n`);
            hasDone = true;
          }
          res.end();
        } catch {}
      });

      res.on("close", () => {
        if (pingInterval) clearInterval(pingInterval);
        upstreamReq.destroy();
      });
    }
  );

  upstreamReq.setTimeout(0);

  upstreamReq.on("error", (err) => {
    if (pingInterval) clearInterval(pingInterval);
    if (!res.headersSent) {
      if (isStreamRequest) {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
        });
        res.write(`data: {"id":"chatcmpl-err","object":"chat.completion.chunk","created":${Math.floor(Date.now()/1000)},"model":"qwen3.8-27b","choices":[{"index":0,"delta":{"content":"\\n\\n[vLLM Connection Error: ${err.message}]\\n\\n"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`);
        res.end();
      } else {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "vLLM upstream connection error", details: err.message }));
      }
    } else {
      try {
        res.write(`data: {"id":"chatcmpl-err","object":"chat.completion.chunk","created":${Math.floor(Date.now()/1000)},"model":"qwen3.8-27b","choices":[{"index":0,"delta":{"content":"\\n\\n[vLLM Upstream Connection Error: ${err.message}]\\n\\n"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`);
        res.end();
      } catch {}
    }
  });

  if (reqBodyBuffer) {
    upstreamReq.end(reqBodyBuffer);
  } else {
    req.pipe(upstreamReq);
  }
}

const server = http.createServer((req, res) => {
  // Local health check
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(
      JSON.stringify({
        status: "ok",
        upstream_port: UPSTREAM_PORT,
        proxy_port: PROXY_PORT,
        pid: process.pid,
      })
    );
  }

  // Deep sanitize incoming chat completions requests to guard against multimodal image crashes
  if (req.method === "POST" && req.url.startsWith("/v1/chat/completions")) {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const rawBody = Buffer.concat(chunks);
      try {
        const bodyStr = rawBody.toString("utf8");
        if (
          bodyStr.includes('"image"') ||
          bodyStr.includes('"image_url"') ||
          bodyStr.includes('"input_image"') ||
          bodyStr.includes('"image_file"') ||
          bodyStr.includes("data:image/")
        ) {
          const body = JSON.parse(bodyStr);
          let modified = false;

          function sanitizeItem(item) {
            if (!item) return item;
            if (typeof item === "string") return item;
            if (Array.isArray(item)) {
              return item.map(sanitizeItem);
            }
            if (typeof item === "object") {
              const type = item.type;
              if (
                type === "image_url" ||
                type === "image" ||
                type === "input_image" ||
                type === "image_file" ||
                item.image ||
                item.image_url
              ) {
                modified = true;
                return {
                  type: "text",
                  text: "[Image file omitted: Local Qwen3.8-27B runs in pure text mode for Universal 245K context. Images must be inspected multimodally by the Lead Architect.]",
                };
              }
              for (const k of Object.keys(item)) {
                item[k] = sanitizeItem(item[k]);
              }
            }
            return item;
          }

          if (Array.isArray(body.messages)) {
            for (const msg of body.messages) {
              msg.content = sanitizeItem(msg.content);
            }
          }
          if (body.prompt) {
            body.prompt = sanitizeItem(body.prompt);
          }

          if (modified) {
            const sanitizedBuffer = Buffer.from(JSON.stringify(body), "utf8");
            return forwardToUpstream(req, res, sanitizedBuffer);
          }
        }
      } catch (err) {
        // Fall back to piping raw body if parsing fails
      }
      forwardToUpstream(req, res, rawBody);
    });
    return;
  }

  forwardToUpstream(req, res, null);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.log(`[StreamProxy] Port ${PROXY_PORT} is already in use, reusing running instance.`);
    process.exit(0);
  } else {
    console.error("[StreamProxy] Server error:", err);
    process.exit(1);
  }
});

// Disable Node.js server timeouts so long-running reasoning streams on 245K context never get killed
server.timeout = 0;
server.requestTimeout = 0;
server.headersTimeout = 0;
server.keepAliveTimeout = 0;

server.listen(PROXY_PORT, PROXY_HOST, () => {
  console.log(`[StreamProxy] Universal stream proxy listening on ${PROXY_HOST}:${PROXY_PORT} -> 127.0.0.1:${UPSTREAM_PORT}`);
});

process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});

process.on("SIGINT", () => {
  server.close(() => process.exit(0));
});
