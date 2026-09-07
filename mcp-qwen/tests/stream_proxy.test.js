import http from "node:http";
import assert from "node:assert";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, describe } from "node:test";
import { RepetitionDetector } from "../src/repetition_detector.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("Stream Proxy - Signal Preserving & Error Forwarding Suite", () => {
  test("Repetition tiering limits", () => {
    let d = new RepetitionDetector();
    assert.strictEqual(d.feed("+".repeat(120)), null, "120 '+' must pass (code char limit 500)");

    d = new RepetitionDetector();
    assert.strictEqual(d.feed("+".repeat(400)), null, "400 '+' must pass (code char limit 500)");

    d = new RepetitionDetector();
    const trip = d.feed("+".repeat(800));
    assert.ok(trip, "800 '+' must trip the breaker");
    assert.strictEqual(trip.type, "character");
    assert.strictEqual(trip.pattern, "+");

    d = new RepetitionDetector();
    const letter = d.feed("a".repeat(40));
    assert.ok(letter, "40 consecutive 'a' must trip default limit 35");

    d = new RepetitionDetector();
    assert.strictEqual(d.feed("-".repeat(119)), null, "119 '-' must pass divider limit 120");
    d = new RepetitionDetector();
    assert.ok(d.feed("-".repeat(120)), "120 '-' must trip divider limit 120");
  });

  test("Real stream_proxy forwards upstream HTTP 400 Bad Request transparently", async () => {
    const mockUpstream = http.createServer((req, res) => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        error: {
          message: "This model's maximum context length is 245760 tokens.",
          type: "invalid_request_error",
          code: 400,
        },
      }));
    });

    await new Promise((r) => mockUpstream.listen(0, "127.0.0.1", r));
    const upstreamPort = mockUpstream.address().port;

    // Ephemeral port for proxy
    const proxySrv = http.createServer();
    await new Promise((r) => proxySrv.listen(0, "127.0.0.1", r));
    const proxyPort = proxySrv.address().port;
    await new Promise((r) => proxySrv.close(r));

    const proxyChild = spawn(
      process.execPath,
      [path.join(__dirname, "..", "stream_proxy.js")],
      {
        env: {
          ...process.env,
          VLLM_PORT: String(upstreamPort),
          VLLM_PROXY_PORT: String(proxyPort),
        },
        stdio: ["ignore", "ignore", "pipe"],
      }
    );

    try {
      // Wait for proxy to bind
      let up = false;
      for (let attempt = 0; attempt < 50 && !up; attempt++) {
        up = await new Promise((resolve) => {
          const probe = http.get(`http://127.0.0.1:${proxyPort}/v1/models`, (res) => {
            res.resume();
            resolve(res.statusCode > 0);
          });
          probe.on("error", () => resolve(false));
          probe.setTimeout(300, () => { probe.destroy(); resolve(false); });
        });
        if (!up) await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(up, "stream_proxy child process listening");

      const response = await new Promise((resolve, reject) => {
        const req = http.request(
          `http://127.0.0.1:${proxyPort}/v1/chat/completions`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
          },
          (res) => {
            let body = "";
            res.on("data", (c) => (body += c.toString("utf8")));
            res.on("end", () => resolve({ statusCode: res.statusCode, headers: res.headers, body }));
            res.on("error", reject);
          }
        );
        req.on("error", reject);
        req.end(JSON.stringify({ model: "qwen3.8-27b", stream: true, messages: [] }));
      });

      // Assert that HTTP 400 is faithfully preserved and NO fake 200/safeChunk was emitted
      assert.strictEqual(response.statusCode, 400, "Must return HTTP 400, not HTTP 200");
      assert.ok(!response.body.includes("chatcmpl-stream-err"), "Must NOT synthesize chatcmpl-stream-err");
      assert.ok(!response.body.includes("finish_reason"), "Must NOT fake a finish_reason");
      assert.ok(response.body.includes("maximum context length is 245760 tokens"), "Raw upstream error message preserved");
    } finally {
      proxyChild.kill();
      await new Promise((r) => mockUpstream.close(r));
    }
  });

  test("Real stream_proxy converts mid-stream vLLM error to event: error and destroys stream", async () => {
    const mockUpstream = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      res.write('data: {"choices":[{"delta":{"content":"Starting work..."}}]}\n\n');
      setTimeout(() => {
        // Mid-stream error packet from vLLM
        res.write('data: {"error":{"message":"Engine allocation failure: KV cache full","type":"server_error"}}\n\n');
        res.end();
      }, 50);
    });

    await new Promise((r) => mockUpstream.listen(0, "127.0.0.1", r));
    const upstreamPort = mockUpstream.address().port;

    const proxySrv = http.createServer();
    await new Promise((r) => proxySrv.listen(0, "127.0.0.1", r));
    const proxyPort = proxySrv.address().port;
    await new Promise((r) => proxySrv.close(r));

    const proxyChild = spawn(
      process.execPath,
      [path.join(__dirname, "..", "stream_proxy.js")],
      {
        env: {
          ...process.env,
          VLLM_PORT: String(upstreamPort),
          VLLM_PROXY_PORT: String(proxyPort),
        },
        stdio: ["ignore", "ignore", "pipe"],
      }
    );

    try {
      let up = false;
      for (let attempt = 0; attempt < 50 && !up; attempt++) {
        up = await new Promise((resolve) => {
          const probe = http.get(`http://127.0.0.1:${proxyPort}/v1/models`, (res) => {
            res.resume();
            resolve(res.statusCode > 0);
          });
          probe.on("error", () => resolve(false));
          probe.setTimeout(300, () => { probe.destroy(); resolve(false); });
        });
        if (!up) await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(up, "stream_proxy child process listening");

      const streamOutput = await new Promise((resolve) => {
        let body = "";
        const req = http.request(
          `http://127.0.0.1:${proxyPort}/v1/chat/completions`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
          },
          (res) => {
            res.on("data", (c) => (body += c.toString("utf8")));
            res.on("end", () => resolve(body));
            res.on("close", () => resolve(body));
          }
        );
        req.on("error", () => resolve(body));
        req.end(JSON.stringify({ model: "qwen3.8-27b", stream: true, messages: [] }));
      });

      assert.ok(streamOutput.includes("event: error"), "Emits event: error on mid-stream failure");
      assert.ok(streamOutput.includes("Engine allocation failure"), "Error message included in SSE error payload");
      assert.ok(!streamOutput.includes("chatcmpl-stream-err"), "Must NOT synthesize chatcmpl-stream-err");
      assert.ok(!streamOutput.includes("data: [DONE]"), "Must NOT emit data: [DONE] on mid-stream failure");
    } finally {
      proxyChild.kill();
      await new Promise((r) => mockUpstream.close(r));
    }
  });

  test("Real stream_proxy terminates repetition loops via circuit breaker", async () => {
    const UNIT = "I must verify the code. ";
    const REPEATS = 50;

    const mockUpstream = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"reasoning":"Start."},"finish_reason":null}]}\n\n');
      let i = 0;
      const timer = setInterval(() => {
        if (req.destroyed) { clearInterval(timer); try { res.end(); } catch {} return; }
        if (i >= REPEATS) {
          clearInterval(timer);
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning: UNIT }, finish_reason: null }] })}\n\n`);
        i++;
      }, 5);
      req.on("close", () => clearInterval(timer));
    });

    await new Promise((r) => mockUpstream.listen(0, "127.0.0.1", r));
    const upstreamPort = mockUpstream.address().port;

    const proxySrv = http.createServer();
    await new Promise((r) => proxySrv.listen(0, "127.0.0.1", r));
    const proxyPort = proxySrv.address().port;
    await new Promise((r) => proxySrv.close(r));

    const proxyChild = spawn(
      process.execPath,
      [path.join(__dirname, "..", "stream_proxy.js")],
      {
        env: {
          ...process.env,
          VLLM_PORT: String(upstreamPort),
          VLLM_PROXY_PORT: String(proxyPort),
        },
        stdio: ["ignore", "ignore", "pipe"],
      }
    );

    try {
      let up = false;
      for (let attempt = 0; attempt < 50 && !up; attempt++) {
        up = await new Promise((resolve) => {
          const probe = http.get(`http://127.0.0.1:${proxyPort}/v1/models`, (res) => {
            res.resume();
            resolve(res.statusCode > 0);
          });
          probe.on("error", () => resolve(false));
          probe.setTimeout(300, () => { probe.destroy(); resolve(false); });
        });
        if (!up) await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(up, "stream_proxy child process listening");

      const output = await new Promise((resolve, reject) => {
        let buf = "";
        const req = http.request(
          `http://127.0.0.1:${proxyPort}/v1/chat/completions`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
          },
          (res) => {
            res.on("data", (c) => (buf += c.toString("utf8")));
            res.on("end", () => resolve(buf));
            res.on("close", () => resolve(buf));
            res.on("error", reject);
          }
        );
        req.on("error", reject);
        req.end(JSON.stringify({ model: "qwen3.8-27b", stream: true, messages: [] }));
      });

      assert.ok(output.includes("chatcmpl-repetition-breaker"), "Circuit breaker tripped");
      assert.ok(output.includes("data: [DONE]"), "Clean termination after circuit breaker");
    } finally {
      proxyChild.kill();
      await new Promise((r) => mockUpstream.close(r));
    }
  });
});
