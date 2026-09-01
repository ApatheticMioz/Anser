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

  const upstreamUrl = `http://127.0.0.1:${UPSTREAM_PORT}${req.url}`;
  const upstreamReq = http.request(
    upstreamUrl,
    {
      method: req.method,
      headers,
    },
    (upstreamRes) => {
      const contentType = upstreamRes.headers["content-type"] || "";
      const isEventStream = contentType.includes("text/event-stream");

      // Non-streaming endpoint: pipe directly
      if (!isEventStream) {
        res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
        upstreamRes.pipe(res);
        return;
      }

      // Streaming SSE endpoint: sanitize headers, strip Content-Length / Transfer-Encoding
      // to let Node's HTTP chunking handle streaming without chunk boundary mismatch.
      const cleanHeaders = { ...upstreamRes.headers };
      delete cleanHeaders["content-length"];
      delete cleanHeaders["transfer-encoding"];

      res.writeHead(upstreamRes.statusCode, {
        ...cleanHeaders,
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      });

      // Keepalive heartbeat: emit an SSE comment (: ping\n\n) every 15s to keep
      // TCP sockets alive and prevent client/proxy stream stall timeouts during long prefills.
      const pingInterval = setInterval(() => {
        try {
          res.write(": ping\n\n");
        } catch {}
      }, 15000);

      const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
      let lineBuffer = "";
      let hasDone = false;

      upstreamRes.on("data", (chunk) => {
        const text = decoder.decode(chunk, { stream: true });
        if (!text) return;

        lineBuffer += text;
        const lines = lineBuffer.split("\n");
        lineBuffer = lines.pop(); // Retain incomplete trailing line

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed === "data: [DONE]") {
            hasDone = true;
          } else if (trimmed.startsWith("data: ")) {
            const jsonPayload = trimmed.slice(6).trim();
            if (jsonPayload.startsWith("{") && jsonPayload.includes('"error"')) {
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
              } catch {}
            }
          }
          res.write(line + "\n");
        }
      });

      upstreamRes.on("end", () => {
        clearInterval(pingInterval);
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
        clearInterval(pingInterval);
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
        clearInterval(pingInterval);
        upstreamReq.destroy();
      });
    }
  );

  upstreamReq.setTimeout(0);

  upstreamReq.on("error", (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "vLLM upstream connection error", details: err.message }));
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

  // Sanitize incoming chat completions requests to guard against multimodal image crashes
  if (req.method === "POST" && req.url.startsWith("/v1/chat/completions")) {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const rawBody = Buffer.concat(chunks);
      try {
        const bodyStr = rawBody.toString("utf8");
        if (bodyStr.includes('"image"') || bodyStr.includes('"image_url"')) {
          const body = JSON.parse(bodyStr);
          let modified = false;
          if (Array.isArray(body.messages)) {
            for (const msg of body.messages) {
              if (Array.isArray(msg.content)) {
                for (let i = 0; i < msg.content.length; i++) {
                  const part = msg.content[i];
                  if (part && (part.type === "image_url" || part.type === "image")) {
                    msg.content[i] = {
                      type: "text",
                      text: "[Image file omitted: Local Qwen3.8-27B runs in pure text mode for Universal 245K context. Images must be inspected multimodally by the Lead Architect.]",
                    };
                    modified = true;
                  }
                }
              }
            }
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
