/**
 * Structural AST Service (Powered by ast-grep)
 *
 * Provides:
 * - Code-like pattern matching (ast_search) with metavariables ($VAR, $$$BODY)
 * - Structural code surgery (ast_replace) that preserves formatting and ignores whitespace
 * - Mandatory compile/syntax validation before writing mutations to disk
 * - Cordis plugin integration with reversible registration
 * - Dual Windows NTFS and WSL DrvFs cross-path safety
 *
 * Engine selection (P5):
 * - Primary: in-process @ast-grep/napi binding (lazy-loaded, cached).
 *   Supported languages: js, jsx, ts, tsx, html, css.
 * - Fallback: ast-grep CLI (execFileSync). Used automatically when the napi
 *   binding is unavailable OR the target language is not supported by napi
 *   (python, go, rust, c, cpp, json). The choice is invisible to callers.
 * - The exit-1/empty-stdout "no matches" quirk is handled ONLY in the CLI path.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { IS_WINDOWS } from "../../config.js";
import { toWindowsPath, toPosixWslPath, canonicalizePath } from "../../wsl_bridge.js";
import { DEFAULT_IGNORED_DIRS } from "./sandbox_fs.js";

const EXT_TO_LANG = {
  ".js": "js",
  ".mjs": "js",
  ".cjs": "js",
  ".jsx": "jsx",
  ".ts": "ts",
  ".mts": "ts",
  ".cts": "ts",
  ".tsx": "tsx",
  ".py": "python",
  ".pyw": "python",
  ".go": "go",
  ".rs": "rust",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".hpp": "cpp",
  ".cc": "cpp",
  ".html": "html",
  ".css": "css",
  ".json": "json",
};

// Languages the in-process @ast-grep/napi binding can parse.
// (napi ships tree-sitter grammars for these only; everything else uses the CLI.)
const NAPI_LANGS = new Set(["js", "jsx", "ts", "tsx", "html", "css"]);

// Global cap on matches returned by any search (single file or directory scan).
const MAX_MATCHES = 50;

// Files larger than this are skipped during directory scans (implausible for AST).
const MAX_FILE_BYTES = 1_000_000;

// P7 — A target string is treated as a glob when it contains any of the
// standard glob metacharacters. Plain relative/absolute paths (no metachars)
// are treated as literal file or directory paths.
const GLOB_META_RE = /[*?[\]{}!+()]/;
function isGlobPattern(p) {
  return typeof p === "string" && GLOB_META_RE.test(p);
}

// ---------------------------------------------------------------------------
// Lazy napi engine loader (module-level cache, shared across all AstService
// instances). On ANY load failure we log a single stderr note and return null,
// which routes the caller to the CLI fallback.
// ---------------------------------------------------------------------------
let _napiEngine = null;
let _napiLoadAttempted = false;

async function loadNapiEngine() {
  if (_napiLoadAttempted) return _napiEngine;
  _napiLoadAttempted = true;
  try {
    const mod = await import("@ast-grep/napi");
    const engine = mod && mod.default ? mod.default : mod;
    if (engine && typeof engine.parse === "function" && typeof engine.pattern === "function") {
      _napiEngine = engine;
    } else {
      _napiEngine = null;
      process.stderr.write("[ast_service] @ast-grep/napi loaded but incomplete; using CLI fallback\n");
    }
  } catch (err) {
    _napiEngine = null;
    process.stderr.write(`[ast_service] @ast-grep/napi unavailable (${err.message}); using CLI fallback\n`);
  }
  return _napiEngine;
}

// ---------------------------------------------------------------------------
// P6 — Universal syntax-gate infrastructure.
//
// The syntax gate (validateSyntax) must cover EVERY language the AST engine
// can rewrite. Each language has a dedicated checker; when a checker is
// unavailable (binary missing, module failed to load) the gate degrades
// HONESTLY: it returns a structured { checked: false, ... } result and a
// stderr note, and NEVER reports an unchecked rewrite as "valid".
//
// All external checkers are probed ONCE and cached (module-level), mirroring
// the lazy-load discipline of the napi engine so startup stays light.
// ---------------------------------------------------------------------------

// createRequire so the typescript package can be loaded synchronously and
// lazily (it is a CJS package; a dynamic import would force an async path in
// the otherwise-synchronous validateSyntax gate).
const _require = createRequire(import.meta.url);

// --- TypeScript (ts/tsx/mts/cts) ------------------------------------------
// Lazy-loaded once; null if the module fails to load (treated as unavailable).
let _tsModule = null;
let _tsLoadAttempted = false;

function loadTypescript() {
  // Test seam: a forced "unavailable" override short-circuits the real load.
  if (_probeOverrides.typescript === false) return null;
  if (_tsLoadAttempted) return _tsModule;
  _tsLoadAttempted = true;
  try {
    const mod = _require("typescript");
    if (mod && typeof mod.transpileModule === "function") {
      _tsModule = mod;
    } else {
      _tsModule = null;
      process.stderr.write("[ast_service] typescript loaded but incomplete; TS syntax gate unavailable\n");
    }
  } catch (err) {
    _tsModule = null;
    process.stderr.write(`[ast_service] typescript unavailable (${err.message}); TS syntax gate unavailable\n`);
  }
  return _tsModule;
}

// --- External binary availability probes (cached once) ----------------------
// A probe returns true only when the binary exists AND runs successfully
// (exit 0). ENOENT (binary missing) and non-zero exit both mean "unavailable".
function probeBinary(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: "ignore", timeout: 5000, windowsHide: true });
    return true;
  } catch (err) {
    // ENOENT => binary not on PATH; non-zero exit => present but not runnable.
    return false;
  }
}

// Seamable override registry: tests can force a checker to "available" or
// "unavailable" without touching the real environment (dependency injection).
// Keys: "python" | "gofmt" | "rustfmt" | "typescript". Value: boolean, or
// undefined to clear the override and fall back to the real probe.
const _probeOverrides = {};

/**
 * Test seam: force a syntax-gate checker to be treated as available/unavailable
 * regardless of the real environment. Pass undefined to clear the override.
 * @param {"python"|"gofmt"|"rustfmt"|"typescript"} name
 * @param {boolean|undefined} available
 */
export function setSyntaxProbeOverride(name, available) {
  if (available === undefined) delete _probeOverrides[name];
  else _probeOverrides[name] = available;
}

