/**
 * Anser Web & Research Service
 *
 * Provides:
 * - Live web search via DuckDuckGo without API keys (web_search)
 * - Autonomous webpage fetching & extraction via Mozilla Readability + Turndown (web_fetch)
 * - Safe handling of JSON, plaintext, HTML articles, and general webpages
 * - Native in-process V8 execution with zero external subprocess/stdio overhead
 */

import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";
import { search, SafeSearchType } from "duck-duck-scrape";
import { getSearchConfig } from "../../config.js";

export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Anser/2026.1";

export const DEFAULT_MAX_FETCH_CHARS = 24_000;
export const MAX_FETCH_CHARS = (() => {
  const parsed = parseInt(process.env.QWEN_MAX_FETCH_CHARS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_FETCH_CHARS;
})();
export const DEFAULT_FETCH_TIMEOUT_MS = 20_000;
export const DEFAULT_SEARCH_TIMEOUT_MS = 15_000;

const NOISE_JSON_KEYS = new Set([
  "avatar_url",
  "gravatar_id",
  "node_id",
  "followers_url",
  "following_url",
  "gists_url",
  "starred_url",
  "subscriptions_url",
  "organizations_url",
  "repos_url",
  "events_url",
  "received_events_url",
  "site_admin",
  "user_view_type",
  "reactions",
]);

export function pruneJsonPayload(val, depth = 0) {
  if (depth > 8) return val;
  if (Array.isArray(val)) {
    const maxItems = 30;
    const pruned = val.slice(0, maxItems).map((item) => pruneJsonPayload(item, depth + 1));
    if (val.length > maxItems) {
      pruned.push({ _notice: `...[${val.length - maxItems} additional items omitted for context efficiency]...` });
    }
    return pruned;
  }
  if (val && typeof val === "object") {
    const res = {};
    for (const [k, v] of Object.entries(val)) {
      if (NOISE_JSON_KEYS.has(k)) continue;
      res[k] = pruneJsonPayload(v, depth + 1);
    }
    return res;
  }
  return val;
}

// Leaky-bucket serialization queue for DuckDuckGo unauthenticated requests
let lastDdgRequestTime = 0;
const DDG_MIN_INTERVAL_MS = 1500;
let ddgQueue = Promise.resolve();

async function throttleDdgRequest() {
  const current = ddgQueue;
  let resolveNext;
  ddgQueue = new Promise((resolve) => {
    resolveNext = resolve;
  });
  await current;
  try {
    const now = Date.now();
    const elapsed = now - lastDdgRequestTime;
    if (elapsed < DDG_MIN_INTERVAL_MS) {
      await new Promise((r) => setTimeout(r, DDG_MIN_INTERVAL_MS - elapsed));
    }
    lastDdgRequestTime = Date.now();
  } finally {
    resolveNext();
  }
}

function isDocQuery(q) {
  return /\b(docs?|documentation|api|library|package|sdk|crate|module|import|framework|reference|guide)\b/i.test(q);
}

export class WebService {
  constructor(options = {}) {
    this.userAgent = options.userAgent || DEFAULT_USER_AGENT;
    this.fetchTimeoutMs = options.fetchTimeoutMs || DEFAULT_FETCH_TIMEOUT_MS;
    this.searchTimeoutMs = options.searchTimeoutMs || DEFAULT_SEARCH_TIMEOUT_MS;
    this._initTurndown();
  }

  _initTurndown() {
    this.turndown = new TurndownService({
      headingStyle: "atx",
      hr: "---",
      bulletListMarker: "-",
      codeBlockStyle: "fenced",
    });

    // Remove script, style, noscript, svg, canvas, iframe from markdown conversion
    this.turndown.remove(["script", "style", "noscript", "svg", "canvas", "iframe"]);
  }

  /**
   * Search via Brave Search API.
   */
  async _searchBrave(query, limit, apiKey) {
    if (!apiKey) throw new Error("MissingBraveApiKey");
    const u = new URL("https://api.search.brave.com/res/v1/web/search");
    u.searchParams.set("q", query);
    u.searchParams.set("count", String(limit));
    const res = await globalThis.fetch(u.toString(), {
      headers: {
        "X-Subscription-Token": apiKey,
        Accept: "application/json",
        "User-Agent": this.userAgent,
      },
      signal: AbortSignal.timeout(this.searchTimeoutMs),
    });
    if (!res.ok) {
      throw new Error(`BraveSearchError: HTTP ${res.status} ${res.statusText}`);
    }
    const data = await res.json();
    const items = data.web?.results || [];
    return items.slice(0, limit).map((r) => ({
      title: r.title || "",
      url: r.url || "",
      snippet: r.description || "",
    }));
  }

  /**
   * Search via Tavily Search API.
   */
  async _searchTavily(query, limit, apiKey) {
    if (!apiKey) throw new Error("MissingTavilyApiKey");
    const res = await globalThis.fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": this.userAgent,
      },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        max_results: limit,
        include_raw_content: false,
      }),
      signal: AbortSignal.timeout(this.searchTimeoutMs),
    });
    if (!res.ok) {
      throw new Error(`TavilySearchError: HTTP ${res.status} ${res.statusText}`);
    }
    const data = await res.json();
    const items = data.results || [];
    return items.slice(0, limit).map((r) => ({
      title: r.title || "",
      url: r.url || "",
      snippet: r.content || "",
    }));
  }

  /**
   * Search via Upstash Context7 API (Library & Framework Documentation).
   */
  async _searchContext7(query, limit, apiKey) {
    if (!apiKey) throw new Error("MissingContext7ApiKey");
    const u = new URL("https://context7.com/api/v3/search");
    u.searchParams.set("query", query);
    u.searchParams.set("type", "json");
    const res = await globalThis.fetch(u.toString(), {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "User-Agent": this.userAgent,
      },
      signal: AbortSignal.timeout(this.searchTimeoutMs),
    });
    if (!res.ok) {
      throw new Error(`Context7SearchError: HTTP ${res.status} ${res.statusText}`);
    }
    const data = await res.json();
    const items = data.results || data.snippets || (Array.isArray(data) ? data : []);
    return items.slice(0, limit).map((r) => ({
      title: r.title || r.library || "Context7 Documentation",
      url: r.url || r.source || "https://context7.com",
      snippet: r.content || r.snippet || r.text || "",
    }));
  }

  /**
   * Search via SearXNG JSON instance.
   */
  async _searchSearxng(query, limit, baseUrl) {
    if (!baseUrl) throw new Error("MissingSearxngUrl");
    const u = new URL(baseUrl.replace(/\/+$/, "") + "/search");
    u.searchParams.set("q", query);
    u.searchParams.set("format", "json");
    const res = await globalThis.fetch(u.toString(), {
      headers: {
        "User-Agent": this.userAgent,
      },
      signal: AbortSignal.timeout(this.searchTimeoutMs),
    });
    if (!res.ok) {
      throw new Error(`SearxngSearchError: HTTP ${res.status} ${res.statusText}`);
    }
    const data = await res.json();
    const items = data.results || [];
    return items.slice(0, limit).map((r) => ({
      title: r.title || "",
      url: r.url || "",
      snippet: r.content || "",
    }));
  }

  /**
   * Performs web search using DuckDuckGo (HTML endpoint first, then duck-duck-scrape).
   */
  async _searchHtml(query, limit, safeSearch) {
    const res = await globalThis.fetch("https://html.duckduckgo.com/html/", {
      method: "POST",
      headers: {
        "User-Agent": this.userAgent,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      body: `q=${encodeURIComponent(query)}&kp=${safeSearch === "off" ? "-2" : safeSearch === "strict" ? "1" : "-1"}`,
      signal: AbortSignal.timeout(this.searchTimeoutMs),
    });

    if (!res.ok) return [];

    const html = await res.text();
    const dom = new JSDOM(html);
    const document = dom.window.document;
    const entries = document.querySelectorAll(".result");
    const results = [];

    for (const el of entries) {
      if (results.length >= limit) break;
      const titleEl = el.querySelector(".result__title a");
      const snippetEl = el.querySelector(".result__snippet");
      if (!titleEl) continue;

      let link = titleEl.href || "";
      try {
        const u = new URL(link, "https://html.duckduckgo.com");
        const uddg = u.searchParams.get("uddg");
        if (uddg) link = decodeURIComponent(uddg);
      } catch {
        /* keep raw link */
      }

      const title = (titleEl.textContent || "").trim();
      const snippet = snippetEl ? (snippetEl.textContent || "").trim() : "";
      if (title && link) {
        results.push({ title, url: link, snippet });
      }
    }

    return results;
  }

  async _searchDuckDuckGo(query, limit, safe_search) {
    await throttleDdgRequest();

    try {
      const htmlResults = await this._searchHtml(query, limit, safe_search);
      if (htmlResults.length > 0) {
        return htmlResults;
      }
    } catch {
      /* fall through to duck-duck-scrape */
    }

    let ddgSafeSearch = SafeSearchType.MODERATE;
    if (safe_search === "strict") ddgSafeSearch = SafeSearchType.STRICT;
    else if (safe_search === "off") ddgSafeSearch = SafeSearchType.OFF;

    const res = await search(query, {
      safeSearch: ddgSafeSearch,
    });

    if (res.noResults || !Array.isArray(res.results)) {
      return [];
    }

    return res.results.slice(0, limit).map((r) => ({
      title: r.title || "",
      url: r.url || "",
      snippet: r.description || r.rawDescription || "",
    }));
  }

  /**
   * Performs multi-provider web search with automatic failover.
   *
   * @param {object} params
   * @param {string} params.query Search terms or phrase
   * @param {number} [params.max_results=10] Max results to return
   * @param {"strict"|"moderate"|"off"} [params.safe_search="moderate"] SafeSearch level
   * @param {string} [params.provider="auto"] Provider override ('auto', 'brave', 'tavily', 'context7', 'searxng', 'duckduckgo')
   * @returns {Promise<{ query: string, count: number, provider: string, results: Array<{ title: string, url: string, snippet: string }> }>}
   */
  async search({ query, max_results = 10, safe_search = "moderate", provider }) {
    if (!query || typeof query !== "string" || !query.trim()) {
      throw new Error("InvalidQueryError: Search query must be a non-empty string");
    }

    const trimmedQuery = query.trim();
    const limit = Math.min(Math.max(1, max_results), 25);
    const cfg = getSearchConfig();
    const chosenProvider = provider || cfg.provider || "auto";

    // Build candidate provider chain
    const chain = [];
    if (chosenProvider !== "auto") {
      chain.push(chosenProvider);
    } else {
      // Auto chain: Brave -> Tavily -> Context7 (if documentation query) -> SearXNG -> DuckDuckGo
      if (cfg.brave_api_key) chain.push("brave");
      if (cfg.tavily_api_key) chain.push("tavily");
      if (cfg.context7_api_key && isDocQuery(trimmedQuery)) chain.push("context7");
      if (cfg.searxng_url) chain.push("searxng");
      chain.push("duckduckgo");
    }

    let lastError = null;
    for (const p of chain) {
      try {
        let results = [];
        if (p === "brave") results = await this._searchBrave(trimmedQuery, limit, cfg.brave_api_key);
        else if (p === "tavily") results = await this._searchTavily(trimmedQuery, limit, cfg.tavily_api_key);
        else if (p === "context7") results = await this._searchContext7(trimmedQuery, limit, cfg.context7_api_key);
        else if (p === "searxng") results = await this._searchSearxng(trimmedQuery, limit, cfg.searxng_url);
        else if (p === "duckduckgo") results = await this._searchDuckDuckGo(trimmedQuery, limit, safe_search);

        if (results && results.length > 0) {
          return {
            query: trimmedQuery,
            count: results.length,
            provider: p,
            results,
          };
        }
      } catch (err) {
        lastError = err;
        // On explicit provider request, fail fast
        if (chosenProvider !== "auto") throw err;
      }
    }

    if (lastError && chain.length === 1) throw lastError;

    return {
      query: trimmedQuery,
      count: 0,
      provider: chain[chain.length - 1],
      results: [],
    };
  }


  /**
   * Fetches a webpage or API endpoint, extracting clean Markdown.
   *
   * @param {object} params
   * @param {string} params.url HTTP/HTTPS URL
   * @param {boolean} [params.extract_article=true] Whether to use Mozilla Readability
   * @param {number} [params.timeout_ms=20000] Request timeout
   * @param {number} [params.max_chars=60000] Maximum response characters
   * @returns {Promise<object>}
   */
  async fetch({ url, extract_article = true, timeout_ms = this.fetchTimeoutMs, max_chars = MAX_FETCH_CHARS }) {
    if (!url || typeof url !== "string") {
      throw new Error("InvalidUrlError: URL must be a string");
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(url.trim());
    } catch {
      throw new Error(`InvalidUrlError: Malformed URL '${url}'`);
    }

    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      throw new Error(`InvalidUrlError: Only HTTP and HTTPS URLs are supported (got '${parsedUrl.protocol}')`);
    }

    const response = await globalThis.fetch(parsedUrl.href, {
      method: "GET",
      headers: {
        "User-Agent": this.userAgent,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,text/plain;q=0.7,*/*;q=0.5",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: AbortSignal.timeout(timeout_ms),
    });

    if (!response.ok) {
      throw new Error(`HttpError: GET '${url}' failed with status ${response.status} ${response.statusText}`);
    }

    const contentType = (response.headers.get("content-type") || "").toLowerCase();

    // 1. JSON handling (with automatic token distillation)
    if (contentType.includes("application/json")) {
      const data = await response.json();
      const distilled = pruneJsonPayload(data);
      const jsonStr = JSON.stringify(distilled, null, 2);
      const truncated = jsonStr.length > max_chars ? jsonStr.slice(0, max_chars) + "\n...[truncated]" : jsonStr;
      return {
        url: parsedUrl.href,
        status: response.status,
        content_type: "application/json",
        markdown: "```json\n" + truncated + "\n```",
        length: jsonStr.length,
      };
    }

    // 2. Plaintext / Markdown handling
    if (contentType.includes("text/plain") || contentType.includes("text/markdown")) {
      const text = await response.text();
      const truncated = text.length > max_chars ? text.slice(0, max_chars) + "\n...[truncated]" : text;
      return {
        url: parsedUrl.href,
        status: response.status,
        content_type: contentType.includes("markdown") ? "text/markdown" : "text/plain",
        markdown: truncated,
        length: text.length,
      };
    }

    // 3. HTML handling: Mozilla Readability + Turndown
    const rawHtml = await response.text();
    const dom = new JSDOM(rawHtml, { url: parsedUrl.href });
    const document = dom.window.document;

    // Remove scripts, styles, iframes from DOM before extraction
    const unwanted = document.querySelectorAll("script, style, noscript, iframe");
    unwanted.forEach((el) => el.remove());

    if (extract_article) {
      try {
        const reader = new Readability(document);
        const article = reader.parse();
        if (article && article.content) {
          let markdown = this.turndown.turndown(article.content);
          const fullLength = markdown.length;
          if (markdown.length > max_chars) {
            markdown = markdown.slice(0, max_chars) + "\n\n...[content truncated to " + max_chars + " chars]";
          }
          return {
            url: parsedUrl.href,
            status: response.status,
            content_type: "article",
            title: article.title || document.title || "",
            byline: article.byline || null,
            excerpt: article.excerpt || null,
            siteName: article.siteName || null,
            markdown: markdown.trim(),
            length: fullLength,
          };
        }
      } catch {
        // If readability parsing threw, fall through to full body conversion
      }
    }

    // Fall back to entire body HTML -> Markdown
    const bodyHtml = document.body ? document.body.innerHTML : rawHtml;
    let markdown = this.turndown.turndown(bodyHtml);
    const fullLength = markdown.length;
    if (markdown.length > max_chars) {
      markdown = markdown.slice(0, max_chars) + "\n\n...[content truncated to " + max_chars + " chars]";
    }

    return {
      url: parsedUrl.href,
      status: response.status,
      content_type: "page",
      title: document.title || "",
      markdown: markdown.trim(),
      length: fullLength,
    };
  }
}

/**
 * Anser Plugin to mount WebService into Context.
 */
export function webPlugin(ctx, options = {}) {
  const web = new WebService(options);
  ctx.provide("web", web);

  ctx.registerTool("web_search", {
    description:
      "Search the live web with automatic multi-provider routing (Brave, Tavily, Context7, SearXNG, DuckDuckGo). " +
      "Returns top matching results with titles, URLs, and text snippets. " +
      "Use this to find current documentation, technical solutions, and library APIs. " +
      "Set provider to 'context7' to specifically search framework and library documentation.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query keywords or phrase",
        },
        max_results: {
          type: "integer",
          description: "Maximum number of search results to return (default 10, max 25)",
          default: 10,
        },
        safe_search: {
          type: "string",
          enum: ["strict", "moderate", "off"],
          description: "SafeSearch filtering level (default 'moderate')",
          default: "moderate",
        },
        provider: {
          type: "string",
          enum: ["auto", "brave", "tavily", "context7", "searxng", "duckduckgo"],
          description: "Search provider override (default 'auto'). Use 'context7' for framework and library documentation.",
          default: "auto",
        },
      },
      required: ["query"],
    },
    execute: (args) => web.search(args),
  });

  ctx.registerTool("web_fetch", {
    description:
      "Fetches web page or API content at a URL and converts it into clean Markdown using Mozilla Readability and Turndown. " +
      "Extracts main article text, headers, and code blocks while stripping navigation, scripts, and ads. " +
      "Also supports JSON and plain text endpoints.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "HTTP or HTTPS URL to fetch",
        },
        extract_article: {
          type: "boolean",
          description: "When true (default), use Mozilla Readability to extract main article body. When false, convert entire page body to markdown.",
          default: true,
        },
        timeout_ms: {
          type: "integer",
          description: "Request timeout in milliseconds (default 20000)",
          default: 20000,
        },
        max_chars: {
          type: "integer",
          description: "Maximum characters of markdown to return (default 60000)",
          default: 60000,
        },
      },
      required: ["url"],
    },
    execute: (args) => web.fetch(args),
  });
}
