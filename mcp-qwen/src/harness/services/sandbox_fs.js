/**
 * Sandboxed Filesystem Service (DeepSeek Harness Inspired)
 *
 * Enforces:
 * - Strict .ignore policies (auto-skips .venv, node_modules, .git, __pycache__)
 * - Cross-mount path normalization (Windows D:\ <-> WSL /mnt/d/)
 * - AST file edits and targeted slice reads
 * - Fast indexed searches without DrvFs stalls
 */

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { IS_WINDOWS } from "../../config.js";
import { normalizeWorkspacePath, toWindowsPath, toPosixWslPath } from "../../wsl_bridge.js";

const execFileAsync = promisify(execFile);

export const DEFAULT_IGNORED_DIRS = new Set([
  ".venv",
  "venv",
  "node_modules",
  ".git",
  "__pycache__",
  "target",
  "dist",
  "build",
  "vendor",
  ".idea",
  ".vscode",
]);

export class SandboxFsService {
  constructor(options = {}) {
    this.root = options.root ? normalizeWorkspacePath(options.root) : process.cwd();
    this.ignoredDirs = new Set([...DEFAULT_IGNORED_DIRS, ...(options.ignoredDirs || [])]);
  }

  /**
   * Resolves and verifies that a target path is safely within allowed boundaries.
   * @param {string} inputPath
   * @returns {string} Normalized absolute path
   */
  resolvePath(inputPath) {
    if (!inputPath) return this.root;
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
    const normalizedTarget = path.normalize(p);
    const normalizedRoot = path.normalize(this.root);
    const rel = path.relative(normalizedRoot, normalizedTarget);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`PathEscapeError: Access denied. Path '${inputPath}' escapes sandbox root '${this.root}'`);
    }
    return normalizedTarget;
  }

  /**
   * Reads a slice of a file with line numbers.
   */
  async readFile({ path: filePath, start_line = 1, end_line = null, max_bytes = 64_000 }) {
    const resolved = this.resolvePath(filePath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`File not found: ${filePath}`);
    }
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      throw new Error(`Path is a directory, not a file: ${filePath}`);
    }

    const raw = fs.readFileSync(resolved, "utf8");
    const allLines = raw.split("\n");
    const totalLines = allLines.length;

    const startIdx = Math.max(0, (start_line || 1) - 1);
    const endIdx = end_line ? Math.min(totalLines, end_line) : Math.min(totalLines, startIdx + 800);

    const slice = allLines.slice(startIdx, endIdx);
    const numbered = slice
      .map((line, idx) => `${startIdx + idx + 1}: ${line}`)
      .join("\n");

    return {
      path: resolved,
      total_lines: totalLines,
      showing_range: [startIdx + 1, endIdx],
      content: numbered.slice(0, max_bytes),
    };
  }

  /**
   * Writes or overwrites a file.
   */
  async writeFile({ path: filePath, content, overwrite = true }) {
    if (!filePath || typeof filePath !== "string" || filePath.trim().length === 0) {
      throw new Error("InvalidPathError: filePath parameter is required and must be a non-empty string");
    }
    const resolved = this.resolvePath(filePath);
    if (resolved === path.normalize(this.root)) {
      throw new Error(`InvalidPathError: Target path '${filePath}' resolves to the workspace root directory, not a file`);
    }
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      throw new Error(`InvalidPathError: Target path '${filePath}' is an existing directory, cannot overwrite as file`);
    }
    if (fs.existsSync(resolved) && !overwrite) {
      throw new Error(`File already exists and overwrite is false: ${filePath}`);
    }
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, content, "utf8");
    return { path: resolved, bytes_written: Buffer.byteLength(content, "utf8"), success: true };
  }

  /**
   * Performs an exact text replacement in a file.
   */
  async editFile({ path: filePath, target_content, replacement_content, allow_multiple = false }) {
    if (!target_content || typeof target_content !== "string" || target_content.length === 0) {
      throw new Error("target_content cannot be empty");
    }
    const resolved = this.resolvePath(filePath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`File not found for edit: ${filePath}`);
    }
    const original = fs.readFileSync(resolved, "utf8");
    const occurrences = original.split(target_content).length - 1;

    if (occurrences === 0) {
      throw new Error(`Target content not found in file: ${filePath}`);
    }
    if (occurrences > 1 && !allow_multiple) {
      throw new Error(
        `Target content found ${occurrences} times in file: ${filePath}. Specify allow_multiple: true or provide more surrounding context.`
      );
    }

    const updated = allow_multiple
      ? original.replaceAll(target_content, replacement_content)
      : original.replace(target_content, replacement_content);

    fs.writeFileSync(resolved, updated, "utf8");
    return {
      path: resolved,
      occurrences_replaced: occurrences,
      success: true,
    };
  }

  /**
   * Lists directory contents while strictly filtering out ignored directories.
   */
  async listDir({ path: dirPath = ".", max_depth = 2 }) {
    const resolved = this.resolvePath(dirPath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Directory not found: ${dirPath}`);
    }

    const walk = (currentDir, depth) => {
      if (depth > max_depth) return [];
      const entries = [];
      let files = [];
      try {
        files = fs.readdirSync(currentDir, { withFileTypes: true });
      } catch {
        return [];
      }

      for (const f of files) {
        if (this.ignoredDirs.has(f.name)) continue;
        const full = path.join(currentDir, f.name);
        const rel = path.relative(resolved, full);
        if (f.isDirectory()) {
          entries.push({ name: f.name, path: rel, type: "dir" });
          entries.push(...walk(full, depth + 1));
        } else {
          entries.push({ name: f.name, path: rel, type: "file" });
        }
      }
      return entries;
    };

    const items = walk(resolved, 1);
    return { path: resolved, total_items: items.length, items };
  }

  /**
   * Fast indexed search using git grep (respecting .gitignore) or fallback file search.
   */
  async searchCode({ query, dirPath = ".", max_results = 50 }) {
    const resolved = this.resolvePath(dirPath);
    try {
      // Use git grep first (inherently avoids .venv and node_modules)
      const { stdout } = await execFileAsync("git", ["grep", "-n", "-I", "--max-count", String(max_results), query], {
        cwd: resolved,
        timeout: 10_000,
      });
      const lines = stdout.trim().split("\n").filter(Boolean);
      return {
        query,
        count: lines.length,
        matches: lines.slice(0, max_results),
      };
    } catch {
      // Fallback: search files avoiding ignored directories
      const matches = [];
      const walkSearch = (cur) => {
        if (matches.length >= max_results) return;
        let files;
        try {
          files = fs.readdirSync(cur, { withFileTypes: true });
        } catch {
          return;
        }
        for (const f of files) {
          if (matches.length >= max_results) break;
          if (this.ignoredDirs.has(f.name)) continue;
          const full = path.join(cur, f.name);
          if (f.isDirectory()) {
            walkSearch(full);
          } else if (f.isFile() && f.size < 500_000) {
            try {
              const text = fs.readFileSync(full, "utf8");
              if (text.includes(query)) {
                const lines = text.split("\n");
                lines.forEach((l, idx) => {
                  if (l.includes(query) && matches.length < max_results) {
                    matches.push(`${path.relative(resolved, full)}:${idx + 1}: ${l.trim().slice(0, 200)}`);
                  }
                });
              }
            } catch {}
          }
        }
      };
      walkSearch(resolved);
      return { query, count: matches.length, matches };
    }
  }
}

/**
 * Cordis Plugin to mount SandboxFsService and its tools into Context.
 */
export function sandboxFsPlugin(ctx, options = {}) {
  const fsService = new SandboxFsService(options);
  ctx.provide("fs", fsService);

  ctx.registerTool("read_file", {
    description: "Read a slice of a text file with line numbers (safe, bounded)",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path" },
        start_line: { type: "integer", description: "1-indexed starting line", default: 1 },
        end_line: { type: "integer", description: "1-indexed ending line (optional)" },
      },
      required: ["path"],
    },
    execute: (args) => fsService.readFile(args),
  });

  ctx.registerTool("write_file", {
    description: "Create or overwrite a file with full content",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path" },
        content: { type: "string", description: "File content to write" },
        overwrite: { type: "boolean", description: "Whether to overwrite existing file", default: true },
      },
      required: ["path", "content"],
    },
    execute: (args) => fsService.writeFile(args),
  });

  ctx.registerTool("edit_file", {
    description: "Perform exact text search-and-replace in a file",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path" },
        target_content: { type: "string", description: "Exact character sequence to replace" },
        replacement_content: { type: "string", description: "Replacement content" },
        allow_multiple: { type: "boolean", description: "Whether to replace multiple occurrences", default: false },
      },
      required: ["path", "target_content", "replacement_content"],
    },
    execute: (args) => fsService.editFile(args),
  });

  ctx.registerTool("list_dir", {
    description: "List directory contents while auto-ignoring .venv, node_modules, and .git",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path", default: "." },
        max_depth: { type: "integer", description: "Recursion depth", default: 2 },
      },
    },
    execute: (args) => fsService.listDir(args),
  });

  ctx.registerTool("search_code", {
    description: "Fast code search across the codebase avoiding ignored directories",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Literal string to search for" },
        path: { type: "string", description: "Root search directory", default: "." },
      },
      required: ["query"],
    },
    execute: (args) => fsService.searchCode(args),
  });
}