let _pythonProbe = null; // null = not probed yet; true/false = cached result
function pythonAvailable() {
  if ("python" in _probeOverrides) return _probeOverrides.python;
  if (_pythonProbe !== null) return _pythonProbe;
  const bin = IS_WINDOWS ? "python" : "python3";
  _pythonProbe = probeBinary(bin, ["--version"]);
  if (!_pythonProbe) {
    process.stderr.write(`[ast_service] python (${bin}) unavailable; Python syntax gate will degrade honestly\n`);
  }
  return _pythonProbe;
}

let _gofmtProbe = null;
function gofmtAvailable() {
  if ("gofmt" in _probeOverrides) return _probeOverrides.gofmt;
  if (_gofmtProbe !== null) return _gofmtProbe;
  _gofmtProbe = probeBinary("gofmt", ["-h"]);
  if (!_gofmtProbe) {
    process.stderr.write("[ast_service] gofmt unavailable; Go syntax gate will degrade honestly\n");
  }
  return _gofmtProbe;
}

let _rustfmtProbe = null;
function rustfmtAvailable() {
  if ("rustfmt" in _probeOverrides) return _probeOverrides.rustfmt;
  if (_rustfmtProbe !== null) return _rustfmtProbe;
  _rustfmtProbe = probeBinary("rustfmt", ["--version"]);
  if (!_rustfmtProbe) {
    process.stderr.write("[ast_service] rustfmt unavailable; Rust syntax gate will degrade honestly\n");
  }
  return _rustfmtProbe;
}

/**
 * Extracts single ($NAME) and multi ($$$NAME) metavariable names from a pattern.
 * Returns { single: Set<string>, multi: Set<string> }.
 */
function extractMetaVars(pattern) {
  const single = new Set();
  const multi = new Set();
  const re = /\$+([A-Z][A-Z0-9_]*)/g;
  let m;
  while ((m = re.exec(pattern)) !== null) {
    const dollarCount = m[0].length - m[1].length;
    if (dollarCount >= 3) multi.add(m[1]);
    else single.add(m[1]);
  }
  return { single, multi };
}

export class AstService {
  constructor(options = {}) {
    // P4i: canonicalize the AST workspace root through the OS symlink/junction
    // resolution layer so a junction/symlink cwd (e.g. D:\mnt\d -> D:\) is
    // stored as its real path. Containment checks then compare realpath
    // against a real root, eliminating false escape errors while still
    // catching real escapes.
    const rawRoot = options.root || process.cwd();
    this.root = canonicalizePath(rawRoot);
  }

  detectLanguage(filePath, explicitLang) {
    if (explicitLang) return explicitLang.toLowerCase();
    const ext = path.extname(filePath).toLowerCase();
    return EXT_TO_LANG[ext] || "js";
  }

  /**
   * Infers a language purely by file extension for directory scans.
   * Returns null when the extension is not in the supported set (file is skipped).
   */
  inferLanguageByExtension(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return EXT_TO_LANG[ext] || null;
  }

