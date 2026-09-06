/**
 * src/skills.js - Packaged skills library with keyword auto-injection.
 *
 * A "skill" is a reusable workflow recipe stored at:
 *
 *     <repo>/skills/<name>/SKILL.md
 *
 * Each SKILL.md has a tiny YAML-ish frontmatter block (the lines between the
 * first pair of `---` markers) followed by a markdown workflow body:
 *
 *     ---
 *     name: my-skill
 *     description: One-line summary
 *     keywords: [traceback, stack trace, error digest]
 *     ---
 *     <workflow body in markdown>
 *
 * The parser is intentionally tiny and dependency-free:
 *   - frontmatter = lines between the first `---` and the next `---`
 *   - `key: value` lines; `keywords` may be a JSON-ish list `[a, b, c]`
 *     or a plain comma-separated string
 *   - the body is everything after the closing `---`
 *
 * `matchSkills({ prompt, cwd })` returns the skills whose keywords appear in
 * the prompt (case-insensitive substring / word match) OR in the cwd path
 * string (so a repo named "evo" can trigger an evo skill). Results are
 * additive and budget-capped: at most 3 skills, each body capped at ~2000
 * chars, and a total injected budget of ~6000 chars.
 *
 * `injectSkills(prompt, cwd)` appends a clearly-delimited block to the prompt
 * ONLY when there are matches; otherwise it returns the prompt unchanged.
 *
 * Never-throw discipline: unreadable or malformed skills are skipped with a
 * stderr note so a bad skill can never take down a dispatch.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

/** Max number of skills injected per dispatch. */
export const MAX_SKILLS = 3;
/** Max characters of a single skill body before it is truncated. */
export const MAX_BODY_CHARS = 2000;
/** Max total characters across all injected skill bodies. */
export const MAX_TOTAL_CHARS = 6000;

// ---------------------------------------------------------------------------
// Skills directory resolution (mirrors streamProxyPath in platform.js)
// ---------------------------------------------------------------------------

/**
 * Resolve the repo-root `skills/` directory from this module's own location
 * so it is correct regardless of process.cwd(). This file lives at
 * `<repo>/src/skills.js`, so the repo root is two levels up.
 * @returns {string}
 */
export function skillsDir() {
  const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  return path.join(repoRoot, "skills");
}

// ---------------------------------------------------------------------------
// Frontmatter parsing
// ---------------------------------------------------------------------------

/**
 * Split a SKILL.md document into { frontmatter, body }.
 *
 * The frontmatter is the block between the FIRST `---` line and the NEXT
 * `---` line. If the document does not open with `---` (or has no closing
 * `---`), the whole document is treated as the body with empty frontmatter.
 *
 * @param {string} text
 * @returns {{ frontmatter: string, body: string }}
 */
export function splitFrontmatter(text) {
  // Normalize line endings so the split is stable across CRLF/LF files.
  const normalized = String(text).replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");

  // The first non-empty line must be exactly `---` to open frontmatter.
  let openIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === "") continue;
    if (lines[i].trim() === "---") openIdx = i;
    break; // only the first non-empty line can open it
  }

  if (openIdx === -1) {
    return { frontmatter: "", body: normalized };
  }

  let closeIdx = -1;
  for (let i = openIdx + 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      closeIdx = i;
      break;
    }
  }

  if (closeIdx === -1) {
    // Opened but never closed: treat the whole thing as body (malformed).
    return { frontmatter: "", body: normalized };
  }

  const frontmatter = lines.slice(openIdx + 1, closeIdx).join("\n");
  const body = lines.slice(closeIdx + 1).join("\n").trim();
  return { frontmatter, body };
}

/**
 * Parse a `keywords` value that may be a JSON-ish list `[a, b, c]` or a
 * plain comma-separated string `a, b, c`.
 * @param {string} raw
 * @returns {string[]}
 */
