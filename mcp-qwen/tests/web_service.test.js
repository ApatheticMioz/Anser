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
 * 9. C1: all providers failed → isError (not empty success).
 * 10. Brave snippet sanitization: HTML tag stripping and entity decoding.
 * 11. Doc query provider ordering in auto chain (context7/tavily before brave).
 * 12. GitHub API token header attachment for api.github.com requests.
 * 13. Live search integration probe.
 * 14. Tracking-parameter URL sanitization and normalized-URL deduplication.
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

    if (url.pathname === "/fence") {
      // Fence at the very start so a short window cuts inside the open fence.
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("```\n" + "x".repeat(200) + "\n");
      return;
    }

    if (url.pathname === "/paragraphs") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("First paragraph with some content here.\n\nSecond paragraph with more content here.\n\nThird paragraph.");
      return;
    }

    if (url.pathname === "/huge") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("B".repeat(100000));
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
      ok(res.markdown.includes("[Content truncated: showing 100 of 1000 chars]"), "Appended boundary-aware truncation marker");
    }

    // -------------------------------------------------------------------------
    // Test 5b: Boundary-aware truncation stops at a paragraph/line break
    // -------------------------------------------------------------------------
    console.log("\n[Test 5b] Boundary-aware truncation (paragraph/line break)");
    {
      // /paragraphs is three \n\n-separated paragraphs (99 chars). A 60-char
      // window would cut mid-word in the second paragraph; the helper must
      // back off to the \n\n boundary after the first paragraph instead.
      const res = await web.fetch({ url: `${baseUrl}/paragraphs`, max_chars: 60 });
      ok(res.markdown.includes("[Content truncated:"), "Marker present");
      const beforeMarker = res.markdown.slice(0, res.markdown.lastIndexOf("[Content truncated:")).trimEnd();
      // Backed off to a boundary: shorter than the 60-char hard cap.
      ok(beforeMarker.length < 60, `Backed off to a boundary (${beforeMarker.length} < 60)`);
      // Cut at the paragraph boundary: exactly the first complete paragraph.
      ok(beforeMarker === "First paragraph with some content here.", `Lands on paragraph boundary: ${JSON.stringify(beforeMarker)}`);
      // Never mid-word: last char is a word terminator, not a space.
      ok(!/\s$/.test(beforeMarker), "Does not end mid-word (no trailing space)");
    }

    // -------------------------------------------------------------------------
    // Test 5c: Unclosed markdown code fence is closed cleanly on truncation
    // -------------------------------------------------------------------------
    console.log("\n[Test 5c] Unclosed code fence closed on truncation");
    {
      // Build a body whose markdown contains an OPEN code fence that the
      // truncation window cuts inside.
      const openFence = "Intro line.\n\n```\n" + "x".repeat(200) + "\n";
      const res = await web.fetch({ url: `${baseUrl}/fence`, max_chars: 40 });
      ok(res.markdown.includes("[Content truncated:"), "Marker present");
      // The fence opened in the window must be closed before the marker.
      const fences = (res.markdown.match(/^```/gm) || []).length;
      ok(fences % 2 === 0, `Code fence count is even (closed): ${fences}`);
      ok(res.markdown.includes("```"), "Closing fence present");
    }

    // -------------------------------------------------------------------------
    // Test 5d: 60,000 default character cap (schema/config alignment)
    // -------------------------------------------------------------------------
    console.log("\n[Test 5d] 60,000 default character cap");
    {
      // /large is 1000 chars — below the default cap, so no truncation.
      const small = await web.fetch({ url: `${baseUrl}/large` });
      ok(!small.markdown.includes("[Content truncated:"), "1000-char body not truncated at 60k default");

      // A body larger than 60,000 chars must be truncated at the default cap
      // (no max_chars passed).
      const big = await web.fetch({ url: `${baseUrl}/huge` });
      ok(big.markdown.includes("[Content truncated:"), "60k+ body truncated at default cap");
      ok(big.markdown.includes("of 100000 chars"), `Marker reports full length: ${JSON.stringify(big.markdown.slice(-60))}`);
      ok(big.markdown.length < 60_000 + 200, "Truncated output stays near the 60k cap");
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
    // Test 9: C1 — all providers failed → isError, NOT empty success
    // -------------------------------------------------------------------------
    console.log("\n[Test 9] C1: all providers failed → isError (not empty success)");
    {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => {
        throw new Error("ENETUNREACH: network unreachable");
      };
      try {
        const res = await web.search({ query: "test query", provider: "auto" });
        // Must NOT be a silent empty success
        ok(res.isError === true, "C1: res.isError === true when all providers failed");
        ok(typeof res.text === "string" && res.text.includes("SearchError"), "C1: res.text contains SearchError");
        ok(res.count === undefined, "C1: no fabricated count field");
        ok(res.results === undefined, "C1: no fabricated results field");
      } finally {
        globalThis.fetch = originalFetch;
      }
    }

    // -------------------------------------------------------------------------
    // Test 10: Brave snippet sanitization (HTML tag stripping + entity decoding)
    // -------------------------------------------------------------------------
    console.log("\n[Test 10] Brave Snippet Sanitization");
    {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (url, opts) => {
        // Simulate Brave API response with HTML entities and tags
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({
            web: {
              results: [
                {
                  title: "React &amp; Vue: A <b>Comparison</b> Guide",
                  url: "https://example.com/react-vs-vue",
                  description: "Learn how &#x27;React&#x27; and &quot;Vue&quot; differ in <span>rendering</span> &amp; performance.",
                },
              ],
            },
          }),
        };
      };
      try {
        const results = await web._searchBrave("react vs vue", 5, "fake-key");
        const r = results[0];
        ok(!r.title.includes("<b>"), "Brave title: HTML tags stripped");
        ok(r.title.includes("&"), "Brave title: &amp; decoded to &");
        ok(!r.snippet.includes("<span>"), "Brave snippet: HTML tags stripped");
        ok(r.snippet.includes("'React'"), "Brave snippet: &#x27; decoded to '");
        ok(r.snippet.includes('"Vue"'), "Brave snippet: &quot; decoded to \"");
        ok(r.snippet.includes("&"), "Brave snippet: &amp; decoded to &");
      } finally {
        globalThis.fetch = originalFetch;
      }
    }

    // -------------------------------------------------------------------------
    // Test 11: Doc query provider ordering in auto chain
    // -------------------------------------------------------------------------
    console.log("\n[Test 11] Doc Query Provider Ordering");
    {
      const originalFetch = globalThis.fetch;
      const originalEnv = {
        BRAVE_API_KEY: process.env.BRAVE_API_KEY,
        TAVILY_API_KEY: process.env.TAVILY_API_KEY,
        CONTEXT7_API_KEY: process.env.CONTEXT7_API_KEY,
        SEARXNG_URL: process.env.SEARXNG_URL,
      };
      process.env.BRAVE_API_KEY = "brave-key";
      process.env.TAVILY_API_KEY = "tavily-key";
      process.env.CONTEXT7_API_KEY = "context7-key";
      delete process.env.SEARXNG_URL;

      const callOrder = [];
      globalThis.fetch = async (url, opts) => {
        const u = typeof url === "string" ? url : url.toString();
        if (u.includes("context7.com")) callOrder.push("context7");
        else if (u.includes("api.tavily.com")) callOrder.push("tavily");
        else if (u.includes("api.search.brave.com")) callOrder.push("brave");
        else if (u.includes("duckduckgo")) callOrder.push("duckduckgo");
        // Return empty results so chain continues to next provider
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({ results: [], web: { results: [] } }),
        };
      };
      try {
        // Doc query: "API reference for React hooks"
        await web.search({ query: "API reference for React hooks", provider: "auto" });
        ok(
          callOrder[0] === "context7",
          `Doc query: context7 is first (got: ${callOrder[0]})`
        );
        ok(
          callOrder.indexOf("context7") < callOrder.indexOf("brave"),
          "Doc query: context7 before brave"
        );
        ok(
          callOrder.indexOf("tavily") < callOrder.indexOf("brave"),
          "Doc query: tavily before brave"
        );

        // General query: "best pizza in nyc"
        callOrder.length = 0;
        await web.search({ query: "best pizza in nyc", provider: "auto" });
        ok(
          callOrder[0] === "tavily",
          `General query: tavily is first (got: ${callOrder[0]})`
        );
        ok(
          callOrder.indexOf("tavily") < callOrder.indexOf("brave"),
          "General query: tavily before brave"
        );
      } finally {
        globalThis.fetch = originalFetch;
        if (originalEnv.BRAVE_API_KEY !== undefined) process.env.BRAVE_API_KEY = originalEnv.BRAVE_API_KEY;
        else delete process.env.BRAVE_API_KEY;
        if (originalEnv.TAVILY_API_KEY !== undefined) process.env.TAVILY_API_KEY = originalEnv.TAVILY_API_KEY;
        else delete process.env.TAVILY_API_KEY;
        if (originalEnv.CONTEXT7_API_KEY !== undefined) process.env.CONTEXT7_API_KEY = originalEnv.CONTEXT7_API_KEY;
        else delete process.env.CONTEXT7_API_KEY;
        if (originalEnv.SEARXNG_URL !== undefined) process.env.SEARXNG_URL = originalEnv.SEARXNG_URL;
        else delete process.env.SEARXNG_URL;
      }
    }

    // -------------------------------------------------------------------------
    // Test 12: GitHub API token header attachment
    // -------------------------------------------------------------------------
    console.log("\n[Test 12] GitHub API Token Header");
    {
      const originalFetch = globalThis.fetch;
      const originalToken = process.env.GITHUB_TOKEN;
      process.env.GITHUB_TOKEN = "ghp_test_token_123";

      let capturedHeaders = null;
      globalThis.fetch = async (url, opts) => {
        capturedHeaders = opts.headers;
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          headers: { get: (h) => (h.toLowerCase() === "content-type" ? "application/json" : null) },
          arrayBuffer: async () => new TextEncoder().encode('{"name":"test-repo"}').buffer,
        };
      };
      try {
        await web.fetch({ url: "https://api.github.com/repos/octocat/Hello-World" });
        ok(
          capturedHeaders.Authorization === "Bearer ghp_test_token_123",
          "GitHub API: Authorization Bearer header attached"
        );
      } finally {
        globalThis.fetch = originalFetch;
        if (originalToken !== undefined) process.env.GITHUB_TOKEN = originalToken;
        else delete process.env.GITHUB_TOKEN;
      }

      // Verify no Authorization header for non-GitHub URLs
      capturedHeaders = null;
      globalThis.fetch = async (url, opts) => {
        capturedHeaders = opts.headers;
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          headers: { get: (h) => (h.toLowerCase() === "content-type" ? "text/plain" : null) },
          arrayBuffer: async () => new TextEncoder().encode("hello").buffer,
        };
      };
      try {
        await web.fetch({ url: "https://example.com/page" });
        ok(
          !capturedHeaders.Authorization,
          "Non-GitHub URL: no Authorization header"
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    }

    // -------------------------------------------------------------------------
    // Test 13: Live Search Integration (when network reachable)
    // -------------------------------------------------------------------------
    console.log("\n[Test 13] Web Search Engine Check");
    {
      try {
        const searchRes = await web.search({ query: "Node.js", max_results: 3 });
        if (searchRes.isError) {
          // All providers in the auto chain failed (e.g. no API keys / network
          // blocked in CI). search() returns { isError, text } with no
          // count/results, so skip the shape assertions and pass gracefully.
          console.log(`  [INFO] Search network probe skipped (${searchRes.text}) - offline pass`);
        } else {
          ok(typeof searchRes.count === "number", "Returned numeric count");
          ok(Array.isArray(searchRes.results), "Returned results array");
          if (searchRes.results.length > 0) {
            const first = searchRes.results[0];
            ok(first.title && first.url, `Live search result: '${first.title}' -> ${first.url}`);
          } else {
            console.log("  [INFO] DuckDuckGo returned 0 results or rate limited (graceful pass)");
          }
        }
      } catch (err) {
        console.log(`  [INFO] Search network probe skipped (${err.message}) - offline pass`);
      }
    }

    // -------------------------------------------------------------------------
    // Test 14: Tracking-Param URL Sanitization & Deduplication
    // -------------------------------------------------------------------------
    console.log("\n[Test 14] Tracking-Param URL Sanitization & Deduplication");
    {
      const originalFetch = globalThis.fetch;
      const originalEnv = {
        BRAVE_API_KEY: process.env.BRAVE_API_KEY,
        TAVILY_API_KEY: process.env.TAVILY_API_KEY,
        CONTEXT7_API_KEY: process.env.CONTEXT7_API_KEY,
        SEARXNG_URL: process.env.SEARXNG_URL,
      };
      process.env.BRAVE_API_KEY = "brave-key";
      delete process.env.TAVILY_API_KEY;
      delete process.env.CONTEXT7_API_KEY;
      delete process.env.SEARXNG_URL;

      globalThis.fetch = async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          web: {
            results: [
              {
                title: "A",
                url: "https://example.com/page?utm_source=mail&utm_medium=campaign&gclid=abc&ref=partner",
                description: "snippet a",
              },
              {
                title: "B",
                url: "https://example.com/page?fbclid=xyz&msclkid=123&mc_eid=456&source=feed",
                description: "snippet b",
              },
              {
                title: "C",
                url: "https://example.com/other?keep=1",
                description: "snippet c",
              },
            ],
          },
        }),
      });
      try {
        const res = await web.search({ query: "test dedup", provider: "brave" });
        ok(res.results.length === 2, `Dedup: 3 results with 2 duplicate URLs -> 2 (got ${res.results.length})`);
        ok(
          res.results[0].url === "https://example.com/page",
          `Tracking params stripped from first URL (got: ${res.results[0].url})`
        );
        ok(
          res.results[1].url === "https://example.com/other?keep=1",
          `Non-tracking params preserved (got: ${res.results[1].url})`
        );
        ok(res.count === 2, "count reflects deduplicated results");
      } finally {
        globalThis.fetch = originalFetch;
        if (originalEnv.BRAVE_API_KEY !== undefined) process.env.BRAVE_API_KEY = originalEnv.BRAVE_API_KEY;
        else delete process.env.BRAVE_API_KEY;
        if (originalEnv.TAVILY_API_KEY !== undefined) process.env.TAVILY_API_KEY = originalEnv.TAVILY_API_KEY;
        else delete process.env.TAVILY_API_KEY;
        if (originalEnv.CONTEXT7_API_KEY !== undefined) process.env.CONTEXT7_API_KEY = originalEnv.CONTEXT7_API_KEY;
        else delete process.env.CONTEXT7_API_KEY;
        if (originalEnv.SEARXNG_URL !== undefined) process.env.SEARXNG_URL = originalEnv.SEARXNG_URL;
        else delete process.env.SEARXNG_URL;
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
