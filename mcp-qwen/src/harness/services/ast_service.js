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
import { execFileSync } from "node:child_process";
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
   * In-process napi search. Produces the exact same match shape as the CLI path:
   * { file, line, column, text, metavariables }. Both engines report 0-indexed
   * line / 0-indexed column, so the values pass through unchanged.
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
      return {
        file: fileLabel,
        // Both the CLI --json=compact and napi report 0-indexed line / 0-indexed
        // column. Pass through raw so the napi path is byte-identical to the CLI
        // path (the existing tool-result contract).
        line: range.start.line,
        column: range.start.column,
        text: m.text(),
        metavariables: mv,
      };
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
        return {
          file: m.file,
          line: m.range?.start?.line ?? 1,
          column: m.range?.start?.column ?? 1,
          text: m.text,
          metavariables: mv,
        };
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
  async replace({ path: targetPath, pattern, rewrite, lang }) {
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
      return this.napiReplace(engine, resolved, originalContent, detectedLang, pattern, rewrite);
    }
    return this.cliReplace(resolved, originalContent, detectedLang, pattern, rewrite);
  }

  /**
   * In-process napi replace. Performs the same template-substitution rewrite the
   * CLI `--rewrite` does, then reuses the exact same validateSyntax gate and
   * pristine-rollback behavior as the CLI path.
   */
  napiReplace(engine, resolved, originalContent, lang, pattern, rewrite) {
    const root = engine.parse(lang, originalContent);
    const rootNode = root.root();
    const config = engine.pattern(lang, pattern);
    const matches = rootNode.findAll(config);
    const { single, multi } = extractMetaVars(pattern);

    const edits = [];
    for (const m of matches) {
      // Build substitution table; longer tokens first so a single-var name that
      // is a substring of a multi-var token (e.g. $A vs $$$AB) is not corrupted.
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

    const newContent = rootNode.commitEdits(edits);
    if (newContent === originalContent) {
      return {
        path: resolved,
        modified: false,
        message: `Pattern '${pattern}' did not match any AST nodes in ${path.basename(resolved)}. File unchanged.`,
      };
    }

    fs.writeFileSync(resolved, newContent, "utf8");

    // Mandatory compile/parse check on the newly written file (shared gate).
    const validationError = this.validateSyntax(resolved, newContent, lang);
    if (validationError) {
      // Rollback immediately to original pristine content
      fs.writeFileSync(resolved, originalContent, "utf8");
      throw new Error(
        `SyntaxValidationError: AST replacement resulted in malformed syntax (${validationError}). Disk rolled back.`
      );
    }

    return {
      path: resolved,
      modified: true,
      bytes_before: Buffer.byteLength(originalContent, "utf8"),
      bytes_after: Buffer.byteLength(newContent, "utf8"),
      message: `AST pattern '${pattern}' successfully replaced in ${path.basename(resolved)}. Syntax validated.`,
    };
  }

  /**
   * CLI replace (fallback). Preserves the original behavior exactly, including
   * the exit-1/empty-stdout "no matches" handling and the syntax gate/rollback.
   */
  cliReplace(resolved, originalContent, lang, pattern, rewrite) {
    const bin = this.getBinary();
    const args = [
      "run",
      "--pattern",
      pattern,
      "--rewrite",
      rewrite,
      "--lang",
      lang,
      "--update-all",
      resolved,
    ];

    try {
      execFileSync(bin, args, {
        cwd: this.root,
        encoding: "utf8",
        timeout: 30_000,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });

      const updatedContent = fs.readFileSync(resolved, "utf8");
      if (updatedContent === originalContent) {
        return {
          path: resolved,
          modified: false,
          message: `Pattern '${pattern}' did not match any AST nodes in ${path.basename(resolved)}. File unchanged.`,
        };
      }

      // Mandatory compile/parse check on the newly written file
      const validationError = this.validateSyntax(resolved, updatedContent, lang);
      if (validationError) {
        // Rollback immediately to original pristine content
        fs.writeFileSync(resolved, originalContent, "utf8");
        throw new Error(
          `SyntaxValidationError: AST replacement resulted in malformed syntax (${validationError}). Disk rolled back.`
        );
      }

      return {
        path: resolved,
        modified: true,
        bytes_before: Buffer.byteLength(originalContent, "utf8"),
        bytes_after: Buffer.byteLength(updatedContent, "utf8"),
        message: `AST pattern '${pattern}' successfully replaced in ${path.basename(resolved)}. Syntax validated.`,
      };
    } catch (err) {
      if (err.message.startsWith("SyntaxValidationError")) {
        throw err;
      }
      if (err.status === 1 && !err.stderr) {
        return {
          path: resolved,
          modified: false,
          message: `Pattern '${pattern}' not found in ${path.basename(resolved)}. Try a broader pattern or edit_file.`,
        };
      }
      throw new Error(`AST replace error: ${err.stderr || err.message}`);
    }
  }

  /**
   * Validates syntax of a modified file.
   * Returns null if valid, or an error description string if invalid.
   */
  validateSyntax(filePath, content, lang) {
    if (["js", "jsx", "ts", "tsx"].includes(lang)) {
      try {
        // For JS, quick node check
        if (lang === "js") {
          execFileSync(process.execPath, ["--check", filePath], {
            timeout: 5000,
            stdio: "ignore",
          });
        }
        return null;
      } catch (err) {
        return err.message || "JavaScript parse error";
      }
    }

    if (lang === "python") {
      try {
        const pythonBin = IS_WINDOWS ? "python" : "python3";
        execFileSync(pythonBin, ["-m", "py_compile", filePath], {
          timeout: 5000,
          stdio: "ignore",
        });
        return null;
      } catch (err) {
        return err.message || "Python syntax error";
      }
    }

    return null;
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
      "Example pattern: 'function $NAME($ARGS) { $$$BODY }' or 'def $NAME($$$ARGS): $$$BODY'.",
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
      },
      required: ["path", "pattern", "rewrite"],
    },
    execute: async (args) => ast.replace(args),
  });
}
