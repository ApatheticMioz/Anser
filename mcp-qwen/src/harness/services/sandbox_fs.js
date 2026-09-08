/**
 * Sandboxed Filesystem Service (Anser Sandboxed Filesystem)
 *
 * Enforces:
 * - Strict .ignore policies (auto-skips .venv, node_modules, .git, __pycache__)
 * - Cross-mount path normalization (Windows D:\ <-> WSL /mnt/d/)
 * - AST file edits and targeted slice reads
 * - Fast indexed searches without DrvFs stalls
 */

import fs from "node:fs";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { IS_WINDOWS } from "../../config.js";
import { normalizeWorkspacePath, toWindowsPath, toPosixWslPath, canonicalizePath } from "../../wsl_bridge.js";

const execFileAsync = promisify(execFile);

/**
 * F-2 / §2.8 Fail-Fast: raised when `git grep` fails with a FATAL error
 * (any non-zero exit code other than 1) while operating inside a git
 * repository. Exit code 1 means "no matches" (a valid empty result) and is
 * NOT an error. A fatal error (e.g. 128 on a corrupted repository) must fail
 * fast with this explicit error rather than falling through to the manual
 * directory walk, which would read gitignored files (e.g. `.env`) and leak
 * secrets into the model context.
 *
 * @extends Error
 * @property {number|null} code The git process exit code (e.g. 128).
 * @property {string} stderr The trimmed stderr output from git.
 */
export class GitGrepError extends Error {
  constructor(message, { code = null, stderr = "" } = {}) {
    super(message);
    this.name = "GitGrepError";
    this.code = code;
    this.stderr = stderr;
  }
}

/**
 * F-5: raised when the `patch` payload to `applyPatch()` exceeds the maximum
 * allowed size (see `MAX_PATCH_SIZE`). The check runs BEFORE any `git`
 * subprocess is spawned, so an oversized patch is rejected cheaply without a
 * child process.
 *
 * @extends Error
 * @property {number} size The actual byte length of the patch payload.
 * @property {number} limit The maximum allowed byte length.
 */
export class PatchTooLargeError extends Error {
  constructor(message, { size = 0, limit = 0 } = {}) {
    super(message);
    this.name = "PatchTooLargeError";
    this.size = size;
    this.limit = limit;
  }
}

/**
 * F-5 / §2.8: raised when the `git apply` subprocess is killed by the timeout
 * (or otherwise terminated by a signal) rather than failing on patch content.
 * Node's `execFileSync` reports a timeout as `err.code === "ETIMEDOUT"` and
 * `err.signal === "SIGTERM"` (and `err.killed === true` on some platforms), so
 * this error is emitted for any of those signals. It is deliberately distinct
 * from the generic `GitApplyError` so a hang/timeout is distinguishable from a
 * normal "patch does not apply" failure (honest error signal, §2.8).
 *
 * @extends Error
 * @property {string|null} signal The termination signal (e.g. "SIGTERM").
 * @property {string} stderr The trimmed stderr output from git, if any.
 */
export class GitApplyTimeoutError extends Error {
  constructor(message, { signal = null, stderr = "" } = {}) {
    super(message);
    this.name = "GitApplyTimeoutError";
    this.signal = signal;
    this.stderr = stderr;
  }
}

/**
 * F-2: returns true for `.env` and `.env.*` files (e.g. `.env.local`,
 * `.env.production`). These are excluded from the fallback directory walk to
 * prevent accidental secret ingestion when `git grep` is unavailable.
 * @param {string} name
 */
function isEnvFile(name) {
  return name === ".env" || name.startsWith(".env.");
}

/**
 * F-4 helper: classifies the line-ending style of a string.
 *
 * Returns:
 * - "crlf"  -> contains CRLF and no bare LF
 * - "lf"    -> contains bare LF and no CRLF
 * - "mixed" -> contains both CRLF and bare LF
 * - null    -> contains no line endings at all
 *
 * Note: `\n` is a substring of `\r\n`, so a bare-LF check must first strip
 * all CRLF sequences to avoid miscounting.
 * @param {string} text
 * @returns {"crlf"|"lf"|"mixed"|null}
 */
function lineEndingStyle(text) {
  const hasCRLF = text.includes("\r\n");
  const hasBareLF = text.replace(/\r\n/g, "").includes("\n");
  if (hasCRLF && hasBareLF) return "mixed";
  if (hasCRLF) return "crlf";
  if (hasBareLF) return "lf";
  return null;
}

