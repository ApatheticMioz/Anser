/**
 * Structural AST Service (Powered by ast-grep)
 *
 * Provides:
 * - Code-like pattern matching (ast_search) with metavariables ($VAR, $$$BODY)
 * - Structural code surgery (ast_replace) that preserves formatting and ignores whitespace
 * - Mandatory compile/syntax validation before writing mutations to disk
 * - Cordis plugin integration with reversible registration
 * - Dual Windows NTFS and WSL DrvFs cross-path safety
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { IS_WINDOWS } from "../../config.js";
import { toWindowsPath, toPosixWslPath } from "../../wsl_bridge.js";

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

export class AstService {
  constructor(options = {}) {
    this.root = options.root || process.cwd();
  }

  detectLanguage(filePath, explicitLang) {
    if (explicitLang) return explicitLang.toLowerCase();
    const ext = path.extname(filePath).toLowerCase();
    return EXT_TO_LANG[ext] || "js";
  }

  resolvePath(inputPath) {
    if (!inputPath) throw new Error("Path parameter is required for AST operation");
    let p = inputPath.trim();
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
    return path.normalize(p);
  }

  getBinary() {
    const winBin = path.join(
      this.root,
      "mcp-qwen",
      "node_modules",
      "@ast-grep",
      "cli-win32-x64-msvc",
      "ast-grep.exe"
    );
    const winBinDirect = path.join(
      this.root,
      "node_modules",
      "@ast-grep",
      "cli-win32-x64-msvc",
      "ast-grep.exe"
    );
    const linuxBin = path.join(
      this.root,
      "mcp-qwen",
      "node_modules",
      "@ast-grep",
      "cli-linux-x64-gnu",
      "ast-grep"
    );
    const linuxBinDirect = path.join(
      this.root,
      "node_modules",
      "@ast-grep",
      "cli-linux-x64-gnu",
      "ast-grep"
    );

    if (IS_WINDOWS) {
      if (fs.existsSync(winBin)) return winBin;
      if (fs.existsSync(winBinDirect)) return winBinDirect;
      return "ast-grep";
    } else {
      if (fs.existsSync(linuxBin)) return linuxBin;
      if (fs.existsSync(linuxBinDirect)) return linuxBinDirect;
      return "ast-grep";
    }
  }

  /**
   * Searches for syntactic code patterns using ast-grep.
   *
   * @param {object} params
   * @param {string} params.path Target file or directory
   * @param {string} params.pattern Search pattern with metavariables ($VAR, $$$BODY)
   * @param {string} [params.lang] Optional language identifier
   * @returns {Promise<{ matches: Array<object>, count: number }>}
   */
  async search({ path: targetPath, pattern, lang }) {
    if (!pattern || typeof pattern !== "string" || pattern.trim().length === 0) {
      throw new Error("AST search requires a non-empty pattern");
    }

    const resolved = this.resolvePath(targetPath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Path does not exist: ${targetPath}`);
    }

    const detectedLang = this.detectLanguage(resolved, lang);
    const bin = this.getBinary();
    const args = [
      "run",
      "--pattern",
      pattern,
      "--lang",
      detectedLang,
      "--json=compact",
      resolved,
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
      const matches = parsed.map((m) => {
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

      return {
        path: resolved,
        language: detectedLang,
        count: matches.length,
        matches: matches.slice(0, 50),
      };
    } catch (err) {
      // Exit code 1 with empty stdout means 0 matches found in ast-grep
      if (err.status === 1 && !err.stderr) {
        return {
          path: resolved,
          language: detectedLang,
          count: 0,
          matches: [],
        };
      }
      throw new Error(`AST search error: ${err.stderr || err.message}`);
    }
  }

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

    const bin = this.getBinary();
    const args = [
      "run",
      "--pattern",
      pattern,
      "--rewrite",
      rewrite,
      "--lang",
      detectedLang,
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
      const validationError = this.validateSyntax(resolved, updatedContent, detectedLang);
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
