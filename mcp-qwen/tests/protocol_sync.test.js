import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

const geminiPath = path.join(repoRoot, "GEMINI.md");
const claudePath = path.join(repoRoot, "CLAUDE.md");

test("protocol_sync: GEMINI.md and CLAUDE.md exist and are non-empty", () => {
  assert.ok(fs.existsSync(geminiPath), "GEMINI.md must exist");
  assert.ok(fs.existsSync(claudePath), "CLAUDE.md must exist");
  assert.ok(fs.statSync(geminiPath).size > 5000, "GEMINI.md must be populated");
  assert.ok(fs.statSync(claudePath).size > 5000, "CLAUDE.md must be populated");
});

test("protocol_sync: no unresolved conflict markers exist", () => {
  const geminiContent = fs.readFileSync(geminiPath, "utf8");
  const claudeContent = fs.readFileSync(claudePath, "utf8");

  assert.ok(!geminiContent.includes("<<<<<<<"), "GEMINI.md must not contain conflict markers");
  assert.ok(!claudeContent.includes("<<<<<<<"), "CLAUDE.md must not contain conflict markers");
});

test("protocol_sync: §2.7 Line-Ending Management is byte-identical", () => {
  const geminiContent = fs.readFileSync(geminiPath, "utf8");
  const claudeContent = fs.readFileSync(claudePath, "utf8");

  const extractSection = (content, header) => {
    const start = content.indexOf(header);
    assert.ok(start !== -1, `Header '${header}' not found`);
    const nextItem = content.indexOf("\n8. **Fail-Fast", start);
    assert.ok(nextItem !== -1, "Next section boundary not found");
    return content.slice(start, nextItem).trim();
  };

  const geminiSec = extractSection(geminiContent, "7. **Deterministic Line-Ending Management**:");
  const claudeSec = extractSection(claudeContent, "7. **Deterministic Line-Ending Management**:");

  assert.equal(geminiSec, claudeSec, "§2.7 must be byte-identical in GEMINI.md and CLAUDE.md");
});

test("protocol_sync: §2.8 Fail-Fast invariant is byte-identical", () => {
  const geminiContent = fs.readFileSync(geminiPath, "utf8");
  const claudeContent = fs.readFileSync(claudePath, "utf8");

  const extractSection = (content, header) => {
    const start = content.indexOf(header);
    assert.ok(start !== -1, `Header '${header}' not found`);
    const nextItem = content.indexOf("\n9. **High-Reasoning", start);
    assert.ok(nextItem !== -1, "Next section boundary not found");
    return content.slice(start, nextItem).trim();
  };

  const geminiSec = extractSection(geminiContent, "8. **Fail-Fast, Zero-Masking Engineering Invariant**:");
  const claudeSec = extractSection(claudeContent, "8. **Fail-Fast, Zero-Masking Engineering Invariant**:");

  assert.equal(geminiSec, claudeSec, "§2.8 must be byte-identical in GEMINI.md and CLAUDE.md");
});

test("protocol_sync: §3.1 Single Logical Concern is byte-identical", () => {
  const geminiContent = fs.readFileSync(geminiPath, "utf8");
  const claudeContent = fs.readFileSync(claudePath, "utf8");

  const extractSection = (content, header) => {
    const start = content.indexOf(header);
    assert.ok(start !== -1, `Header '${header}' not found`);
    const nextItem = content.indexOf("### 2. Session Lifecycle", start);
    assert.ok(nextItem !== -1, "Next section boundary not found");
    return content.slice(start, nextItem).trim();
  };

  const geminiSec = extractSection(geminiContent, "### 1. Single Logical Concern per Turn");
  const claudeSec = extractSection(claudeContent, "### 1. Single Logical Concern per Turn");

  assert.equal(geminiSec, claudeSec, "§3.1 must be byte-identical in GEMINI.md and CLAUDE.md");
});

test("protocol_sync: §3.3 Anti-Spoon-Feeding contract is byte-identical", () => {
  const geminiContent = fs.readFileSync(geminiPath, "utf8");
  const claudeContent = fs.readFileSync(claudePath, "utf8");

  const extractSection = (content, header) => {
    const start = content.indexOf(header);
    assert.ok(start !== -1, `Header '${header}' not found`);
    const nextItem = content.indexOf("## 4. Execution-First Mutation Protocol", start);
    assert.ok(nextItem !== -1, "Next section boundary not found");
    return content.slice(start, nextItem).trim();
  };

  const geminiSec = extractSection(geminiContent, "### 3. Architectural Specification Contract (Anti-Spoon-Feeding)");
  const claudeSec = extractSection(claudeContent, "### 3. Architectural Specification Contract (Anti-Spoon-Feeding)");

  assert.equal(geminiSec, claudeSec, "§3.3 must be byte-identical in GEMINI.md and CLAUDE.md");
});

test("protocol_sync: §4 decaying wait window schedule is identical", () => {
  const geminiContent = fs.readFileSync(geminiPath, "utf8");
  const claudeContent = fs.readFileSync(claudePath, "utf8");

  const scheduleSnippet = "--max-time 3000` (50m)\n     - Second wait window: `--max-time 1800` (30m";
  assert.ok(geminiContent.includes(scheduleSnippet), "GEMINI.md must contain decaying wait schedule");
  assert.ok(claudeContent.includes(scheduleSnippet), "CLAUDE.md must contain decaying wait schedule");
});

test("protocol_sync: Rule 0 systematically forbids raw exploration hoarding on Turn 1", () => {
  const geminiContent = fs.readFileSync(geminiPath, "utf8");
  const claudeContent = fs.readFileSync(claudePath, "utf8");

  assert.ok(geminiContent.includes("Systematic Exploration Offloading"), "GEMINI.md must enforce exploration offloading");
  assert.ok(claudeContent.includes("Systematic Exploration Offloading"), "CLAUDE.md must enforce exploration offloading");
  assert.ok(geminiContent.includes("Anti-Monolithic Turn 1 Dispatch"), "GEMINI.md must ban monolithic prompt dumping");
  assert.ok(claudeContent.includes("Anti-Monolithic Turn 1 Dispatch"), "CLAUDE.md must ban monolithic prompt dumping");
});
