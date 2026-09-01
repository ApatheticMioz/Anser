#!/usr/bin/env node
/**
 * Universal Stateful UTF-8 & SSE Stream Sanitizer Proxy
 *
 * Architecture:
 * - Listens on: 0.0.0.0:18022 (VLLM_PROXY_PORT)
 * - Upstream:   127.0.0.1:18020 (vLLM Engine)
 *
 * Capabilities:
 * 1. Stateful UTF-8 Reconstruction:
 *    Maintains per-stream TextDecoder with { stream: true } to assemble split
 *    multi-byte UTF-8 sequences (math symbols, superscripts 2³, Greek letters,
 *    emojis) across raw TCP/SSE chunk boundaries.
 * 2. Mid-Stream Error Translation:
 *    Intercepts mid-stream vLLM error payloads (`data: {"error": ...}`) that
 *    lack `choices` and converts them into valid completion delta chunks before
 *    Goose's serde parser sees them, eliminating `Stream decode error`.
 * 3. Transparent Pass-Through:
 *    Non-SSE requests (GET /v1/models, embeddings, health) are piped directly.
 * 4. Zero External Dependencies:
 *    Standard Node.js http/url modules, runs under WSL2 Linux and Windows.
 */

import http from "http";

const UPSTREAM_PORT = parseInt(process.env.VLLM_PORT || "18020", 10);
const PROXY_PORT = parseInt(process.env.VLLM_PROXY_PORT || "18022", 10);
const PROXY_HOST = process.env.VLLM_PROXY_HOST || "0.0.0.0";

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

  const upstreamUrl = `http://127.0.0.1:${UPSTREAM_PORT}${req.url}`;
  const upstreamReq = http.request(
    upstreamUrl,
    {
      method: req.method,
      headers: {
        ...req.headers,
        host: `127.0.0.1:${UPSTREAM_PORT}`,
      },
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

      // Streaming SSE endpoint: sanitize UTF-8 and mid-stream error payloads
      res.writeHead(upstreamRes.statusCode, {
        ...upstreamRes.headers,
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });

      const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
      let lineBuffer = "";

      upstreamRes.on("data", (chunk) => {
        const text = decoder.decode(chunk, { stream: true });
        if (!text) return;

        lineBuffer += text;
        const lines = lineBuffer.split("\n");
        lineBuffer = lines.pop(); // Retain incomplete trailing line

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith("data: ") && trimmed !== "data: [DONE]") {
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
                  continue;
                }
              } catch {}
            }
          }
          res.write(line + "\n");
        }
      });

      upstreamRes.on("end", () => {
        const tail = decoder.decode();
        if (tail) {
          lineBuffer += tail;
        }
        if (lineBuffer) {
          res.write(lineBuffer);
        }
        res.end();
      });

      upstreamRes.on("error", () => {
        try {
          res.end();
        } catch {}
      });
    }
  );

  upstreamReq.on("error", (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
    }
    res.end(JSON.stringify({ error: "vLLM upstream connection error", details: err.message }));
  });

  req.pipe(upstreamReq);
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

server.listen(PROXY_PORT, PROXY_HOST, () => {
  console.log(`[StreamProxy] Universal stream proxy listening on ${PROXY_HOST}:${PROXY_PORT} -> 127.0.0.1:${UPSTREAM_PORT}`);
});

process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});

process.on("SIGINT", () => {
  server.close(() => process.exit(0));
});
