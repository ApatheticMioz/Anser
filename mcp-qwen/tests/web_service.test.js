/**
 * M3 — Anser Web & Research Service Test Suite
 *
 * Verifies:
 * 1. web_fetch extracts clean Markdown from HTML articles using Mozilla Readability + Turndown.
 * 2. web_fetch strips noise elements (<script>, <style>, <nav>, ads, iframes).
 * 3. web_fetch gracefully falls back to full body Markdown for non-article pages.
 * 4. web_fetch handles direct JSON and plaintext responses with proper markdown framing.
 * 5. web_fetch fail-fast invariant: rejects invalid URL schemes and throws HttpError on HTTP 4xx/5xx.
 * 6. web_fetch truncates responses exceeding max_chars.
 * 7. web_search validates input queries and returns structured results.
 * 8. webPlugin mounts cleanly into Anser Context and registers tools.
 */

import http from "node:http";
import assert from "node:assert/strict";
import { Context } from "../src/harness/core/kernel.js";
import { WebService, webPlugin } from "../src/harness/services/web_service.js";

let passed = 0;
let failed = 0;

function ok(cond, name) {
  if (cond) {
    console.log(`  [PASS] ${name}`);
    passed++;
  } else {
    console.error(`  [FAIL] ${name}`);
    failed++;
  }
}