/**
 * F-4 helper: normalizes a string's line endings to a target style.
 * - "crlf" -> every line ending becomes CRLF
 * - "lf"   -> every CRLF becomes LF
 * - "mixed" or null -> left unchanged (no single style to normalize to)
 * @param {string} text
 * @param {"crlf"|"lf"|"mixed"|null} style
 */
function normalizeLineEndings(text, style) {
  if (style === "crlf") return text.replace(/\r?\n/g, "\r\n");
  if (style === "lf") return text.replace(/\r\n/g, "\n");
  return text;
}

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

/**
 * F-5: maximum byte length of a `patch` payload accepted by `applyPatch()`.
 * Enforced BEFORE spawning `git` (see `PatchTooLargeError`). A 2 MB cap is
 * generous for any legitimate unified diff (a 200k-line / ~3.7 MB patch was
 * observed to apply in <60 ms, so the cap only guards against pathological
 * payloads) while bounding memory and the child-process input pipe.
 */
export const MAX_PATCH_SIZE = 2 * 1024 * 1024; // 2 MB

export class SandboxFsService {
  constructor(options = {}) {
    // P4i: canonicalize the sandbox root through the OS symlink/junction
    // resolution layer so that a junction/symlink cwd (e.g. D:\mnt\d -> D:\)
    // is stored as its real path. Containment checks then compare
    // realpath(target) against a real root, eliminating false
    // SymlinkEscapeError/PathEscapeError while still catching real escapes.
    const rawRoot = options.root ? normalizeWorkspacePath(options.root) : process.cwd();
    this.root = canonicalizePath(rawRoot);
    this.ignoredDirs = new Set([...DEFAULT_IGNORED_DIRS, ...(options.ignoredDirs || [])]);
    // F-5: timeout for the `git apply` subprocess in `applyPatch()`. Defaults
    // to 15s; overridable (e.g. by tests) to exercise the timeout path.
    this.gitApplyTimeoutMs =
      typeof options.gitApplyTimeoutMs === "number" && options.gitApplyTimeoutMs > 0
        ? options.gitApplyTimeoutMs
        : 15_000;
  }