function parseKeywords(raw) {
  if (raw == null) return [];
  let s = String(raw).trim();
  if (s.startsWith("[") && s.endsWith("]")) {
    s = s.slice(1, -1);
  }
  return s
    .split(",")
    .map((k) => k.trim().replace(/^["']|["']$/g, ""))
    .filter((k) => k.length > 0);
}

/**
 * Parse a frontmatter block into a plain object. Only `key: value` lines are
 * honored; anything else is ignored. Values are trimmed and de-quoted.
 * @param {string} frontmatter
 * @returns {Record<string, string>}
 */
export function parseFrontmatter(frontmatter) {
  const out = {};
  if (!frontmatter) return out;
  for (const line of frontmatter.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colon = trimmed.indexOf(":");
    if (colon === -1) continue;
    const key = trimmed.slice(0, colon).trim();
    let value = trimmed.slice(colon + 1).trim();
    // Strip a single pair of surrounding quotes.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

/**
 * Parse a single SKILL.md file into a skill record.
 * @param {string} text
 * @param {string} dirName
 * @returns {{ name: string, description: string, keywords: string[], body: string }|null}
 */
export function parseSkill(text, dirName) {
  const { frontmatter, body } = splitFrontmatter(text);
  const fm = parseFrontmatter(frontmatter);
  const name = (fm.name || dirName).trim() || dirName;
  const description = (fm.description || "").trim();
  const keywords = parseKeywords(fm.keywords);
  return { name, description, keywords, body };
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Load and parse every skill under a skills directory.
 * Unreadable or malformed entries are skipped with a stderr note.
 *
 * @param {string} [dir] skills directory (defaults to the repo-root skills/)
 * @returns {Array<{ name: string, description: string, keywords: string[], body: string }>}
 */
export function loadSkills(dir = skillsDir()) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    // No skills/ directory at all: that is fine, just no skills.
    return out;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillFile = path.join(dir, entry.name, "SKILL.md");
    let text;
    try {
      text = fs.readFileSync(skillFile, "utf8");
    } catch {
      process.stderr.write(
        `[skills] skipping '${entry.name}': SKILL.md not found or unreadable\n`
      );
      continue;
    }
    try {
      const skill = parseSkill(text, entry.name);
      if (!skill || !skill.body) {
        process.stderr.write(
          `[skills] skipping '${entry.name}': empty or malformed body\n`
        );
        continue;
      }
      out.push(skill);
    } catch (err) {
      process.stderr.write(
        `[skills] skipping '${entry.name}': ${err.message}\n`
      );
    }
  }
  return out;
}

/**
 * Introspection helper: list all loaded skills (name + description + keywords).
 * @param {string} [dir] skills directory override (defaults to repo-root skills/)
 * @returns {Array<{ name: string, description: string, keywords: string[] }>}
 */
export function listSkills(dir) {
  return loadSkills(dir).map(({ name, description, keywords }) => ({
    name,
    description,
    keywords,
  }));
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/**
 * Case-insensitive substring / word match of a keyword against a haystack.
 * @param {string} keyword
 * @param {string} haystack
 * @returns {boolean}
 */
function keywordMatches(keyword, haystack) {
  if (!keyword || !haystack) return false;
  return haystack.toLowerCase().includes(keyword.toLowerCase());
}

/**
 * Find skills whose keywords match the prompt text OR the cwd path string.
 * Results are additive and budget-capped (MAX_SKILLS, MAX_BODY_CHARS,
 * MAX_TOTAL_CHARS). Never throws.
 *
 * @param {{ prompt?: string, cwd?: string, dir?: string }} params
 * @returns {Array<{ name: string, description: string, body: string }>}
 */
export function matchSkills({ prompt = "", cwd = "", dir } = {}) {
  const promptStr = String(prompt || "");
  const cwdStr = String(cwd || "");
  const all = loadSkills(dir);

  const matched = [];
  for (const skill of all) {
    if (!Array.isArray(skill.keywords) || skill.keywords.length === 0) continue;
    const hit = skill.keywords.some(
      (kw) => keywordMatches(kw, promptStr) || keywordMatches(kw, cwdStr)
    );
    if (hit) matched.push(skill);
  }

  // Cap the number of skills first.
  const capped = matched.slice(0, MAX_SKILLS);

  // Enforce the per-body and total budgets.
  const out = [];
  let total = 0;
  for (const skill of capped) {
    let body = skill.body;
    if (body.length > MAX_BODY_CHARS) {
      body = body.slice(0, MAX_BODY_CHARS) + "\n...[truncated]";
    }
    if (total + body.length > MAX_TOTAL_CHARS) {
      // Truncate to fit the remaining budget; drop if nothing fits.
      const remaining = MAX_TOTAL_CHARS - total;
      if (remaining <= 0) break;
      body = body.slice(0, remaining) + "\n...[truncated]";
    }
    total += body.length;
    out.push({ name: skill.name, description: skill.description, body });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Injection
// ---------------------------------------------------------------------------

/**
 * Append a clearly-delimited skills block to the prompt ONLY when there are
 * matching skills. Returns the prompt unchanged when nothing matches.
 *
 * @param {string} prompt
 * @param {string} [cwd]
 * @param {string} [dir] skills directory override (defaults to repo-root skills/)
 * @returns {string}
 */
export function injectSkills(prompt, cwd, dir) {
  const matches = matchSkills({ prompt, cwd, dir });
  if (matches.length === 0) return prompt;

  const parts = [
    "",
    "",
    "--- Matching skills (auto-injected from skills/) ---",
  ];
  for (const s of matches) {
    parts.push(`### ${s.name}`);
    parts.push(s.body);
    parts.push("");
  }
  return `${prompt}\n${parts.join("\n")}`.replace(/\n{3,}/g, "\n\n").trimEnd();
}