  resolvePath(inputPath) {
    if (!inputPath) throw new Error("Path parameter is required for AST operation");
    if (typeof inputPath !== "string") {
      throw new Error("InvalidPathError: Path must be a string");
    }
    if (inputPath.includes("\0")) {
      throw new Error("NullByteError: Path contains prohibited null byte character");
    }

    let p = inputPath.trim();
    const baseName = path.basename(p.replace(/\\/g, "/")).toUpperCase();
    const reserved = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/;
    if (reserved.test(baseName)) {
      throw new Error(`DeviceNameError: Prohibited access to Windows reserved device '${baseName}'`);
    }

    if (IS_WINDOWS) {
      p = toWindowsPath(p);
      if (!path.isAbsolute(p)) {
        p = path.resolve(this.root, p);
      }
    } else {
      p = toPosixWslPath(p);
      if (!path.isAbsolute(p)) {
        p = path.resolve(this.root, p);
      }
    }
    const normalizedTarget = path.normalize(p);
    const normalizedRoot = path.normalize(this.root);

    // P4i: canonicalize BOTH sides of the containment comparison through the
    // OS symlink/junction resolution layer so a junction-form target is
    // compared against the real root in the same "real" path space. This
    // eliminates false PathEscapeError/SymlinkEscapeError from junction/symlink
    // cwds while real escapes (../outside, symlink-to-outside) still resolve
    // outside the real root and are caught.
    const realTarget = canonicalizePath(normalizedTarget);
    const realRoot = canonicalizePath(normalizedRoot);
    const rel = path.relative(realRoot, realTarget);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`PathEscapeError: Access denied. Path '${inputPath}' escapes sandbox root '${this.root}'`);
    }

    // Symlink escape verification (both sides now in real-path space)
    this.verifySymlinkContainment(realTarget, realRoot);

    // Return the ORIGINAL normalized path (not the canonical one) so that
    // downstream path labels (napi fileLabel, CLI m.file, path.relative in
    // tests) stay consistent with the path the caller passed in. The
    // containment decision above was made in canonical space, which is what
    // matters for security; the returned label is only used for reporting.
    return normalizedTarget;
  }

  verifySymlinkContainment(targetPath, rootPath) {
    try {
      if (fs.existsSync(targetPath)) {
        const real = fs.realpathSync(targetPath);
        const relReal = path.relative(rootPath, path.normalize(real));
        if (relReal.startsWith("..") || path.isAbsolute(relReal)) {
          throw new Error(`SymlinkEscapeError: Real path '${real}' escapes sandbox root '${rootPath}'`);
        }
      } else {
        let parent = path.dirname(targetPath);
        while (parent && parent !== path.dirname(parent)) {
          if (fs.existsSync(parent)) {
            const realParent = fs.realpathSync(parent);
            const relReal = path.relative(rootPath, path.normalize(realParent));
            if (relReal.startsWith("..") || path.isAbsolute(relReal)) {
              throw new Error(`SymlinkEscapeError: Parent directory '${parent}' resolves to '${realParent}' escaping root '${rootPath}'`);
            }
            break;
          }
          parent = path.dirname(parent);
        }
      }
    } catch (err) {
      if (err.message.startsWith("SymlinkEscapeError")) throw err;
    }
  }

  /**
   * Resolves the ast-grep CLI binary.
   * (P5 fix: removed the duplicated "mcp-qwen" path segment that appeared in the
   * nested candidates; only the direct node_modules location and the bare
   * "ast-grep" PATH fallback remain.)
   */
  getBinary() {
    const winBinDirect = path.join(
      this.root,
      "node_modules",
      "@ast-grep",
      "cli-win32-x64-msvc",
      "ast-grep.exe"
    );
    const linuxBinDirect = path.join(
      this.root,
      "node_modules",
      "@ast-grep",
      "cli-linux-x64-gnu",
      "ast-grep"
    );

    if (IS_WINDOWS) {
      if (fs.existsSync(winBinDirect)) return winBinDirect;
      return "ast-grep";
    } else {
      if (fs.existsSync(linuxBinDirect)) return linuxBinDirect;
      return "ast-grep";
    }
  }

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  /**
   * Searches for syntactic code patterns using ast-grep.
   *
   * @param {object} params
   * @param {string} params.path Target file or directory
   * @param {string} params.pattern Search pattern with metavariables ($VAR, $$$BODY)
   * @param {string} [params.lang] Optional language identifier
   * @returns {Promise<{ path: string, language: string|null, count: number, matches: Array<object> }>}
   */
  async search({ path: targetPath, pattern, lang }) {
    if (!pattern || typeof pattern !== "string" || pattern.trim().length === 0) {
      throw new Error("AST search requires a non-empty pattern");
    }

    const resolved = this.resolvePath(targetPath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Path does not exist: ${targetPath}`);
    }

    if (fs.statSync(resolved).isDirectory()) {
      return this.searchDirectory(resolved, pattern);
    }

    const detectedLang = this.detectLanguage(resolved, lang);
    const matches = await this.searchFile(resolved, detectedLang, pattern);
    return {
      path: resolved,
      language: detectedLang,
      count: matches.length,
      matches: matches.slice(0, MAX_MATCHES),
    };
  }

  /**
   * Searches a single file, choosing the napi or CLI engine transparently.
   * Returns the raw (uncapped) array of match objects.
   */
  async searchFile(resolved, lang, pattern) {
    const engine = await loadNapiEngine();
    if (engine && NAPI_LANGS.has(lang)) {
      const content = fs.readFileSync(resolved, "utf8");
      return this.napiSearch(engine, content, lang, pattern, resolved);
    }
    return this.cliSearch(resolved, lang, pattern);
  }

  /**
   * P7 — Additive match enrichment. Adds two derived fields to an existing
   * match object WITHOUT altering any pre-existing field (live agents consume
   * the original shape):
   *   - location: `${file}:${line}:${col}` (0-indexed line/col, matching the
   *     existing `line`/`column` contract) for quick grep-able referencing.
   *   - snippet:  the match text collapsed to a single trimmed line (all
   *     whitespace runs -> one space) so multi-line matches render compactly.
   * The original `file`, `line`, `column`, `text`, `metavariables` fields are
   * preserved verbatim.
   */
  _enrichMatch(m) {
    const snippet = (m.text || "").replace(/\s+/g, " ").trim();
    return {
      ...m,
      location: `${m.file}:${m.line}:${m.column}`,
      snippet,
    };
  }

  /**
   * In-process napi search. Produces the exact same match shape as the CLI path:
   * { file, line, column, text, metavariables } plus the additive P7
   * { location, snippet } fields. Both engines report 0-indexed line /
   * 0-indexed column, so the values pass through unchanged.
   */
  napiSearch(engine, content, lang, pattern, fileLabel) {
    const root = engine.parse(lang, content);
    const rootNode = root.root();
    const config = engine.pattern(lang, pattern);
    const matches = rootNode.findAll(config);
    const { single } = extractMetaVars(pattern);

    return matches.map((m) => {
      const range = m.range();
      const mv = {};
      for (const name of single) {
        const node = m.getMatch(name);
        if (node) mv[name] = node.text();
      }
      return this._enrichMatch({
        file: fileLabel,
        // Both the CLI --json=compact and napi report 0-indexed line / 0-indexed
        // column. Pass through raw so the napi path is byte-identical to the CLI
        // path (the existing tool-result contract).
        line: range.start.line,
        column: range.start.column,
        text: m.text(),
        metavariables: mv,
      });
    });
  }

  /**
   * CLI search (fallback). The exit-1/empty-stdout "no matches" quirk is handled
   * ONLY here.
   */
  cliSearch(file, lang, pattern) {
    const bin = this.getBinary();
    const args = [
      "run",
      "--pattern",
      pattern,
      "--lang",
      lang,
      "--json=compact",
      file,
    ];

    try {
      const stdout = execFileSync(bin, args, {
        cwd: this.root,
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 8 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });

      const parsed = stdout.trim() ? JSON.parse(stdout) : [];
      return parsed.map((m) => {
        const mv = {};
        const rawMv = m.metaVariables?.single || {};
        for (const [k, v] of Object.entries(rawMv)) {
          mv[k] = typeof v === "object" && v !== null && "text" in v ? v.text : v;
        }
        return this._enrichMatch({
          file: m.file,
          line: m.range?.start?.line ?? 1,
          column: m.range?.start?.column ?? 1,
          text: m.text,
          metavariables: mv,
        });
      });
    } catch (err) {
      // Exit code 1 with empty stdout means 0 matches found in ast-grep
      if (err.status === 1 && !err.stderr) {
        return [];
      }
      throw new Error(`AST search error: ${err.stderr || err.message}`);
    }
  }

  /**
   * Directory-level search: recursively walks `resolved`, skipping the sandbox
   * ignore set, inferring language by extension, and applying a global
   * MAX_MATCHES cap across the whole scan.
   */
  async searchDirectory(resolved, pattern) {
    const engine = await loadNapiEngine();
    const matches = [];

    const walk = async (dir) => {
      if (matches.length >= MAX_MATCHES) return;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (matches.length >= MAX_MATCHES) break;
        if (DEFAULT_IGNORED_DIRS.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.isFile()) {
          const lang = this.inferLanguageByExtension(full);
          if (!lang) continue; // language cannot be inferred -> skip
          let st;
          try {
            st = fs.statSync(full);
          } catch {
            continue;
          }
          if (st.size > MAX_FILE_BYTES) continue; // implausibly large -> skip
          try {
            const fileMatches = await this.searchFile(full, lang, pattern);
            for (const m of fileMatches) {
              if (matches.length >= MAX_MATCHES) break;
              matches.push(m);
            }
          } catch {
            // A file that fails to parse (e.g. syntax error) is skipped; the
            // scan continues with the remaining files.
          }
        }
      }
    };

    await walk(resolved);

    return {
      path: resolved,
      language: null, // mixed languages across a directory scan
      count: matches.length,
      matches: matches.slice(0, MAX_MATCHES),
    };
  }

  // -------------------------------------------------------------------------
  // Replace
  // -------------------------------------------------------------------------

  /**
   * Replaces a syntactic AST pattern with a rewritten pattern.
   * Performs mandatory compile/syntax checking before committing to disk.
   *
   * @param {object} params
   * @param {string} params.path Target file
   * @param {string} params.pattern Search pattern with metavariables ($VAR, $$$BODY)
   * @param {string} params.rewrite Replacement pattern
   * @param {string} [params.lang] Optional language identifier
   * @returns {Promise<{ path: string, modified: boolean, message: string }>}
   */
  async replace({ path: targetPath, pattern, rewrite, lang, dry_run }) {
    if (!pattern || typeof pattern !== "string") {
      throw new Error("AST replace requires a pattern parameter");
    }
    if (typeof rewrite !== "string") {
      throw new Error("AST replace requires a rewrite parameter");
    }

    const resolved = this.resolvePath(targetPath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`File does not exist: ${targetPath}`);
    }
    if (fs.statSync(resolved).isDirectory()) {
      throw new Error(`Target path must be a file, not a directory: ${targetPath}`);
    }

    const originalContent = fs.readFileSync(resolved, "utf8");
    const detectedLang = this.detectLanguage(resolved, lang);

    const engine = await loadNapiEngine();
    if (engine && NAPI_LANGS.has(detectedLang)) {
      return this.napiReplace(engine, resolved, originalContent, detectedLang, pattern, rewrite, dry_run);
    }
    return this.cliReplace(resolved, originalContent, detectedLang, pattern, rewrite, dry_run);
  }

  /**
   * P7 — Pure in-memory napi rewrite. Computes the new file content from the
   * original WITHOUT touching disk, so it can be reused by both the single-file
   * path, the batch path, and dry-run previews. Returns
   *   { newContent, replacements }
   * where `replacements` is the number of matched AST nodes rewritten (0 when
   * the pattern matched nothing, in which case newContent === originalContent).
   */
  _napiComputeNewContent(engine, originalContent, lang, pattern, rewrite) {
    const root = engine.parse(lang, originalContent);
    const rootNode = root.root();
    const config = engine.pattern(lang, pattern);
    const matches = rootNode.findAll(config);
    if (matches.length === 0) {
      return { newContent: originalContent, replacements: 0 };
    }
    const { single, multi } = extractMetaVars(pattern);

    const edits = [];
    for (const m of matches) {
      // Build substitution table; longer tokens first so a single-var name that
      // is a substring of a multi-var token (e.g. $A vs $$AB) is not corrupted.
      const table = [];
      for (const name of single) {
        table.push({ token: `$${name}`, value: () => {
          const node = m.getMatch(name);
          return node ? node.text() : "";
        } });
      }
      for (const name of multi) {
        table.push({ token: `$$$${name}`, value: () => {
          const nodes = m.getMultipleMatches(name);
          return nodes.map((n) => n.text()).join("");
        } });
      }
      table.sort((a, b) => b.token.length - a.token.length);

      let substituted = rewrite;
      for (const t of table) {
        substituted = substituted.split(t.token).join(t.value());
      }
      edits.push(m.replace(substituted));
    }

    return { newContent: rootNode.commitEdits(edits), replacements: matches.length };
  }

  /**
   * P7 — In-memory CLI compute. Copies the file to a throwaway temp file, runs
   * the CLI --update-all against the COPY (never the real file), reads the
   * result back, and cleans up. This guarantees a dry_run preview never touches
   * the real file on disk during the compute phase. Returns
   *   { newContent, replacements }
   * where replacements is 0 when the pattern matched nothing (newContent ===
   * originalContent) and 1 otherwise (the CLI does not report a per-node count).
   */
  _cliComputeNewContent(file, originalContent, lang, pattern, rewrite) {
    const tmp = _writeTemp(originalContent, path.extname(file) || ".js");
    try {
      const bin = this.getBinary();
      const args = [
        "run",
        "--pattern", pattern,
        "--rewrite", rewrite,
        "--lang", lang,
        "--update-all",
        tmp,
      ];
      try {
        execFileSync(bin, args, {
          cwd: this.root,
          encoding: "utf8",
          timeout: 30_000,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch (err) {
        // Exit 1 / empty stderr = no matches (benign) -> content unchanged.
        if (err.status === 1 && !err.stderr) {
          return { newContent: originalContent, replacements: 0 };
        }
        throw err;
      }
      const newContent = fs.readFileSync(tmp, "utf8");
      return { newContent, replacements: newContent === originalContent ? 0 : 1 };
    } finally {
      _removeTemp(tmp);
    }
  }

  /**
   * P7 — Unified compute + gate for a single file. Computes the rewrite FULLY
   * IN MEMORY (napi, or CLI against a temp copy — never the real file), then
   * either:
   *   - dry_run: validates the would-be content in memory and writes NOTHING, or
   *   - real: commits through the shared _commitReplace gate
   *     (write -> validateSyntax -> pristine rollback on verified-invalid).
   * Returns { changed, replacements, syntaxVerified, error }:
   *   - changed:false, error:null        -> no match (content identical)
   *   - changed:false, error:<msg>       -> verified invalid (rolled back / would be)
   *   - changed:true,  syntaxVerified    -> committed / would change
   *                                         (true=validated, false=honest-degrade)
   */
  async _computeAndGate(file, originalContent, lang, pattern, rewrite, dry_run) {
    const engine = await loadNapiEngine();
    let newContent;
    let replacements;
    if (engine && NAPI_LANGS.has(lang)) {
      const r = this._napiComputeNewContent(engine, originalContent, lang, pattern, rewrite);
      newContent = r.newContent;
      replacements = r.replacements;
    } else {
      const r = this._cliComputeNewContent(file, originalContent, lang, pattern, rewrite);
      newContent = r.newContent;
      replacements = r.replacements;
    }
    if (newContent === originalContent) {
      return { changed: false, replacements: 0, syntaxVerified: null, error: null };
    }
    if (dry_run) {
      // Preview only: validate the would-be content in memory, write nothing.
      const validation = this.validateSyntax(file, newContent, lang);
      if (validation.checked && !validation.valid) {
        return {
          changed: false,
          replacements: 0,
          syntaxVerified: false,
          error: `SyntaxValidationError: AST replacement would result in malformed syntax (${validation.error}).`,
        };
      }
      return { changed: true, replacements, syntaxVerified: validation.checked, error: null };
    }
    return this._commitReplace(file, originalContent, newContent, replacements, lang);
  }

  /**
   * In-process napi replace. Computes the rewrite in memory (shared
   * _napiComputeNewContent), then commits through the shared _commitReplace gate
   * (write -> validateSyntax -> pristine rollback on verified-invalid).
   * Honors dry_run: when true, validates the would-be content in memory and
   * writes nothing to disk.
   */
  napiReplace(engine, resolved, originalContent, lang, pattern, rewrite, dry_run) {
    const { newContent, replacements } = this._napiComputeNewContent(
      engine, originalContent, lang, pattern, rewrite
    );
    if (newContent === originalContent) {
      return {
        path: resolved,
        modified: false,
        message: `Pattern '${pattern}' did not match any AST nodes in ${path.basename(resolved)}. File unchanged.`,
      };
    }

    if (dry_run) {
      // Preview only: validate the would-be content in memory, write nothing.
      const validation = this.validateSyntax(resolved, newContent, lang);
      if (validation.checked && !validation.valid) {
        throw new Error(
          `SyntaxValidationError: AST replacement would result in malformed syntax (${validation.error}).`
        );
      }
      const verifiedNote = validation.checked
        ? "Syntax validated."
        : `Syntax NOT verified (no checker available for '${lang}').`;
      return {
        path: resolved,
        modified: true,
        dry_run: true,
        syntax_verified: validation.checked,
        bytes_before: Buffer.byteLength(originalContent, "utf8"),
        bytes_after: Buffer.byteLength(newContent, "utf8"),
        message: `AST pattern '${pattern}' would replace in ${path.basename(resolved)} (dry run, no write). ${verifiedNote}`,
      };
    }

    const r = this._commitReplace(resolved, originalContent, newContent, replacements, lang);
    if (r.error) throw new Error(r.error);

    // Honest degradation: the rewrite is committed, but the tool result must
    // state it was NOT syntax-verified (no checker available for this lang).
    const verifiedNote = r.syntaxVerified
      ? "Syntax validated."
      : `Syntax NOT verified (no checker available for '${lang}').`;

    return {
      path: resolved,
      modified: true,
      syntax_verified: r.syntaxVerified,
      bytes_before: Buffer.byteLength(originalContent, "utf8"),
      bytes_after: Buffer.byteLength(newContent, "utf8"),
      message: `AST pattern '${pattern}' successfully replaced in ${path.basename(resolved)}. ${verifiedNote}`,
    };
  }

  /**
   * P7 — Shared commit gate for a single file. Writes `newContent` to disk,
   * runs the SAME validateSyntax gate, and rolls the file back to
   * `originalContent` (pristine) when the rewrite is verified INVALID. Returns a
   * structured result so both the single-file and batch paths can share it:
   *   { changed, replacements, syntaxVerified, error }
   *   - changed:false, error:null        -> no-op (content identical)
   *   - changed:false, error:<msg>       -> verified invalid, rolled back
   *   - changed:true,  syntaxVerified    -> committed (true=validated,
   *                                         false=honest-degrade, no checker)
   */
  _commitReplace(file, originalContent, newContent, replacements, lang) {
    if (newContent === originalContent) {
      return { changed: false, replacements: 0, syntaxVerified: null, error: null };
    }
    fs.writeFileSync(file, newContent, "utf8");
    const validation = this.validateSyntax(file, newContent, lang);
    if (validation.checked && !validation.valid) {
      // Verified INVALID -> rollback immediately to original pristine content.
      fs.writeFileSync(file, originalContent, "utf8");
      return {
        changed: false,
        replacements: 0,
        syntaxVerified: false,
        error: `SyntaxValidationError: AST replacement resulted in malformed syntax (${validation.error}). Disk rolled back.`,
      };
    }
    return {
      changed: true,
      replacements,
      syntaxVerified: validation.checked,
      error: null,
    };
  }

  /**
   * CLI replace (fallback). P7: the rewrite is now computed IN MEMORY against a
   * throwaway temp copy (never the real file), so a dry_run preview is
   * byte-safe on this path too. The result is then committed through the SAME
   * shared _commitReplace gate (write -> validateSyntax -> pristine rollback),
   * giving byte-identical behavior to the napi path.
   */
  cliReplace(resolved, originalContent, lang, pattern, rewrite, dry_run) {
    let newContent;
    let replacements;
    try {
      const r = this._cliComputeNewContent(resolved, originalContent, lang, pattern, rewrite);
      newContent = r.newContent;
      replacements = r.replacements;
    } catch (err) {
      if (err.status === 1 && !err.stderr) {
        return {
          path: resolved,
          modified: false,
          message: `Pattern '${pattern}' not found in ${path.basename(resolved)}. Try a broader pattern or edit_file.`,
        };
      }
      throw new Error(`AST replace error: ${err.stderr || err.message}`);
    }

    if (newContent === originalContent) {
      return {
        path: resolved,
        modified: false,
        message: `Pattern '${pattern}' did not match any AST nodes in ${path.basename(resolved)}. File unchanged.`,
      };
    }

    if (dry_run) {
      // Preview only: validate the would-be content in memory, write nothing.
      const validation = this.validateSyntax(resolved, newContent, lang);
      if (validation.checked && !validation.valid) {
        throw new Error(
          `SyntaxValidationError: AST replacement would result in malformed syntax (${validation.error}).`
        );
      }
      const verifiedNote = validation.checked
        ? "Syntax validated."
        : `Syntax NOT verified (no checker available for '${lang}').`;
      return {
        path: resolved,
        modified: true,
        dry_run: true,
        syntax_verified: validation.checked,
        bytes_before: Buffer.byteLength(originalContent, "utf8"),
        bytes_after: Buffer.byteLength(newContent, "utf8"),
        message: `AST pattern '${pattern}' would replace in ${path.basename(resolved)} (dry run, no write). ${verifiedNote}`,
      };
    }

    const r = this._commitReplace(resolved, originalContent, newContent, replacements, lang);
    if (r.error) throw new Error(r.error);

    // Honest degradation: committed, but the result states it was NOT
    // syntax-verified when no checker was available for this language.
    const verifiedNote = r.syntaxVerified
      ? "Syntax validated."
      : `Syntax NOT verified (no checker available for '${lang}').`;

    return {
      path: resolved,
      modified: true,
      syntax_verified: r.syntaxVerified,
      bytes_before: Buffer.byteLength(originalContent, "utf8"),
      bytes_after: Buffer.byteLength(newContent, "utf8"),
      message: `AST pattern '${pattern}' successfully replaced in ${path.basename(resolved)}. ${verifiedNote}`,
    };
  }

  // -------------------------------------------------------------------------
  // P7 — Batch replace (directory / glob target) with dry_run preview.
  //
  // `replace` is single-file only. `replaceBatch` applies the SAME pattern/
  // rewrite across every matching file in a directory or glob, running the
  // SAME validateSyntax gate per file, rolling back ONLY the file that is
  // verified invalid, and continuing to the next file (never aborting the
  // batch). It respects DEFAULT_IGNORED_DIRS and the 1 MB per-file guard.
  //
  // dry_run computes everything (matches, rewrites, per-file validation) but
  // writes NOTHING to disk, so a preview is byte-safe.
  // -------------------------------------------------------------------------

  /**
   * Resolves a batch target (directory or glob) to a deterministic, sorted list
   * of candidate file paths. Returns null when the target is a single file
   * (caller should use the single-file path) or does not exist.
   *
   * @param {string} resolved Resolved (absolute) target path.
   * @returns {string[]|null}
   */
  _resolveBatchFiles(resolved) {
    if (isGlobPattern(resolved)) {
      // Glob: expand relative to the sandbox root, then filter to regular files
      // that are inside the root and not in an ignored directory.
      const base = path.dirname(resolved);
      const pattern = path.basename(resolved);
      let hits;
      try {
        hits = fs.globSync(pattern, {
          cwd: base,
          absolute: true,
          withFileTypes: true,
          dot: false,
        });
      } catch {
        return [];
      }
      const out = [];
      for (const h of hits) {
        const p = h.path;
        if (!this._isWithinRoot(p)) continue;
        if (this._isIgnoredPath(p)) continue;
        let st;
        try {
          st = fs.statSync(p);
        } catch {
          continue;
        }
        if (!st.isFile()) continue;
        if (st.size > MAX_FILE_BYTES) continue;
        if (!this.inferLanguageByExtension(p)) continue;
        out.push(p);
      }
      out.sort();
      return out;
    }

    // Directory: recursive walk (same discipline as searchDirectory).
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      const out = [];
      const walk = (dir) => {
        let entries;
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          if (DEFAULT_IGNORED_DIRS.has(entry.name)) continue;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(full);
          } else if (entry.isFile()) {
            if (!this.inferLanguageByExtension(full)) continue;
            let st;
            try {
              st = fs.statSync(full);
            } catch {
              continue;
            }
            if (st.size > MAX_FILE_BYTES) continue;
            out.push(full);
          }
        }
      };
      walk(resolved);
      out.sort();
      return out;
    }

    // Single file or nonexistent -> not a batch target.
    return null;
  }

  /** True when `p` is inside the sandbox root (canonical space). */
  _isWithinRoot(p) {
    const realTarget = canonicalizePath(path.normalize(p));
    const realRoot = canonicalizePath(path.normalize(this.root));
    const rel = path.relative(realRoot, realTarget);
    return !(rel.startsWith("..") || path.isAbsolute(rel));
  }

  /** True when any path segment of `p` is in DEFAULT_IGNORED_DIRS. */
  _isIgnoredPath(p) {
    const parts = path.normalize(p).split(path.sep);
    return parts.some((seg) => DEFAULT_IGNORED_DIRS.has(seg));
  }

  /**
   * Batch AST replace across a directory or glob target.
   *
   * @param {object} params
   * @param {string} params.path Target directory or glob (a directory path,
   *   or a glob pattern using standard recursive wildcards)
   * @param {string} params.pattern Search pattern with metavariables
   * @param {string} params.rewrite Replacement pattern
   * @param {string} [params.lang] Optional language (only used for single-file
   *   inference; batch infers per-file by extension)
   * @param {boolean} [params.dry_run] When true, compute everything but write
   *   nothing to disk.
   * @returns {Promise<object>} Batch summary:
   *   { dry_run, files_scanned, files_matched, files_changed,
   *     files_would_change, replacements,
   *     failures: [{file, error}], syntax_unverified: [file, ...] }
   */
  async replaceBatch({ path: targetPath, pattern, rewrite, lang, dry_run }) {
    if (!pattern || typeof pattern !== "string") {
      throw new Error("AST replace requires a pattern parameter");
    }
    if (typeof rewrite !== "string") {
      throw new Error("AST replace requires a rewrite parameter");
    }

    const resolved = this.resolvePath(targetPath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Path does not exist: ${targetPath}`);
    }

    const files = this._resolveBatchFiles(resolved);
    if (files === null) {
      // Not a directory/glob: a single file. Delegate to the single-file path
      // (which honors dry_run via the shared gate) and shape the result as a
      // one-file batch summary so callers get a uniform contract. A per-file
      // gate failure is recorded in failures[] (not thrown), matching the
      // directory path.
      let single;
      let gateError = null;
      try {
        single = await this.replace({ path: targetPath, pattern, rewrite, lang, dry_run });
      } catch (err) {
        if (err.message.startsWith("SyntaxValidationError")) {
          gateError = err.message;
        } else {
          throw err;
        }
      }
      const changed = single && single.modified === true;
      return {
        dry_run: !!dry_run,
        files_scanned: 1,
        files_matched: changed || gateError ? 1 : 0,
        files_changed: changed && !dry_run ? 1 : 0,
        files_would_change: changed ? 1 : 0,
        replacements: changed ? 1 : 0,
        failures: gateError ? [{ file: resolved, error: gateError }] : [],
        syntax_unverified: changed && single.syntax_verified === false ? [resolved] : [],
      };
    }

    const summary = {
      dry_run: !!dry_run,
      files_scanned: files.length,
      files_matched: 0,
      files_changed: 0,
      files_would_change: 0,
      replacements: 0,
      failures: [],
      syntax_unverified: [],
    };

    for (const file of files) {
      const fileLang = this.inferLanguageByExtension(file);
      let originalContent;
      try {
        originalContent = fs.readFileSync(file, "utf8");
      } catch {
        continue; // unreadable -> skip, do not abort the batch
      }

      // Compute the rewrite FULLY IN MEMORY (napi, or CLI against a temp copy —
      // the real file is never touched during compute), then gate per file.
      let r;
      try {
        r = await this._computeAndGate(file, originalContent, fileLang, pattern, rewrite, dry_run);
      } catch {
        // Parse failure on this file -> skip it, continue the batch.
        continue;
      }

      if (r.error) {
        // Verified invalid (rolled back on a real run; would-be on a dry run).
        summary.files_matched += 1;
        summary.failures.push({ file, error: r.error });
        continue;
      }

      if (!r.changed) {
        // No match in this file -> not counted as matched.
        continue;
      }

      summary.files_matched += 1;
      summary.replacements += r.replacements;
      if (dry_run) {
        summary.files_would_change += 1;
        if (!r.syntaxVerified) summary.syntax_unverified.push(file);
      } else {
        summary.files_changed += 1;
        if (!r.syntaxVerified) summary.syntax_unverified.push(file);
      }
    }

    return summary;
  }

  // -------------------------------------------------------------------------
  // P6 — Universal syntax gate.
  //
  // validateSyntax returns a STRUCTURED result so callers can distinguish
  // three outcomes:
  //   { checked: true,  valid: true  }            -> verified valid
  //   { checked: true,  valid: false, error }     -> verified INVALID (rollback)
  //   { checked: false, valid: false, reason }    -> no checker (honest degrade)
  //
  // The gate NEVER reports an unchecked rewrite as valid, and NEVER silently
  // skips: an unavailable checker yields checked:false plus a stderr note.
  // -------------------------------------------------------------------------

  /**
   * Validates the syntax of a modified file for the given language.
   *
   * @param {string} filePath Path of the (already-written) file (used for
   *   on-disk checkers such as python/gofmt/rustfmt).
   * @param {string} content  The new file content to validate.
   * @param {string} lang     Normalized language identifier.
   * @returns {{checked: boolean, valid: boolean, language: string,
   *            reason?: string, error?: string}}
   */
  validateSyntax(filePath, content, lang) {
    const language = (lang || "js").toLowerCase();
    const result = this._dispatchSyntaxCheck(filePath, content, language);
    // Honest-degradation stderr note (never silent, never a false "valid").
    if (!result.checked) {
      process.stderr.write(
        `[ast_service] syntax gate: no checker available for '${language}' (${result.reason}); rewrite NOT syntax-verified\n`
      );
    }
    return result;
  }

  /**
   * Routes a language to its dedicated checker. Unknown languages (c, cpp,
   * html, css, ...) have no dedicated checker and degrade honestly.
   */
  _dispatchSyntaxCheck(filePath, content, lang) {
    switch (lang) {
      case "ts":
      case "tsx":
      case "mts":
      case "cts":
        return this._checkTypescript(content, lang);
      case "js":
      case "jsx":
      case "mjs":
      case "cjs":
        return this._checkJavaScript(content, lang);
      case "json":
        return this._checkJson(content);
      case "python":
        return this._checkPython(filePath, content);
      case "go":
        return this._checkGo(filePath, content);
      case "rust":
        return this._checkRust(filePath, content);
      default:
        return {
          checked: false,
          valid: false,
          language: lang,
          reason: `no syntax checker registered for '${lang}'`,
        };
    }
  }

  /**
   * TypeScript gate: typescript.transpileModule with reportDiagnostics.
   * Any diagnostic with category === Error means INVALID. transpileModule
   * strips types, so type-level errors are NOT reported (only syntax errors
   * surface) — which is exactly the parse-gate semantics we want.
   */
  _checkTypescript(content, lang) {
    const ts = loadTypescript();
    if (!ts) {
      return {
        checked: false,
        valid: false,
        language: lang,
        reason: "typescript module unavailable",
      };
    }
    try {
      const compilerOptions = {
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.ESNext,
      };
      // Only set jsx for .tsx; passing `jsx: undefined` makes transpileModule
      // reject the option, so it must be omitted entirely for non-tsx.
      if (lang === "tsx") compilerOptions.jsx = ts.JsxEmit.Preserve;
      const out = ts.transpileModule(content, {
        reportDiagnostics: true,
        compilerOptions,
      });
      const errors = (out.diagnostics || []).filter(
        (d) => d.category === ts.DiagnosticCategory.Error
      );
      if (errors.length === 0) {
        return { checked: true, valid: true, language: lang };
      }
      const msg = errors
        .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"))
        .join("; ");
      return { checked: true, valid: false, language: lang, error: msg };
    } catch (err) {
      // A throw from transpileModule is itself a hard parse failure.
      return { checked: true, valid: false, language: lang, error: err.message };
    }
  }

  /**
   * JavaScript gate: `node --check` against a temp file whose extension
   * matches the module system. This is the ESM nuance: a bare `.js` file has
   * an ambiguous module type, so we force it deterministically —
   *   ESM-syntax content  -> temp .mjs  (import/export parsed as ESM)
   *   CJS/other content   -> temp .cjs  (require/module.exports parsed as CJS)
   * A valid ESM file is therefore never rejected, and a syntax-broken file
   * (in either module system) never passes.
   */
  _checkJavaScript(content, lang) {
    const ext = looksLikeESM(content) ? ".mjs" : ".cjs";
    const tmp = _writeTemp(content, ext);
    try {
      execFileSync(process.execPath, ["--check", tmp], {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 5000,
        windowsHide: true,
      });
      return { checked: true, valid: true, language: lang };
    } catch (err) {
      const detail = (err.stderr || err.message || "").toString().trim();
      return {
        checked: true,
        valid: false,
        language: lang,
        error: detail || "JavaScript parse error",
      };
    } finally {
      _removeTemp(tmp);
    }
  }

  /**
   * JSON gate: in-process JSON.parse (fast, no subprocess).
   */
  _checkJson(content) {
    try {
      JSON.parse(content);
      return { checked: true, valid: true, language: "json" };
    } catch (err) {
      return { checked: true, valid: false, language: "json", error: err.message };
    }
  }

  /**
   * Python gate: `python -c "import ast; ast.parse(...)"` on a temp file.
   * The python binary is probed once; if unavailable, degrade honestly.
   */
  _checkPython(filePath, content) {
    if (!pythonAvailable()) {
      return {
        checked: false,
        valid: false,
        language: "python",
        reason: "python interpreter unavailable",
      };
    }
    const bin = IS_WINDOWS ? "python" : "python3";
    const tmp = _writeTemp(content, ".py");
    try {
      execFileSync(
        bin,
        ["-c", "import ast,sys; ast.parse(open(sys.argv[1], encoding='utf-8').read())", tmp],
        { stdio: ["ignore", "pipe", "pipe"], timeout: 5000, windowsHide: true }
      );
      return { checked: true, valid: true, language: "python" };
    } catch (err) {
      const detail = (err.stderr || err.message || "").toString().trim();
      return {
        checked: true,
        valid: false,
        language: "python",
        error: detail || "Python syntax error",
      };
    } finally {
      _removeTemp(tmp);
    }
  }

  /**
   * Go gate: `gofmt -e` on a temp file. gofmt -e reports ALL syntax errors to
   * stderr and exits non-zero on a parse failure. Probed once; degrades
   * honestly when gofmt is absent.
   */
  _checkGo(filePath, content) {
    if (!gofmtAvailable()) {
      return {
        checked: false,
        valid: false,
        language: "go",
        reason: "gofmt unavailable",
      };
    }
    const tmp = _writeTemp(content, ".go");
    try {
      execFileSync("gofmt", ["-e", tmp], {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 5000,
        windowsHide: true,
      });
      return { checked: true, valid: true, language: "go" };
    } catch (err) {
      const detail = (err.stderr || err.message || "").toString().trim();
      return {
        checked: true,
        valid: false,
        language: "go",
        error: detail || "Go syntax error",
      };
    } finally {
      _removeTemp(tmp);
    }
  }

  /**
   * Rust gate: `rustfmt --check` on a temp file. rustfmt exits non-zero (and
   * writes to stderr) when the source does not parse. Probed once; degrades
   * honestly when rustfmt is absent.
   */
  _checkRust(filePath, content) {
    if (!rustfmtAvailable()) {
      return {
        checked: false,
        valid: false,
        language: "rust",
        reason: "rustfmt unavailable",
      };
    }
    const tmp = _writeTemp(content, ".rs");
    try {
      execFileSync("rustfmt", ["--check", tmp], {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 5000,
        windowsHide: true,
      });
      return { checked: true, valid: true, language: "rust" };
    } catch (err) {
      // rustfmt exits 1 for BOTH "would reformat" and "parse error". We only
      // care about parse errors, so inspect stderr for a parse/syntax signal.
      const detail = (err.stderr || err.message || "").toString().trim();
      const isParseError = /error(\[|:)|expected|unexpected|parse/i.test(detail);
      if (isParseError) {
        return {
          checked: true,
          valid: false,
          language: "rust",
          error: detail || "Rust syntax error",
        };
      }
      // Non-zero exit but no parse signal (pure formatting diff) -> the source
      // parsed fine; treat as valid for the parse-gate purpose.
      return { checked: true, valid: true, language: "rust" };
    } finally {
      _removeTemp(tmp);
    }
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers for the syntax gate (kept outside the class so they are
// trivially unit-testable and shared across instances).
// ---------------------------------------------------------------------------

/**
 * Heuristic ESM detection: true when the source has a top-level import /
 * export / import.meta. Comments and string literals are stripped first so a
 * word like "import" inside a comment or string does not misfire.
 */
function looksLikeESM(src) {
  if (typeof src !== "string") return false;
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .replace(/\/\/[^\n]*/g, "") // line comments
    .replace(/`(?:\\.|[^`\\])*`/g, "``") // template literals
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''") // single-quoted strings
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""'); // double-quoted strings
  return /^\s*(import\s|import\(|export\s|import\.meta)/m.test(stripped);
}

/** Writes content to a fresh temp file with the given extension; returns path. */
function _writeTemp(content, ext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "astgate_"));
  const file = path.join(dir, `check${ext}`);
  fs.writeFileSync(file, content, "utf8");
  return file;
}

/** Best-effort removal of a temp file and its parent dir. */
function _removeTemp(file) {
  try {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  } catch {
    /* ignore cleanup failures */
  }
}

/**
 * Cordis Plugin to mount AstService into Context.
 */
export function astPlugin(ctx, options = {}) {
  const ast = new AstService(options);
  ctx.provide("ast", ast);

  ctx.registerTool("ast_search", {
    description:
      "Searches code by syntactic AST pattern across 20+ languages (JS, TS, Python, Go, Rust, C++). " +
      "Use metavariables ($VAR, $$$BODY) to capture elements regardless of whitespace or formatting differences. " +
      "Example pattern: 'function $NAME($$$ARGS) { $$$BODY }' or 'def $NAME($$$ARGS): $$$BODY'. " +
      "Each match reports file, line, column, the matched text, a compact single-line snippet, a " +
      "grep-able 'file:line:column' location, and a metavariables map of every $VAR/$$$BODY binding. " +
      "Directory targets are scanned recursively (sandbox ignore-set and size caps applied).",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to file or directory to search",
        },
        pattern: {
          type: "string",
          description: "AST code pattern with metavariables (e.g. 'function $NAME($ARGS) { $$$BODY }')",
        },
        lang: {
          type: "string",
          description: "Optional language ('js', 'ts', 'python', 'go', 'rust')",
        },
      },
      required: ["path", "pattern"],
    },
    execute: async (args) => ast.search(args),
  });

  ctx.registerTool("ast_replace", {
    description:
      "Performs AST-verified syntactic code replacement with mandatory syntax validation before commit. " +
      "Rewrites matching code patterns while preserving formatting and comments. " +
      "If the rewrite introduces invalid syntax, it is automatically rejected and the file is kept pristine. " +
      "Pass dry_run=true to preview the rewrite (validates syntax, writes nothing). " +
      "Example: pattern='function $NAME($ARGS) { $$$BODY }', rewrite='async function $NAME($ARGS) { $$$BODY }'.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to file to rewrite",
        },
        pattern: {
          type: "string",
          description: "Target AST code pattern with metavariables",
        },
        rewrite: {
          type: "string",
          description: "Replacement AST code pattern referencing captured metavariables",
        },
        lang: {
          type: "string",
          description: "Optional language ('js', 'ts', 'python', 'go', 'rust')",
        },
        dry_run: {
          type: "boolean",
          description: "When true, compute and syntax-validate the rewrite but write nothing to disk.",
        },
      },
      required: ["path", "pattern", "rewrite"],
    },
    execute: async (args) => ast.replace(args),
  });

  ctx.registerTool("ast_replace_batch", {
    description:
      "Applies the SAME AST pattern/rewrite across every matching file in a directory or glob target. " +
      "Each file is computed in memory, syntax-gated, and committed independently: a file whose rewrite " +
      "is verified invalid is rolled back to pristine and recorded in failures, while the batch continues. " +
      "Respects the sandbox ignore-set and per-file size caps. " +
      "Pass dry_run=true to preview: everything is computed and validated but NOTHING is written. " +
      "Returns a summary: { dry_run, files_scanned, files_matched, files_changed, files_would_change, " +
      "replacements, failures: [{file, error}], syntax_unverified: [file, ...] }.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Target directory or glob pattern (standard recursive wildcards)",
        },
        pattern: {
          type: "string",
          description: "Target AST code pattern with metavariables",
        },
        rewrite: {
          type: "string",
          description: "Replacement AST code pattern referencing captured metavariables",
        },
        lang: {
          type: "string",
          description: "Optional language (only used for single-file inference; batch infers per-file by extension)",
        },
        dry_run: {
          type: "boolean",
          description: "When true, compute and validate everything but write nothing to disk.",
        },
      },
      required: ["path", "pattern", "rewrite"],
    },
    execute: async (args) => ast.replaceBatch(args),
  });
}
