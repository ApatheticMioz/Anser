import http from "http";
import assert from "assert";

const MOCK_VLLM_PORT = 18995;
const PROXY_PORT = 18996;

function createProxy(upstreamPort, listenPort) {
  const server = http.createServer((req, res) => {
    const upstreamReq = http.request(
      `http://127.0.0.1:${upstreamPort}${req.url}`,
      {
        method: req.method,
        headers: {
          ...req.headers,
          host: `127.0.0.1:${upstreamPort}`,
        },
      },
      (upstreamRes) => {
        const isEventStream = (upstreamRes.headers["content-type"] || "").includes("text/event-stream");

        if (!isEventStream) {
          res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
          upstreamRes.pipe(res);
          return;
        }

        res.writeHead(upstreamRes.statusCode, {
          ...upstreamRes.headers,
          "content-type": "text/event-stream; charset=utf-8",
        });

        const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
        let lineBuffer = "";

        upstreamRes.on("data", (chunk) => {
          const text = decoder.decode(chunk, { stream: true });
          if (!text) return;

          lineBuffer += text;
          const lines = lineBuffer.split("\n");
          lineBuffer = lines.pop(); // keep last incomplete line

          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith("data: ") && trimmed !== "data: [DONE]") {
              try {
                const parsed = JSON.parse(trimmed.slice(6));
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
                        delta: { content: `\n\n[vLLM Mid-Stream Error: ${errMsg}]\n\n` },
                        finish_reason: "stop",
                      },
                    ],
                  };
                  res.write(`data: ${JSON.stringify(safeChunk)}\n\ndata: [DONE]\n\n`);
                  continue;
                }
              } catch {}
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
          try { res.end(); } catch {}
        });
      }
    );

    upstreamReq.on("error", (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" });
      }
      res.end(JSON.stringify({ error: "vLLM upstream proxy error", details: err.message }));
    });

    req.pipe(upstreamReq);
  });

  return server;
}

async function testSuite() {
  console.log("=== Testing Stream Proxy with Multi-Byte Splitting & Mid-Stream Error Translation ===");

  // Mock server
  const mockServer = http.createServer((req, res) => {
    if (req.url === "/v1/split") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"Sym: ');
      // Split 3-byte '∀' (0xE2 0x88 0x80) across 2 chunks
      res.write(Buffer.from([0xE2]));
      setTimeout(() => {
        res.write(Buffer.concat([Buffer.from([0x88, 0x80]), Buffer.from('"}}]\n\n')]));
        res.write('data: [DONE]\n\n');
        res.end();
      }, 20);
    } else if (req.url === "/v1/error_midstream") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"Starting..."}}]\n\n');
      setTimeout(() => {
        // vLLM error packet mid-stream
        res.write('data: {"error":{"message":"Engine allocation failure: KV cache full","type":"server_error"}}\n\n');
        res.end();
      }, 20);
    }
  });

  await new Promise(r => mockServer.listen(MOCK_VLLM_PORT, "127.0.0.1", r));
  const proxy = createProxy(MOCK_VLLM_PORT, PROXY_PORT);
  await new Promise(r => proxy.listen(PROXY_PORT, "127.0.0.1", r));

  // Test 1: Split multi-byte sequence
  let splitOutput = "";
  await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${PROXY_PORT}/v1/split`, (res) => {
      res.on("data", chunk => splitOutput += chunk.toString("utf8"));
      res.on("end", resolve);
      res.on("error", reject);
    });
  });

  assert.ok(splitOutput.includes("Sym: ∀"), "Split UTF-8 multi-byte symbol was successfully assembled!");
  console.log("[PASS] Multi-byte splitting test passed.");

  // Test 2: Mid-stream error translation
  let errOutput = "";
  await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${PROXY_PORT}/v1/error_midstream`, (res) => {
      res.on("data", chunk => errOutput += chunk.toString("utf8"));
      res.on("end", resolve);
      res.on("error", reject);
    });
  });

  assert.ok(errOutput.includes("[vLLM Mid-Stream Error: Engine allocation failure: KV cache full]"), "Mid-stream error was sanitized to safe chunk!");
  assert.ok(errOutput.includes("data: [DONE]"), "Stream finished cleanly with [DONE]!");
  console.log("[PASS] Mid-stream error translation test passed.");

  await new Promise(r => mockServer.close(r));
  await new Promise(r => proxy.close(r));
  console.log("=== ALL TESTS PASSED ===");
}

testSuite().catch(e => {
  console.error(e);
  process.exit(1);
});