async function run() {
  console.log("=== M3 Anser Web & Research Service Tests ===\n");

  // -------------------------------------------------------------------------
  // Setup Local Mock HTTP Server for deterministic offline testing
  // -------------------------------------------------------------------------
  let serverPort = 0;
  const mockServer = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${serverPort}`);

    if (url.pathname === "/article") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`
        <!DOCTYPE html>
        <html>
          <head>
            <title>Deep Learning Architecture Advances</title>
          </head>
          <body>
            <header><nav><a href="/">Home</a> | <a href="/about">About</a></nav></header>
            <div class="ad-banner">Annoying Banner Ad</div>
            <article>
              <h1>Deep Learning Architecture Advances</h1>
              <p class="byline">By Dr. Alan Turing</p>
              <p>Modern transformer models rely heavily on <b>RadixAttention</b> and <i>prefix caching</i> to maximize inference throughput.</p>
              <p>For more details, see <a href="https://example.com/paper">the reference paper</a>.</p>
              <pre><code>def attention(q, k, v):\n    return softmax(q @ k.T) @ v</code></pre>
            </article>
            <aside class="sidebar">Related links and advertisements</aside>
            <footer>Copyright 2026 AI Journal</footer>
            <script>console.log("tracking script");</script>
          </body>
        </html>
      `);
      return;
    }

    if (url.pathname === "/portal") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`
        <!DOCTYPE html>
        <html>
          <head><title>System Documentation Portal</title></head>
          <body>
            <h2>Welcome to System Docs</h2>
            <ul>
              <li><a href="/guide1">Getting Started Guide</a></li>
              <li><a href="/api">API Reference Manual</a></li>
            </ul>
          </body>
        </html>
      `);
      return;
    }

    if (url.pathname === "/api/status.json") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "healthy", vram_gb: 24, latency_ms: 12 }, null, 2));
      return;
    }

    if (url.pathname === "/notes.txt") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("Raw research notes\nLine 1: Speculative decoding active\nLine 2: Prefix cache hit rate 94%");
      return;
    }

    if (url.pathname === "/large") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("A".repeat(1000));
      return;
    }

    if (url.pathname === "/error-500") {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal Server Error");
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  });

  await new Promise((resolve) => {
    mockServer.listen(0, "127.0.0.1", () => {
      serverPort = mockServer.address().port;
      resolve();
    });
  });

  const baseUrl = `http://127.0.0.1:${serverPort}`;
  const web = new WebService();

  try {
    // -------------------------------------------------------------------------
    // Test 1: Mozilla Readability + Turndown Article Extraction
    // -------------------------------------------------------------------------
    console.log("[Test 1] Mozilla Readability + Turndown Article Extraction");
    {
      const res = await web.fetch({ url: `${baseUrl}/article`, extract_article: true });
      ok(res.content_type === "article", "Identified content_type as 'article'");
      ok(res.title.includes("Deep Learning Architecture Advances"), `Extracted title: ${res.title}`);
      ok(res.markdown.includes("RadixAttention"), "Markdown includes article body paragraph");
      ok(res.markdown.includes("[the reference paper](https://example.com/paper)"), "Markdown formatted hyperlinks");
      ok(res.markdown.includes("def attention(q, k, v)"), "Markdown formatted code block");
      ok(!res.markdown.includes("Annoying Banner Ad"), "Stripped banner ads");
      ok(!res.markdown.includes("tracking script"), "Stripped <script> tags");
      ok(!res.markdown.includes("Copyright 2026 AI Journal"), "Stripped footer clutter");
    }

    // -------------------------------------------------------------------------
    // Test 2: Fallback for Non-Article Pages
    // -------------------------------------------------------------------------
    console.log("\n[Test 2] Non-Article Page Markdown Conversion");
    {
      const res = await web.fetch({ url: `${baseUrl}/portal`, extract_article: true });
      ok(res.content_type === "page" || res.content_type === "article", "Handled portal page without error");
      ok(res.title.includes("System Documentation Portal"), "Captured page title");
      ok(res.markdown.includes("Welcome to System Docs"), "Markdown contains page heading");
      ok(res.markdown.includes("[Getting Started Guide]"), "Markdown converted list of links");
    }

    // -------------------------------------------------------------------------
    // Test 3: JSON Endpoint Direct Extraction
    // -------------------------------------------------------------------------
    console.log("\n[Test 3] JSON Endpoint Handling");
    {
      const res = await web.fetch({ url: `${baseUrl}/api/status.json` });
      ok(res.content_type === "application/json", "Identified application/json");
      ok(res.markdown.startsWith("```json"), "Wrapped in fenced json code block");
      ok(res.markdown.includes('"vram_gb": 24'), "Contains valid JSON payload");
    }

    // -------------------------------------------------------------------------
    // Test 4: Plaintext Endpoint Handling
    // -------------------------------------------------------------------------
    console.log("\n[Test 4] Plaintext Endpoint Handling");
    {
      const res = await web.fetch({ url: `${baseUrl}/notes.txt` });
      ok(res.content_type === "text/plain", "Identified text/plain");
      ok(res.markdown.includes("Speculative decoding active"), "Contains raw text lines");
    }

    // -------------------------------------------------------------------------
    // Test 5: Length Truncation
    // -------------------------------------------------------------------------
    console.log("\n[Test 5] Content Length Truncation");
    {
      const res = await web.fetch({ url: `${baseUrl}/large`, max_chars: 100 });
      ok(res.markdown.length < 200, "Truncated markdown to bounded size");
      ok(res.markdown.includes("...[truncated]"), "Appended truncation indicator");
    }

    // -------------------------------------------------------------------------
    // Test 6: Fail-Fast Error Invariants (§2.8)
    // -------------------------------------------------------------------------
    console.log("\n[Test 6] Fail-Fast Error Invariants");
    {
      // Invalid URL scheme
      let threw = false;
      try {
        await web.fetch({ url: "ftp://example.com/file" });
      } catch (err) {
        threw = true;
        ok(/InvalidUrlError/.test(err.message), "Rejected non-http scheme with InvalidUrlError");
      }
      ok(threw, "Threw error on invalid URL scheme");

      // HTTP 404
      threw = false;
      try {
        await web.fetch({ url: `${baseUrl}/nonexistent-page` });
      } catch (err) {
        threw = true;
        ok(/HttpError: GET .* 404/.test(err.message), "Surface 404 error via HttpError");
      }
      ok(threw, "Threw HttpError on HTTP 404");

      // HTTP 500
      threw = false;
      try {
        await web.fetch({ url: `${baseUrl}/error-500` });
      } catch (err) {
        threw = true;
        ok(/HttpError: GET .* 500/.test(err.message), "Surface 500 error via HttpError");
      }
      ok(threw, "Threw HttpError on HTTP 500");
    }

    // -------------------------------------------------------------------------
    // Test 7: Web Search Query Validation
    // -------------------------------------------------------------------------
    console.log("\n[Test 7] Web Search Query Validation");
    {
      let threw = false;
      try {
        await web.search({ query: "" });
      } catch (err) {
        threw = true;
        ok(/InvalidQueryError/.test(err.message), "Empty query throws InvalidQueryError");
      }
      ok(threw, "Threw error on empty search query");
    }

    // -------------------------------------------------------------------------
    // Test 8: Anser Context Plugin Mounting & Tool Registration
    // -------------------------------------------------------------------------
    console.log("\n[Test 8] Context Plugin Mounting & Tool Registration");
    {
      const ctx = new Context(null, "web_test_session");
      ctx.plugin(webPlugin);

      const registeredWeb = ctx.get("web");
      ok(registeredWeb instanceof WebService, "Context provides WebService instance");

      const tools = ctx.listTools();
      const toolNames = tools.map((t) => t.function.name);
      ok(toolNames.includes("web_search"), "Registered 'web_search' tool");
      ok(toolNames.includes("web_fetch"), "Registered 'web_fetch' tool");

      const searchTool = tools.find((t) => t.function.name === "web_search");
      ok(searchTool.function.parameters.required.includes("query"), "web_search requires 'query'");

      const fetchTool = tools.find((t) => t.function.name === "web_fetch");
      ok(fetchTool.function.parameters.required.includes("url"), "web_fetch requires 'url'");
    }

    // -------------------------------------------------------------------------
    // Test 9: Live Search Integration (when network reachable)
    // -------------------------------------------------------------------------
    console.log("\n[Test 9] Web Search Engine Check");
    {
      try {
        const searchRes = await web.search({ query: "Node.js", max_results: 3 });
        ok(typeof searchRes.count === "number", "Returned numeric count");
        ok(Array.isArray(searchRes.results), "Returned results array");
        if (searchRes.results.length > 0) {
          const first = searchRes.results[0];
          ok(first.title && first.url, `Live search result: '${first.title}' -> ${first.url}`);
        } else {
          console.log("  [INFO] DuckDuckGo returned 0 results or rate limited (graceful pass)");
        }
      } catch (err) {
        console.log(`  [INFO] Search network probe skipped (${err.message}) - offline pass`);
      }
    }
  } finally {
    mockServer.close();
  }

  console.log("\n==========================================");
  console.log(`Web Service Tests: ${passed} PASSED, ${failed} FAILED`);
  console.log("==========================================");

  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error("Unhandled error in test runner:", err);
  process.exit(1);
});
