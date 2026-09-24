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

export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Anser/2026.1";

export const MAX_FETCH_CHARS = 60_000;
export const DEFAULT_FETCH_TIMEOUT_MS = 20_000;
export const DEFAULT_SEARCH_TIMEOUT_MS = 15_000;

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
   * Performs web search using DuckDuckGo (zero API keys required).
   *
   * @param {object} params
   * @param {string} params.query Search terms or phrase
   * @param {number} [params.max_results=10] Max results to return
   * @param {"strict"|"moderate"|"off"} [params.safe_search="moderate"] SafeSearch level
   * @returns {Promise<{ query: string, count: number, results: Array<{ title: string, url: string, snippet: string }> }>}
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

  /**
   * Performs web search using DuckDuckGo (zero API keys required).
   *
   * @param {object} params
   * @param {string} params.query Search terms or phrase
   * @param {number} [params.max_results=10] Max results to return
   * @param {"strict"|"moderate"|"off"} [params.safe_search="moderate"] SafeSearch level
   * @returns {Promise<{ query: string, count: number, results: Array<{ title: string, url: string, snippet: string }> }>}
   */
  async search({ query, max_results = 10, safe_search = "moderate" }) {
    if (!query || typeof query !== "string" || !query.trim()) {
      throw new Error("InvalidQueryError: Search query must be a non-empty string");
    }

    const trimmedQuery = query.trim();
    const limit = Math.min(Math.max(1, max_results), 25);

    // Primary: Static HTML endpoint (no anomaly detection / captcha issues)
    try {
      const htmlResults = await this._searchHtml(trimmedQuery, limit, safe_search);
      if (htmlResults.length > 0) {
        return {
          query: trimmedQuery,
          count: htmlResults.length,
          results: htmlResults,
        };
      }
    } catch {
      /* fall through to duck-duck-scrape */
    }

    // Secondary: duck-duck-scrape package
    let ddgSafeSearch = SafeSearchType.MODERATE;
    if (safe_search === "strict") ddgSafeSearch = SafeSearchType.STRICT;
    else if (safe_search === "off") ddgSafeSearch = SafeSearchType.OFF;

    const res = await search(trimmedQuery, {
      safeSearch: ddgSafeSearch,
    });

    if (res.noResults || !Array.isArray(res.results)) {
      return {
        query: trimmedQuery,
        count: 0,
        results: [],
      };
    }

    const items = res.results.slice(0, limit).map((r) => ({
      title: r.title || "",
      url: r.url || "",
      snippet: r.description || r.rawDescription || "",
    }));

    return {
      query: trimmedQuery,
      count: items.length,
      results: items,
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

    // 1. JSON handling
    if (contentType.includes("application/json")) {
      const data = await response.json();
      const jsonStr = JSON.stringify(data, null, 2);
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
      "Search the live web using DuckDuckGo (zero API keys required). " +
      "Returns top matching results with titles, URLs, and text snippets. " +
      "Use this to find current documentation, technical solutions, and library APIs.",
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