  /**
   * Resolves and verifies that a target path is safely within allowed boundaries.
   * @param {string} inputPath
   * @returns {string} Normalized absolute path
   */
  resolvePath(inputPath) {
    if (!inputPath) return this.root;
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
    // OS symlink/junction resolution layer. This ensures that a junction-form
    // target (e.g. D:\mnt\d\LLM_Ecosystem\...) is compared against the real
    // root (D:\LLM_Ecosystem\...) in the same "real" path space, eliminating
    // false PathEscapeError/SymlinkEscapeError. Real escapes (../outside,
    // symlink-to-outside) are still caught because their realpath lands
    // outside the real root.
    const realTarget = canonicalizePath(normalizedTarget);
    const realRoot = canonicalizePath(normalizedRoot);
    const rel = path.relative(realRoot, realTarget);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`PathEscapeError: Access denied. Path '${inputPath}' escapes sandbox root '${this.root}'`);
    }

    // Symlink escape verification (both sides are now in real-path space)
    this.verifySymlinkContainment(realTarget, realRoot);

    // Return the ORIGINAL normalized path (not the canonical one) so that
    // downstream path labels stay consistent with the path the caller passed
    // in. The containment decision above was made in canonical space, which
    // is what matters for security; the returned label is used for I/O and
    // reporting (both the junction and real forms address the same file).
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
   * Performs an exact or line-ending-normalized text replacement in a file.
   *
   * Guard rules:
   * - 0 occurrences: explicit "target not found" error (no write).
   * - 1 occurrence: proceed with replacement.
   * - >1 occurrences without replace_all: refuse with count (no write).
   * - >1 occurrences with replace_all: replace all.
   *
   * F-3: `replacement_content` is validated up front. It MUST be a string.
   * An explicit empty string `""` is allowed (it deletes the matched region).
   * `undefined`/`null`/non-string values are rejected with an explicit
   * `InvalidReplacementError` so they can never be silently coerced to the
   * literal string `"undefined"` and written to disk (silent corruption).
   *
   * F-4: Line-ending auto-normalization is LOCALIZED to the matched region,
   * not a whole-file boolean. The style of the region is inferred from which
   * form of the target actually matches the file (exact / CRLF / LF). The
   * replacement is normalized to that local style, so editing one region of a
   * mixed CRLF/LF file preserves that region's endings without cross-
   * pollinating the rest of the file.
   *
   * F-14 (documented trade-off): a target whose line endings differ from the
   * file's is auto-normalized to the local style and the edit succeeds
   * silently (no `LineEndingMismatchError`). This is a deliberate convenience
   * trade-off over the prior explicit-mismatch signal; callers that want the
   * old honesty signal can pre-check the file's line endings themselves.
   */
  async editFile({ path: filePath, target_content, replacement_content, replace_all = false }) {
    if (!target_content || typeof target_content !== "string" || target_content.length === 0) {
      throw new Error("target_content cannot be empty");
    }
    // F-3: validate replacement_content BEFORE any I/O. Must be a string;
    // explicit "" is allowed (deletion). undefined/null/non-string are rejected
    // so they can never coerce to the literal "undefined" and corrupt the file.
    if (typeof replacement_content !== "string") {
      throw new Error(
        `InvalidReplacementError: replacement_content must be a string (got ${
          replacement_content === undefined ? "undefined" : typeof replacement_content
        }). Pass an explicit empty string "" to delete the matched region. No write performed.`
      );
    }
    const resolved = this.resolvePath(filePath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`File not found for edit: ${filePath}`);
    }
    const original = fs.readFileSync(resolved, "utf8");

    // F-4: determine the LOCAL line-ending style of the matched region by
    // testing which form of the target actually matches the file.
    //   1. exact match            -> the target's own endings are the local style
    //   2. CRLF-normalized match  -> region is CRLF
    //   3. LF-normalized match    -> region is LF
    //   4. none                   -> target not found
    const crlfTarget = target_content.replace(/\r?\n/g, "\r\n");
    const lfTarget = target_content.replace(/\r\n/g, "\n");
    const exactCount = original.split(target_content).length - 1;
    const crlfCount = original.split(crlfTarget).length - 1;
    const lfCount = original.split(lfTarget).length - 1;

    let effectiveTarget;
    let localStyle;
    if (exactCount > 0) {
      effectiveTarget = target_content;
      localStyle = lineEndingStyle(target_content);
    } else if (crlfCount > 0) {
      effectiveTarget = crlfTarget;
      localStyle = "crlf";
    } else if (lfCount > 0) {
      effectiveTarget = lfTarget;
      localStyle = "lf";
    } else {
      throw new Error(`Target content not found in file: ${filePath}. No write performed.`);
    }

    const occurrences = original.split(effectiveTarget).length - 1;
    if (occurrences > 1 && !replace_all) {
      throw new Error(
        `AmbiguousTargetError: target_content found ${occurrences} times in file: ${filePath}. ` +
        `Provide a longer unique target (include surrounding lines) or pass replace_all: true. No write performed.`
      );
    }

    // F-4: normalize the replacement to the LOCAL style of the matched region.
    // For a uniform file this is identical to the old whole-file behavior; for
    // a mixed file it preserves the region's own endings without cross-
    // pollinating the rest of the file.
    const effectiveReplacement = normalizeLineEndings(replacement_content, localStyle);

    const updated = replace_all
      ? original.replaceAll(effectiveTarget, effectiveReplacement)
      : original.replace(effectiveTarget, effectiveReplacement);

    fs.writeFileSync(resolved, updated, "utf8");
    return {
      path: resolved,
      occurrences_replaced: replace_all ? occurrences : 1,
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
   * F-10: pre-validates the file paths referenced by a unified diff patch so
   * the sandbox boundary is EXPLICIT rather than solely delegated to `git
   * apply` (whose handling of `../` and absolute paths is version- and
   * config-dependent).
   *
   * The target paths are extracted from each file section's `--- a/<p>` and
   * `+++ b/<p>` headers. For each path:
   *   - `/dev/null` is allowed (it denotes a newly-created or deleted file).
   *   - a leading `a/` or `b/` side marker (the standard unified-diff prefix)
   *     is stripped before validation.
   *   - a null byte is rejected.
   *   - an absolute path is rejected (the only legitimate absolute path,
   *     `/dev/null`, is handled above).
   *   - a relative path is resolved against the patch base directory and must
   *     stay within the sandbox root; a path that escapes the root (e.g.
   *     `../outside`) is rejected.
   *
   * This runs BEFORE `git` is spawned, so a malicious or malformed path is
   * rejected cheaply and deterministically.
   *
   * @param {string} patch
   * @param {string} baseDir The resolved base directory (git apply cwd).
   * @returns {string[]} the validated relative paths (for reporting).
   */
  _validatePatchPaths(patch, baseDir) {
    const root = this.root;
    const seen = new Set();
    for (const line of patch.split(/\r?\n/)) {
      let target = null;
      let m = line.match(/^---\s+(.+?)\s*$/);
      if (m) target = m[1];
      else {
        m = line.match(/^\+\+\+\s+(.+?)\s*$/);
        if (m) target = m[1];
      }
      if (target === null) continue;
      // A trailing tab-separated timestamp (e.g. "--- a/path\t2024-01-01") is
      // not part of the path.
      const tabIdx = target.indexOf("\t");
      if (tabIdx !== -1) target = target.slice(0, tabIdx);
      // /dev/null denotes a new (---) or deleted (+++) file — always allowed.
      if (target === "/dev/null") continue;
      let p = target;
      if (p.startsWith("a/") || p.startsWith("b/")) p = p.slice(2);
      if (p.includes("\0")) {
        throw new Error(
          `PatchPathError: patch path '${target}' contains a prohibited null byte. No files were modified.`
        );
      }
      if (path.isAbsolute(p)) {
        throw new Error(
          `PatchPathError: patch references an absolute path '${target}', which is not allowed. No files were modified.`
        );
      }
      const resolved = path.resolve(baseDir, p);
      const rel = path.relative(root, resolved);
      if (rel.startsWith("..") || path.isAbsolute(rel)) {
        throw new Error(
          `PatchPathError: patch path '${target}' resolves outside the sandbox root. No files were modified.`
        );
      }
      seen.add(p);
    }
    return [...seen];
  }

  /**
   * Applies a standard unified diff patch using `git apply`.
   *
   * F-5 — size cap: the `patch` payload is measured in bytes and rejected with
   * an explicit `PatchTooLargeError` BEFORE any `git` subprocess is spawned if
   * it exceeds `MAX_PATCH_SIZE` (2 MB). This bounds memory and the child
   * process input pipe for pathological payloads.
   *
   * F-5 / §2.8 — distinct timeout signal: if the `git apply` subprocess is
   * killed by the timeout (or otherwise terminated by a signal), a distinct
   * `GitApplyTimeoutError` is thrown instead of the generic `GitApplyError`,
   * so a hang/timeout is distinguishable from a normal "patch does not apply"
   * failure. Node reports a timeout as `err.code === "ETIMEDOUT"` and
   * `err.signal === "SIGTERM"` (and `err.killed === true` on some platforms);
   * all three are checked.
   *
   * F-6 — faithful whitespace: `--whitespace=fix` is intentionally NOT used.
   * That flag silently REWRITES whitespace in the applied content (e.g. it
   * strips trailing spaces and emits "line applied after fixing whitespace
   * errors"), so the on-disk result could differ from the literal patch. The
   * default `git apply` behavior writes the patch bytes faithfully (it only
   * warns about whitespace, it does not modify it), which is the honest,
   * non-rewriting behavior this tool should have.
   *
   * F-6 / F-11 — line-ending behavior is CONTEXT-DEPENDENT and is documented
   * here rather than silently assumed:
   *   (a) In a git repository whose `.gitattributes` pins
   *       `* text=auto eol=lf` (as this workspace does), `git apply`
   *       normalizes the applied content to LF on write, so a CRLF file is
   *       converted to LF. This is a property of the repo's `.gitattributes`,
   *       not of this method.
   *   (b) In a NON-git directory, `git apply` still works (it does not require
   *       a repository) but no `.gitattributes` normalization applies, so the
   *       patch bytes are written verbatim (line endings preserved as given).
   *
   * F-10 — the base directory (`dirPath`) is validated against the sandbox
   * root by `resolvePath()`, and every file path inside the patch is
   * EXPLICITLY pre-validated by `_validatePatchPaths()` before `git` is
   * spawned (rejecting `../` traversal, absolute paths, and null bytes). This
   * makes the boundary deterministic rather than relying on `git apply`'s
   * version/config-specific handling; `git apply` additionally refuses to
   * write through symlinks that escape the working tree. The adversarial
   * regression tests in `tests/apply_patch.test.js` pin this boundary.
   *
   * @param {object} args
   * @param {string} args.patch Standard unified diff patch content.
   * @param {string} [args.dirPath="."] Target base directory (sandbox-relative).
   * @returns {Promise<{success: boolean, message: string}>}
   */
  async applyPatch({ patch, dirPath = "." }) {
    if (!patch || typeof patch !== "string" || patch.trim().length === 0) {
      throw new Error("patch cannot be empty");
    }

    // F-5: enforce the size cap BEFORE spawning git.
    const patchBytes = Buffer.byteLength(patch, "utf8");
    if (patchBytes > MAX_PATCH_SIZE) {
      throw new PatchTooLargeError(
        `PatchTooLargeError: patch is ${patchBytes} bytes, exceeding the ${MAX_PATCH_SIZE} byte limit. ` +
          `No git subprocess was spawned and no files were modified.`,
        { size: patchBytes, limit: MAX_PATCH_SIZE }
      );
    }

    const resolved = this.resolvePath(dirPath);

    // F-10: explicitly validate every file path in the patch against the
    // sandbox root BEFORE invoking git, so the boundary does not depend on
    // git's version/config-specific handling of `../` and absolute paths.
    this._validatePatchPaths(patch, resolved);

    try {
      // F-6: NO --whitespace=fix — write the patch bytes faithfully.
      execFileSync("git", ["apply", "--unidiff-zero", "-"], {
        cwd: resolved,
        input: patch,
        encoding: "utf8",
        timeout: this.gitApplyTimeoutMs,
        windowsHide: true,
      });
      return { success: true, message: "Patch applied cleanly" };
    } catch (err) {
      // F-5 / §2.8: a timeout / signal kill is a distinct, honest signal.
      const isTimeout =
        err &&
        (err.killed === true || err.code === "ETIMEDOUT" || err.signal === "SIGTERM");
      if (isTimeout) {
        const stderr = err && err.stderr ? String(err.stderr).trim() : "";
        throw new GitApplyTimeoutError(
          `GitApplyTimeoutError: git apply was terminated by a timeout/signal ` +
            `(signal=${err && err.signal ? err.signal : "unknown"}). ` +
            `The patch was NOT applied (git apply is atomic). ${stderr}`,
          { signal: err && err.signal ? err.signal : null, stderr }
        );
      }
      const msg = err.stderr ? err.stderr.toString().trim() : (err.message || String(err));
      throw new Error(`GitApplyError: Failed to apply patch: ${msg}`);
    }
  }

  /**
   * F-2 discriminator: determines whether `dirPath` is inside a git
   * repository, so that a FATAL `git grep` error can be distinguished from a
   * legitimate "not a git repository" situation.
   *
   * `git rev-parse --is-inside-work-tree` exits 0 for a valid repository but
   * exits 128 for BOTH a non-git directory AND a corrupted repository (e.g. a
   * bad `.git/HEAD`). The two cases must be told apart because a corrupted
   * repository must fail fast (its `.git` is present) while a non-git
   * directory is a legitimate fallback scenario. The reliable discriminator
   * is the presence of a `.git` entry at the directory or any ancestor: a
   * real or corrupted repository has one, a non-git directory does not.
   *
   * @param {string} dirPath
   * @returns {Promise<boolean>}
   */
  async _isInsideGitRepo(dirPath) {
    try {
      const { code } = await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], {
        cwd: dirPath,
        timeout: 5_000,
      });
      if (code === 0) return true;
    } catch {
      // rev-parse failed (non-git dir OR corrupted repo) — fall through to
      // the .git-presence check below.
    }
    // Walk up from dirPath to the filesystem root looking for a `.git`
    // entry. A real or corrupted repository has one; a non-git directory
    // does not.
    let dir = dirPath;
    for (;;) {
      try {
        if (fs.existsSync(path.join(dir, ".git"))) return true;
      } catch {
        // ignore stat errors and keep climbing
      }
      const parent = path.dirname(dir);
      if (parent === dir) break; // reached the filesystem root
      dir = parent;
    }
    return false;
  }

  /**
   * Fast indexed search using git grep (respecting .gitignore) or a safe
   * fallback file search.
   *
   * F-1: the query is matched as a LITERAL string (`-F` / `--fixed-strings`),
   * aligning the implementation with the documented "Literal string to
   * search for" contract.
   *
   * F-2: a FATAL `git grep` error (any non-zero exit code other than 1)
   * inside a git repository fails fast with a `GitGrepError` instead of
   * falling through to the manual walk. Exit code 1 ("no matches") is a
   * valid empty result. In a non-git directory the manual walk is used, but
   * it explicitly skips `.env` / `.env.*` files to prevent secret ingestion.
   *
   * F-12: `max_results` caps the TOTAL number of matches returned,
   * consistently across both the git-grep and fallback paths.
   */
  async searchCode({ query, dirPath = ".", max_results = 50 }) {
    const resolved = this.resolvePath(dirPath);
    const cap = Math.max(0, max_results | 0);
    try {
      // Use git grep first (inherently avoids .venv and node_modules, includes
      // untracked files). `-F` makes the query a literal string (F-1). The
      // per-file `--max-count` is intentionally NOT used: it caps matches per
      // file, not in total, which made `count` exceed `max_results` (F-12).
      // The total cap is applied to the combined output below.
      const { stdout } = await execFileAsync("git", ["grep", "-n", "-I", "-F", "--untracked", "-e", query], {
        cwd: resolved,
        timeout: 10_000,
      });
      const lines = stdout.trim().split("\n").filter(Boolean);
      const matches = lines.slice(0, cap);
      return {
        query,
        count: matches.length,
        matches,
      };
    } catch (err) {
      // git grep exit code 1 means "no matches found", NOT an execution error.
      if (err && err.code === 1) {
        return {
          query,
          count: 0,
          matches: [],
        };
      }

      // F-2: a FATAL git error (e.g. 128 on a corrupted repository) must fail
      // fast when we are inside a git repository — do NOT fall through to the
      // manual walk, which would read gitignored files (e.g. `.env`) and leak
      // secrets. Only a non-git directory is a legitimate fallback scenario.
      const inRepo = await this._isInsideGitRepo(resolved);
      if (inRepo) {
        const stderr = err && err.stderr ? String(err.stderr).trim() : "";
        throw new GitGrepError(
          `GitGrepError: git grep failed with exit code ${err && err.code} in a git repository: ${stderr || err.message}`,
          { code: err && err.code, stderr }
        );
      }

      // Legitimate fallback: not a git repository. Search files avoiding
      // ignored directories AND `.env` / `.env.*` files (F-2 secret-leak
      // prevention). The total match count is capped at `max_results` (F-12).
      const matches = [];
      const walkSearch = (cur) => {
        if (matches.length >= cap) return;
        let files;
        try {
          files = fs.readdirSync(cur, { withFileTypes: true });
        } catch {
          return;
        }
        for (const f of files) {
          if (matches.length >= cap) break;
          if (this.ignoredDirs.has(f.name)) continue;
          if (isEnvFile(f.name)) continue; // F-2: never ingest .env / .env.*
          const full = path.join(cur, f.name);
          if (f.isDirectory()) {
            walkSearch(full);
          } else if (f.isFile()) {
            // P4i: use statSync for the size check, NOT the dirent's f.size.
            let size = f.size;
            if (size === undefined) {
              try {
                size = fs.statSync(full).size;
              } catch {
                continue;
              }
            }
            if (size < 500_000) {
              try {
                const text = fs.readFileSync(full, "utf8");
                if (text.includes(query)) {
                  const lines = text.split("\n");
                  lines.forEach((l, idx) => {
                    if (l.includes(query) && matches.length < cap) {
                      matches.push(`${path.relative(resolved, full)}:${idx + 1}: ${l.trim().slice(0, 200)}`);
                    }
                  });
                }
              } catch {}
            }
          }
        }
      };
      walkSearch(resolved);
      return { query, count: matches.length, matches };
    }
  }
}

/**
 * Anser Plugin to mount SandboxFsService and its tools into Context.
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
    description:
      "Perform exact text search-and-replace in a file. " +
      "target_content must occur exactly once unless replace_all is true; ambiguous edits are refused.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path" },
        target_content: { type: "string", description: "Exact character sequence to replace (must be unique unless replace_all is true)" },
        replacement_content: { type: "string", description: "Replacement content" },
        replace_all: { type: "boolean", description: "If true, replace every occurrence of target_content. If false (default), target must occur exactly once.", default: false },
      },
      required: ["path", "target_content", "replacement_content"],
    },
    execute: (args) => fsService.editFile(args),
  });

  ctx.registerTool("apply_patch", {
    description: "Apply a standard unified diff patch atomically using git apply (--unidiff-zero)",
    parameters: {
      type: "object",
      properties: {
        patch: { type: "string", description: "Standard unified diff patch content" },
        path: { type: "string", description: "Target base directory", default: "." },
      },
      required: ["patch"],
    },
    execute: (args) => fsService.applyPatch(args),
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
