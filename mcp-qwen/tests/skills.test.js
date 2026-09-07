/**
 * P9 - Skills library + keyword auto-inject tests (offline).
 *
 * Vectors:
 *   1. frontmatter parsing (well-formed + malformed-skipped)
 *   2. keyword match fires / non-match stays silent
 *   3. cap enforcement (>3 matches -> first 3)
 *   4. injection block present in output and absent otherwise
 *   5. listSkills() shape
 *   6. cwd-based match
 *
 * Uses a temp skills/ dir so the tests are hermetic and do not depend on the
 * repo's real skills/ contents.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  splitFrontmatter,
  parseFrontmatter,
  parseSkill,
  loadSkills,
  listSkills,
  matchSkills,
  injectSkills,
  extractNegatedKeywords,
  isSkillNegated,
  MAX_SKILLS,
  MAX_BODY_CHARS,
  MAX_TOTAL_CHARS,
} from "../src/skills.js";

let passed = 0;
let failed = 0;
function assert(cond, name) {
  if (cond) {
    console.log(`[PASS] ${name}`);
    passed++;
  } else {
    console.error(`[FAIL] ${name}`);
    failed++;
  }
}

// Build a hermetic temp skills dir with a known set of skills.
function makeTempSkills() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skills_test_"));
  const write = (name, content) => {
    const d = path.join(dir, name);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "SKILL.md"), content, "utf8");
  };

  // Well-formed skills with distinct keywords.
  write("evo", `---
name: evo
description: Evo workflow
keywords: [evo, lineage]
---
Evo body text.`);

  write("traceback", `---
name: traceback
description: Condense tracebacks
keywords: [traceback, stack trace]
---
Traceback body text.`);

  write("canary", `---
name: canary
description: Canary staging
keywords: [canary, smoke]
---
Canary body text.`);

  write("rollback", `---
name: rollback
description: Rollback discipline
keywords: [rollback, revert]
---
Rollback body text.`);

  // A skill with NO keywords (should never match).
  write("nokeys", `---
name: nokeys
description: no keywords here
---
No-keys body.`);

  // A malformed skill: opened frontmatter but never closed -> treated as body.
  write("malformed", `---
name: malformed
description: broken
keywords: [x]
this line has no closing --- so the whole doc is body
`);

  return dir;
}

async function main() {
  const dir = makeTempSkills();

  // --- Test 1: frontmatter parsing ---
  console.log("\n[Test 1: frontmatter parsing]");
  {
    const good = `---
name: demo
description: A demo skill
keywords: [a, b, c]
---
Body line one.
Body line two.`;
    const { frontmatter, body } = splitFrontmatter(good);
    assert(frontmatter.includes("name: demo"), "frontmatter captured");
    assert(body === "Body line one.\nBody line two.", "body captured (trimmed)");

    const fm = parseFrontmatter(frontmatter);
    assert(fm.name === "demo", "name parsed");
    assert(fm.description === "A demo skill", "description parsed");
    assert(fm.keywords === "[a, b, c]", "keywords raw value parsed");

    const skill = parseSkill(good, "demo");
    assert(skill.name === "demo", "skill.name from frontmatter");
    assert(skill.keywords.length === 3, `keywords list parsed (got ${skill.keywords.length})`);
    assert(skill.keywords[0] === "a", "first keyword parsed");

    // comma-separated (non-JSON) keywords
    const comma = parseSkill(`---
name: c
keywords: x, y, z
---
body`, "c");
    assert(comma.keywords.length === 3, `comma-separated keywords (got ${comma.keywords.length})`);

    // malformed: no closing --- -> whole doc is body, no frontmatter
    const bad = splitFrontmatter(`---
name: broken
keywords: [x]
no closing marker here`);
    assert(bad.frontmatter === "", "malformed frontmatter -> empty");
    assert(bad.body.length > 0, "malformed doc treated as body");
  }

  // --- Test 2: keyword match fires / non-match silent ---
  console.log("\n[Test 2: keyword match fires / non-match silent]");
  {
    const m = matchSkills({ prompt: "please fix the failing traceback", cwd: "", dir });
    const names = m.map((s) => s.name);
    assert(names.includes("traceback"), `traceback matched (got ${names.join(",")})`);
    assert(!names.includes("canary"), "canary did NOT match");

    // non-match: prompt with no keywords
    const none = matchSkills({ prompt: "hello world, just chatting", cwd: "", dir });
    assert(none.length === 0, "no match for unrelated prompt");

    // nokeys skill never matches even if its name appears
    const byName = matchSkills({ prompt: "nokeys", cwd: "", dir });
    assert(!byName.some((s) => s.name === "nokeys"), "no-keyword skill never matches");
  }

  // --- Test 3: cap enforcement (>3 matches -> first 3) ---
  console.log("\n[Test 3: cap enforcement]");
  {
    // A prompt containing keywords from all four keyword-bearing skills.
    const m = matchSkills({
      prompt: "evo traceback canary rollback",
      cwd: "",
      dir,
    });
    assert(m.length === MAX_SKILLS, `capped to ${MAX_SKILLS} (got ${m.length})`);
    // each body within per-body cap
    for (const s of m) {
      assert(s.body.length <= MAX_BODY_CHARS + 32, `body within cap (${s.name}: ${s.body.length})`);
    }
    // total within budget
    const total = m.reduce((n, s) => n + s.body.length, 0);
    assert(total <= MAX_TOTAL_CHARS + 32, `total within budget (${total})`);
  }

  // --- Test 4: injection block present / absent ---
  console.log("\n[Test 4: injection block present / absent]");
  {
    const withMatch = injectSkills("fix the traceback please", "", dir);
    assert(
      withMatch.includes("--- Matching skills (auto-injected from skills/) ---"),
      "injection block present on match"
    );
    assert(withMatch.includes("### traceback"), "skill heading present");
    assert(withMatch.startsWith("fix the traceback please"), "original prompt preserved at top");

    const noMatch = injectSkills("just chatting", "", dir);
    assert(noMatch === "just chatting", "prompt unchanged when no match");
  }

  // --- Test 5: listSkills() shape ---
  console.log("\n[Test 5: listSkills() shape]");
  {
    const list = listSkills(dir);
    assert(Array.isArray(list) && list.length >= 4, `listSkills returns array (got ${list.length})`);
    const sample = list.find((s) => s.name === "evo");
    assert(sample && typeof sample.description === "string", "listSkills has description");
    assert(
      sample && Array.isArray(sample.keywords) && sample.keywords.includes("evo"),
      "listSkills has keywords array"
    );
    // listSkills should NOT include the body
    assert(!("body" in sample), "listSkills omits body");
  }

  // --- Test 6: cwd-based match ---
  console.log("\n[Test 6: cwd-based match]");
  {
    // A prompt with no keywords, but a cwd path containing "evo".
    const m = matchSkills({ prompt: "do the work", cwd: "/home/user/evo-project", dir });
    const names = m.map((s) => s.name);
    assert(names.includes("evo"), `cwd 'evo' triggered evo skill (got ${names.join(",")})`);

    // a cwd with no keyword
    const none = matchSkills({ prompt: "do the work", cwd: "/home/user/other", dir });
    assert(!none.some((s) => s.name === "evo"), "non-evo cwd did not trigger evo");
  }

  // --- Test 7: malformed skill skipped, others still load ---
  console.log("\n[Test 7: malformed skill skipped, others load]");
  {
    const all = loadSkills(dir);
    const names = all.map((s) => s.name);
    // The malformed one has no closing ---, so its "body" is the whole doc and
    // it still loads (with a body). The key assertion: loading did NOT throw
    // and the well-formed skills are all present.
    assert(names.includes("evo"), "evo loaded");
    assert(names.includes("traceback"), "traceback loaded");
    assert(names.includes("canary"), "canary loaded");
    assert(names.includes("rollback"), "rollback loaded");
    // nokeys has a body so it loads too (just never matches)
    assert(names.includes("nokeys"), "nokeys loaded (has body)");
  }

  // --- Test 8: missing skills dir -> empty, no throw ---
  console.log("\n[Test 8: missing skills dir -> empty, no throw]");
  {
    const missing = path.join(os.tmpdir(), "definitely_not_a_skills_dir_xyz");
    let threw = false;
    let res;
    try {
      res = loadSkills(missing);
    } catch {
      threw = true;
    }
    assert(!threw, "loadSkills did not throw on missing dir");
    assert(Array.isArray(res) && res.length === 0, "missing dir -> empty array");
  }

  // --- Test 9: negated keyword intent filtering ---
  console.log("\n[Test 9: negated keyword intent filtering]");
  {
    const negs = extractNegatedKeywords("purge all evo references, eliminate traceback, and avoid rollback");
    assert(negs.has("evo"), "extracted negated 'evo'");
    assert(negs.has("traceback"), "extracted negated 'traceback'");
    assert(negs.has("rollback"), "extracted negated 'rollback'");

    // Prompt contains "evo", but is negated -> evo skill must NOT be matched
    const m = matchSkills({ prompt: "purge all evo references please", cwd: "", dir });
    assert(!m.some((s) => s.name === "evo"), "evo skill was blacklisted by 'purge all evo'");

    // Canary is not negated and matches keywords
    const m2 = matchSkills({ prompt: "purge evo, but run canary smoke test", cwd: "", dir });
    assert(!m2.some((s) => s.name === "evo"), "evo skill was blacklisted");
    assert(m2.some((s) => s.name === "canary"), "canary skill was matched");
  }

  // --- Test 10: explicitSkills parameter ---
  console.log("\n[Test 10: explicitSkills parameter]");
  {
    // explicitSkills bypasses keyword search
    const m = matchSkills({ prompt: "unrelated prompt", cwd: "", dir, explicitSkills: ["canary"] });
    assert(m.length === 1, "exactly one skill matched");
    assert(m[0].name === "canary", "canary skill matched explicitly");

    const injected = injectSkills("unrelated prompt", "", dir, ["canary"]);
    assert(injected.includes("### canary"), "canary injected explicitly");
  }

  // --- Test 11: explicitSkills missing throws Error (fail fast) ---
  console.log("\n[Test 11: explicitSkills missing throws Error (fail fast)]");
  {
    let threw = false;
    try {
      matchSkills({ prompt: "hi", cwd: "", dir, explicitSkills: ["ghost_skill"] });
    } catch (err) {
      threw = true;
      assert(err.message.includes("ghost_skill"), "error mentions missing skill");
    }
    assert(threw, "matchSkills threw on non-existent explicit skill");
  }

  // cleanup
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}

  console.log("\n==========================================");
  console.log(`Skills Tests: ${passed} PASSED, ${failed} FAILED`);
  console.log("==========================================");
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Skills test uncaught error:", err);
  process.exit(1);
});
