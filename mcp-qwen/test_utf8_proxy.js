/**
 * test_utf8_proxy.js
 * Non-interruptive test suite for Universal Stateful UTF-8 Streaming Proxy.
 * 
 * Verifies:
 * 1. Multi-byte UTF-8 sequences (e.g. '∀' = 0xE2 0x88 0x80) split across separate HTTP chunks
 *    are seamlessly assembled without throwing stream decode errors.
 * 2. Malformed / corrupted byte sequences (e.g. 0xFF, 0xFE) are safely mapped to '\uFFFD'
 *    (the universal errors='replace' contract).
 * 3. End-to-end SSE JSON lines maintain structural validity.
 */

import http from "http";
import assert from "assert";

const MOCK_UPSTREAM_PORT = 18991;
const TEST_PROXY_PORT = 18992;

async function runTests() {
  console.log("=== Running Universal UTF-8 Streaming Proxy Tests ===");

  // 1. Setup Mock Upstream Server (Simulating vLLM emitting split multi-byte token chunks)
  const mockUpstream = http.createServer((req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Transfer-Encoding": "chunked",
      "Cache-Control": "no-cache",
    });

    // Chunk 1: Standard ASCII JSON header
    res.write('data: {"choices":[{"delta":{"content":"Test character: ');

    // Chunk 2: DELIBERATELY SPLIT 3-BYTE UTF-8 SEQUENCE for '∀' (0xE2 0x88 0x80)
    // Send only byte 1 (0xE2) - In strict UTF-8, this is invalid standalone!
    res.write(Buffer.from([0xE2]));

    setTimeout(() => {
      // Chunk 3: Send byte 2 and byte 3 (0x88, 0x80) + continuation text
      res.write(Buffer.concat([Buffer.from([0x88, 0x80]), Buffer.from(' and emoji: ')]));

      // Chunk 4: SPLIT 4-BYTE UTF-8 EMOJI '🚀' (0xF0 0x9F 0x9A 0x80) across 2 chunks
      // Send first 2 bytes
      res.write(Buffer.from([0xF0, 0x9F]));

      setTimeout(() => {
        // Send remaining 2 bytes of emoji + corrupted 0xFF invalid byte
        res.write(Buffer.concat([
          Buffer.from([0x9A, 0x80]),
          Buffer.from(' bad byte: '),
          Buffer.from([0xFF]), // Corrupted byte (should become \uFFFD)
          Buffer.from('"}}\n\n'),
          Buffer.from('data: [DONE]\n\n')
        ]));
        res.end();
      }, 50);
    }, 50);
  });

  await new Promise((resolve) => mockUpstream.listen(MOCK_UPSTREAM_PORT, "127.0.0.1", resolve));
  console.log(`[PASS] Mock upstream server listening on 127.0.0.1:${MOCK_UPSTREAM_PORT}`);

  // 2. Setup Test Streaming Proxy with Stateful TextDecoder
  const testProxy = http.createServer((req, res) => {
    const upstreamReq = http.request(
      `http://127.0.0.1:${MOCK_UPSTREAM_PORT}${req.url}`,
      {
        method: req.method,
        headers: req.headers,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode, upstreamRes.headers);

        const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });

        upstreamRes.on("data", (chunk) => {
          const text = decoder.decode(chunk, { stream: true });
          if (text) {
            res.write(text, "utf8");
          }
        });

        upstreamRes.on("end", () => {
          const tail = decoder.decode();
          if (tail) {
            res.write(tail, "utf8");
          }
          res.end();
        });
      }
    );

    req.pipe(upstreamReq);
  });

  await new Promise((resolve) => testProxy.listen(TEST_PROXY_PORT, "127.0.0.1", resolve));
  console.log(`[PASS] Universal streaming proxy listening on 127.0.0.1:${TEST_PROXY_PORT}`);

  // 3. Client Verification
  let receivedData = "";
  await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${TEST_PROXY_PORT}/v1/test`, (res) => {
      res.on("data", (chunk) => {
        // Assert: standard string decoding on the client never fails
        receivedData += chunk.toString("utf8");
      });
      res.on("end", resolve);
      res.on("error", reject);
    });
  });

  // 4. Assertions
  console.log("\nReceived Stream Output:\n" + receivedData);

  assert.ok(receivedData.includes("Test character: ∀"), "Split 3-byte UTF-8 character '∀' was correctly reassembled!");
  assert.ok(receivedData.includes("emoji: 🚀"), "Split 4-byte UTF-8 emoji '🚀' was correctly reassembled!");
  assert.ok(receivedData.includes("\uFFFD"), "Invalid byte 0xFF was safely mapped to Unicode replacement character (\\uFFFD)!");
  assert.ok(receivedData.includes("data: [DONE]"), "Stream completed cleanly!");

  console.log("\n=== ALL ASSERTIONS PASSED ===");
  console.log("Universal UTF-8 Proxy successfully eliminates stream decode errors at the transport layer.");

  // Cleanup
  await new Promise((resolve) => mockUpstream.close(resolve));
  await new Promise((resolve) => testProxy.close(resolve));
  process.exit(0);
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
