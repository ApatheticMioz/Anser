import http from "http";
import assert from "assert";
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import { RepetitionDetector } from "../src/repetition_detector.js";

const MOCK_VLLM_PORT = 18995;
const PROXY_PORT = 18996;

// Ports for the REAL stream_proxy.js regression (P7b): kept distinct from the
// inline mini-proxy ports above so both can coexist during the suite run.
const REAL_PROXY_PORT = 18997;
const REAL_UPSTREAM_PORT = 18998;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Repetition-detector tiering (P2b): code/diff-significant chars (e.g. a
// git-diff '+' hunk) get a HIGH limit of 500, so legitimate long runs in
// model reports pass through, while true degeneracy still trips.
// ---------------------------------------------------------------------------
function testRepetitionTiering() {
  // 120 consecutive '+' (a code char) must PASS (limit 500).
  let d = new RepetitionDetector();
  assert.strictEqual(
    d.feed("+".repeat(120)),
    null,
    "120 consecutive '+' must pass (code char, limit 500)"
  );

  // 400 consecutive '+' must still PASS (below the 500 code limit).
  d = new RepetitionDetector();
  assert.strictEqual(
    d.feed("+".repeat(400)),
    null,
    "400 consecutive '+' must pass (code char, limit 500)"
  );

  // 800 consecutive '+' must TRIP the breaker (exceeds the 500 code limit).
  d = new RepetitionDetector();
  const trip = d.feed("+".repeat(800));
  assert.ok(trip, "800 consecutive '+' must trip the breaker");
  assert.strictEqual(trip.type, "character", "800 '+' trips as a character repeat");
  assert.strictEqual(trip.pattern, "+", "800 '+' pattern is '+'");

  // Regression guard: a true degeneracy char (a plain letter, NOT in the
  // code set) still trips at the strict default limit of 35.
  d = new RepetitionDetector();
  const letter = d.feed("a".repeat(40));
  assert.ok(letter, "40 consecutive 'a' must still trip (default limit 35)");
  assert.strictEqual(letter.type, "character");

  // Whitespace/divider (e.g. '-') keeps the 120 limit: 119 passes, 120 trips.
  d = new RepetitionDetector();
  assert.strictEqual(d.feed("-".repeat(119)), null, "119 '-' must pass (divider limit 120)");
  d = new RepetitionDetector();
  assert.ok(d.feed("-".repeat(120)), "120 '-' must trip (divider limit 120)");

  console.log("[PASS] Repetition tiering: 120/400 '+' pass, 800 '+' trips, 'a' trips at 35, '-' trips at 120.");
}

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

// ---------------------------------------------------------------------------
// P7b: real-proxy wiring regression. Spawns stream_proxy.js (env-tunable
// ports) against a mock upstream that streams a literal loop as
// delta.reasoning and asserts the circuit breaker cuts it.
// ---------------------------------------------------------------------------
async function testRealProxyReasoningBreaker() {
  const UNIT = "I must check the file. "; // 23 chars, letters -> block-detector territory
  const REPEATS = 60;                     // ~1380 chars >> the 18x23=414 needed to trip

  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write('data: {"choices":[{"delta":{"reasoning":"Start. "},"finish_reason":null}]}\n\n');
    let i = 0;
    const timer = setInterval(() => {
      if (req.destroyed) { clearInterval(timer); try { res.end(); } catch {} return; }
      if (i >= REPEATS) {
        clearInterval(timer);
        res.write('data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n');
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning: UNIT }, finish_reason: null }] })}\n\n`);
      i++;
    }, 5);
    req.on("close", () => clearInterval(timer));
  });
  await new Promise((r) => upstream.listen(REAL_UPSTREAM_PORT, "127.0.0.1", r));

  const proxyChild = spawn(
    process.execPath,
    [path.join(__dirname, "..", "stream_proxy.js")],
    {
      env: {
        ...process.env,
        VLLM_PORT: String(REAL_UPSTREAM_PORT),
        VLLM_PROXY_PORT: String(REAL_PROXY_PORT),
      },
      stdio: ["ignore", "ignore", "pipe"],
    }
  );
  let proxyStderr = "";
  proxyChild.stderr.on("data", (c) => (proxyStderr += c.toString("utf8")));

  try {
    // Wait for the real proxy to accept connections (bounded).
    let up = false;
    for (let attempt = 0; attempt < 50 && !up; attempt++) {
      up = await new Promise((resolve) => {
        const probe = http.get(`http://127.0.0.1:${REAL_PROXY_PORT}/v1/models`, (res) => {
          res.resume();
          resolve(res.statusCode > 0);
        });
        probe.on("error", () => resolve(false));
        probe.setTimeout(300, () => { probe.destroy(); resolve(false); });
      });
      if (!up) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(up, "real stream_proxy.js child came up on the test port");

    const output = await new Promise((resolve, reject) => {
      let buf = "";
      const req = http.request(
        `http://127.0.0.1:${REAL_PROXY_PORT}/v1/chat/completions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        },
        (res) => {
          res.on("data", (c) => (buf += c.toString("utf8")));
          res.on("end", () => resolve(buf));
          res.on("error", reject);
        }
      );
      req.on("error", reject);
      req.end(
        JSON.stringify({
          model: "qwen3.8-27b",
          stream: true,
          messages: [{ role: "user", content: "q" }],
        })
      );
      // Hard bound: a non-tripping proxy still finishes (upstream ends at 60
      // units), so this resolves either way; the asserts below discriminate.
    });

    assert.ok(
      output.includes("chatcmpl-repetition-breaker"),
      `real proxy trips the breaker on a delta.reasoning loop. stderr: ${proxyStderr}`
    );
    assert.ok(output.includes("[StreamProxy Guard:"), "guard marker present in stream");
    assert.ok(output.includes("data: [DONE]"), "broken stream still closes cleanly with [DONE]");
    const unitCount = output.split(UNIT).length - 1;
    assert.ok(
      unitCount < REPEATS,
      `loop truncated before upstream completion (${unitCount}/${REPEATS} units passed through)`
    );
    console.log(
      `[PASS] Real-proxy delta.reasoning wiring: loop cut at ${unitCount}/${REPEATS} units, breaker chunk + [DONE] delivered.`
    );
  } finally {
    proxyChild.kill();
    await new Promise((r) => upstream.close(r));
  }
}

async function testSuite() {
  console.log("=== Testing Stream Proxy with Multi-Byte Splitting & Mid-Stream Error Translation ===");

  // Repetition-detector tiering (offline, no server needed).
  testRepetitionTiering();

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

  // Test 3 (P7b): the REAL stream_proxy.js must feed delta.reasoning into its
  // repetition detector. Ground truth (P7b forensics): the proxy read only
  // delta.reasoning_content while this engine emits delta.reasoning
  // (--reasoning-parser qwen3), leaving reasoning-level loops invisible — a
  // loop then burned a single ~18-minute generation to the full max_tokens
  // ceiling. A mock upstream streams a literal reasoning loop through the
  // real proxy; the breaker chunk must arrive and the loop must be truncated.
  await testRealProxyReasoningBreaker();

  console.log("=== ALL TESTS PASSED ===");
}

testSuite().catch(e => {
  console.error(e);
  process.exit(1);
});
