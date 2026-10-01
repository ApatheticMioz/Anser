/**
 * Evo Skill Evolution & Procedural Playbook Test Suite
 *
 * Validates:
 * 1. Proposing a candidate with skills_to_modify snapshots existing SKILL.md.
 * 2. Deterministic rollback cleanly restores pre-mutation bytes of modified skills.
 * 3. Newly created skill in a candidate is cleanly unlinked on revert, and parent directory is cleaned up.
 * 4. Frontmatter validation exhaustively catches all malformed states (missing description, missing name,
 *    missing YAML delimiters, empty body, missing file) and fails closed in evaluateCandidate and selectCandidate.
 * 5. Security containment and path traversal protection rejects malicious skill names (../, /, \, empty).
 * 6. Multi-artifact candidate: simultaneous mutation and rollback of code files, existing skills, and new skills.
 * 7. Successful evaluation and selection advances LineageDag with skillsModified recorded.
 * 8. Lifecycle invariants: rejection of invalid proposals, double-evaluations, and reverting accepted candidates.
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// State isolation pattern (matches tests/evo.test.js & tests/shell_hardening.test.js)
const TMP_STATE = fs.mkdtempSync(path.join(os.tmpdir(), "fx7_evo_skills_state_"));
process.env.QWEN_STATE_DIR = TMP_STATE;
process.env.QWEN_WSL_HOME = TMP_STATE;
process.env.QWEN_WIN_HOME = TMP_STATE;
process.env.HOME = TMP_STATE;

const { EvoOperator } = await import("../src/harness/evo/evo_operator.js");
const { LineageDag } = await import("../src/harness/evo/lineage_dag.js");
const { ShellExecutorService } = await import("../src/harness/services/shell_executor.js");

const TEST_DIR = path.resolve(process.cwd(), ".test_evo_skills_tmp");

async function cleanup() {
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {}
}

const SAMPLE_SKILL_CONTENT = `---
name: sample-workflow
description: A sample test workflow recipe
keywords: [sample, testing, workflow]
---
# Sample Workflow
1. Run diagnostics
2. Verify output
`;

async function runTests() {
  console.log("=== Evo Skill Evolution & Playbook Validation ===\n");
  await cleanup();
  fs.mkdirSync(TEST_DIR, { recursive: true });

  const skillsDir = path.join(TEST_DIR, "skills", "sample-workflow");
  fs.mkdirSync(skillsDir, { recursive: true });
  const sampleSkillFile = path.join(skillsDir, "SKILL.md");
  fs.writeFileSync(sampleSkillFile, SAMPLE_SKILL_CONTENT, "utf8");

  const shell = new ShellExecutorService({ cwd: TEST_DIR });
  const evo = new EvoOperator({
    workspaceRoot: TEST_DIR,
    shell,
  });

  // -------------------------------------------------------------
  // Test 1: Propose candidate with skills_to_modify snapshots SKILL.md
  // -------------------------------------------------------------
  console.log("[Test 1] Propose candidate snapshots existing SKILL.md...");
  {
    const res = await evo.proposeCandidate({
      hypothesis: "Refine sample-workflow for better precision",
      skills_to_modify: ["sample-workflow"],
    });

    assert.ok(res.candidate_id, "Candidate ID missing");
    assert.strictEqual(res.skills_snapshotted, 1, "Expected 1 skill snapshotted");
    assert.ok(evo.activeCandidate, "Active candidate not set");
    assert.strictEqual(evo.activeCandidate.snapshotManifest.length, 1);
    assert.ok(fs.existsSync(evo.activeCandidate.snapshotManifest[0].targetBackup), "Backup file does not exist");
    console.log("  -> Passed!");
  }

  // -------------------------------------------------------------
  // Test 2: Revert cleanly restores pre-mutation bytes
  // -------------------------------------------------------------
  console.log("[Test 2] Revert restores exact pre-mutation bytes of modified skill...");
  {
    // Apply mutation
    fs.writeFileSync(sampleSkillFile, "# Completely broken mutated skill without frontmatter", "utf8");
    assert.notStrictEqual(fs.readFileSync(sampleSkillFile, "utf8"), SAMPLE_SKILL_CONTENT);

    const revertRes = await evo.revertCandidate();
    assert.strictEqual(revertRes.status, "rejected");
    assert.strictEqual(revertRes.files_reverted, 1);

    // Verify byte-for-byte restoration
    const restored = fs.readFileSync(sampleSkillFile, "utf8");
    assert.strictEqual(restored, SAMPLE_SKILL_CONTENT, "Restored content does not match original bytes");
    console.log("  -> Passed!");
  }

  // -------------------------------------------------------------
  // Test 3: Newly created skill is unlinked and parent dir removed on revert
  // -------------------------------------------------------------
  console.log("[Test 3] Newly created skill is unlinked and directory cleaned up on revert...");
  {
    const res = await evo.proposeCandidate({
      hypothesis: "Add brand new procedural skill",
      skills_to_modify: ["brand-new-skill"],
    });

    const newSkillPath = evo.resolveSkillPath("brand-new-skill");
    const newSkillDir = path.dirname(newSkillPath);
    fs.mkdirSync(newSkillDir, { recursive: true });
    fs.writeFileSync(newSkillPath, SAMPLE_SKILL_CONTENT, "utf8");
    assert.ok(fs.existsSync(newSkillPath), "New skill file should exist on disk");

    const revertRes = await evo.revertCandidate();
    assert.strictEqual(revertRes.status, "rejected");
    assert.ok(!fs.existsSync(newSkillPath), "New skill file should have been deleted on rollback");
    assert.ok(!fs.existsSync(newSkillDir), "Empty skill directory should have been removed on rollback");
    console.log("  -> Passed!");
  }

  // -------------------------------------------------------------
  // Test 4: Frontmatter validation exhaustively catches all malformed states
  // -------------------------------------------------------------
  console.log("[Test 4] Frontmatter validation fails closed on all malformed states...");
  {
    const malformedCases = [
      {
        desc: "missing description",
        content: `---\nname: sample-workflow\nkeywords: [bad]\n---\n# Workflow Body\nStep 1\n`,
        expectedErr: "missing required 'description' field",
      },
      {
        desc: "missing name",
        content: `---\ndescription: Workflow without name\nkeywords: [bad]\n---\n# Workflow Body\nStep 1\n`,
        expectedErr: "missing required 'name' field",
      },
      {
        desc: "missing frontmatter delimiters",
        content: `# Workflow without frontmatter\nStep 1\n`,
        expectedErr: "missing required YAML frontmatter",
      },
      {
        desc: "empty markdown workflow body",
        content: `---\nname: sample-workflow\ndescription: Good frontmatter but empty body\n---\n`,
        expectedErr: "markdown workflow body is empty",
      },
    ];

    for (const testCase of malformedCases) {
      await evo.proposeCandidate({
        hypothesis: `Test malformed: ${testCase.desc}`,
        skills_to_modify: ["sample-workflow"],
      });

      fs.writeFileSync(sampleSkillFile, testCase.content, "utf8");

      const evalRes = await evo.evaluateCandidate({
        command: "node -e 'process.exit(0)'",
      });

      assert.strictEqual(evalRes.passed, false, `Evaluation must fail when ${testCase.desc}`);
      assert.ok(evalRes.failure_digest.includes("SkillFrontmatterValidationError"), "Expected frontmatter error in digest");
      assert.ok(evalRes.metrics.skill_errors.some((e) => e.includes(testCase.expectedErr)), `Expected error containing '${testCase.expectedErr}'`);

      await assert.rejects(
        async () => {
          await evo.selectCandidate();
        },
        /Skill frontmatter validation failed/,
        "selectCandidate should throw when frontmatter validation fails"
      );

      await evo.revertCandidate();
      assert.strictEqual(fs.readFileSync(sampleSkillFile, "utf8"), SAMPLE_SKILL_CONTENT);
    }

    // Subcase 4e: Skill file deleted completely during candidate mutation
    await evo.proposeCandidate({
      hypothesis: "Test completely deleted skill file",
      skills_to_modify: ["sample-workflow"],
    });

    fs.unlinkSync(sampleSkillFile);
    assert.ok(!fs.existsSync(sampleSkillFile));

    const evalDel = await evo.evaluateCandidate({ command: "node -e 'process.exit(0)'" });
    assert.strictEqual(evalDel.passed, false);
    assert.ok(evalDel.metrics.skill_errors.some((e) => e.includes("does not exist on disk after mutation")));

    await evo.revertCandidate();
    assert.ok(fs.existsSync(sampleSkillFile));
    assert.strictEqual(fs.readFileSync(sampleSkillFile, "utf8"), SAMPLE_SKILL_CONTENT);

    console.log("  -> Passed all 5 frontmatter validation subcases!");
  }

  // -------------------------------------------------------------
  // Test 5: Security containment & path traversal protection
  // -------------------------------------------------------------
  console.log("[Test 5] Security containment & path traversal rejection...");
  {
    const dangerousNames = [
      "../outside-skill",
      "../../etc/passwd",
      "sub/dir/skill",
      "sub\\dir\\skill",
      "",
      "   ",
    ];

    for (const badName of dangerousNames) {
      assert.throws(
        () => {
          evo.resolveSkillPath(badName);
        },
        /Invalid skill name/,
        `resolveSkillPath should reject traversal name: '${badName}'`
      );

      await assert.rejects(
        async () => {
          await evo.proposeCandidate({
            hypothesis: "Attack with bad skill path",
            skills_to_modify: [badName],
          });
        },
        /Invalid skill name/,
        `proposeCandidate should reject traversal name: '${badName}'`
      );
    }
    console.log("  -> Passed!");
  }

  // -------------------------------------------------------------
  // Test 6: Multi-artifact candidate: simultaneous rollback of multiple code files and skills
  // -------------------------------------------------------------
  console.log("[Test 6] Multi-artifact candidate: rollback of multiple code files, existing skills, and new skills...");
  {
    const codeFile1 = path.join(TEST_DIR, "index.js");
    const codeFile2 = path.join(TEST_DIR, "lib", "util.js");
    fs.mkdirSync(path.dirname(codeFile2), { recursive: true });
    fs.writeFileSync(codeFile1, "export const A = 1;\n", "utf8");
    fs.writeFileSync(codeFile2, "export const B = 2;\n", "utf8");

    // Create a second existing skill
    const skill2Dir = path.join(TEST_DIR, "skills", "second-skill");
    fs.mkdirSync(skill2Dir, { recursive: true });
    const skill2File = path.join(skill2Dir, "SKILL.md");
    const SKILL2_ORIGINAL = `---
name: second-skill
description: Second existing skill
keywords: [second]
---
# Second Skill
Step 1
`;
    fs.writeFileSync(skill2File, SKILL2_ORIGINAL, "utf8");

    await evo.proposeCandidate({
      hypothesis: "Multi-artifact transformation across code and multiple skills",
      files_to_modify: ["index.js", "lib/util.js"],
      skills_to_modify: ["sample-workflow", "second-skill", "temporary-new-skill"],
    });

    // Mutate code files
    fs.writeFileSync(codeFile1, "export const A = 999;\n", "utf8");
    fs.writeFileSync(codeFile2, "export const B = 888;\n", "utf8");

    // Mutate existing skills
    fs.writeFileSync(sampleSkillFile, "# Broken sample skill\n", "utf8");
    fs.writeFileSync(skill2File, "# Broken second skill\n", "utf8");

    // Create the new skill
    const tempSkillPath = evo.resolveSkillPath("temporary-new-skill");
    fs.mkdirSync(path.dirname(tempSkillPath), { recursive: true });
    fs.writeFileSync(tempSkillPath, SAMPLE_SKILL_CONTENT, "utf8");

    // Revert everything
    const revertRes = await evo.revertCandidate();
    assert.strictEqual(revertRes.status, "rejected");
    assert.strictEqual(revertRes.files_reverted, 5, "Expected 5 artifacts reverted (2 code + 2 existing skills + 1 new skill)");

    // Verify all restorations
    assert.strictEqual(fs.readFileSync(codeFile1, "utf8"), "export const A = 1;\n");
    assert.strictEqual(fs.readFileSync(codeFile2, "utf8"), "export const B = 2;\n");
    assert.strictEqual(fs.readFileSync(sampleSkillFile, "utf8"), SAMPLE_SKILL_CONTENT);
    assert.strictEqual(fs.readFileSync(skill2File, "utf8"), SKILL2_ORIGINAL);
    assert.ok(!fs.existsSync(tempSkillPath), "Temporary skill should be deleted on revert");
    assert.ok(!fs.existsSync(path.dirname(tempSkillPath)), "Temporary skill dir should be deleted on revert");

    console.log("  -> Passed!");
  }

  // -------------------------------------------------------------
  // Test 7: Successful evaluation and selection commits to LineageDag
  // -------------------------------------------------------------
  console.log("[Test 7] Successful evaluation and selection commits to LineageDag...");
  {
    const propRes = await evo.proposeCandidate({
      hypothesis: "Valid skill evolution with improved workflow",
      skills_to_modify: ["sample-workflow"],
    });

    const IMPROVED_SKILL = `---
name: sample-workflow
description: Improved recipe with empirical scratchpad verification
keywords: [sample, testing, scratchpad]
---
# Improved Workflow
1. Write reproduction test in .scratch/
2. Execute and verify
`;
    fs.writeFileSync(sampleSkillFile, IMPROVED_SKILL, "utf8");

    const evalRes = await evo.evaluateCandidate({
      command: "node -e 'process.exit(0)'",
    });

    assert.strictEqual(evalRes.passed, true, "Valid candidate evaluation should pass");
    assert.strictEqual(evalRes.is_improvement, true);

    const selRes = await evo.selectCandidate();
    assert.strictEqual(selRes.status, "accepted");

    const dag = LineageDag.forWorkspace(TEST_DIR);
    const node = dag.nodes.get(propRes.candidate_id);
    assert.ok(node, "Candidate node must exist in DAG");
    assert.deepStrictEqual(node.skillsModified, ["sample-workflow"]);
    assert.strictEqual(node.metrics.status, "accepted");
    console.log("  -> Passed!");
  }

  // -------------------------------------------------------------
  // Test 8: Lifecycle invariants & error guards
  // -------------------------------------------------------------
  console.log("[Test 8] Lifecycle invariants and error guards...");
  {
    // Propose without hypothesis
    await assert.rejects(
      async () => {
        await evo.proposeCandidate({});
      },
      /Evo hypothesis is required/,
      "proposeCandidate without hypothesis must throw"
    );

    // Evaluate without active candidate
    await assert.rejects(
      async () => {
        await evo.evaluateCandidate({ command: "node -e 'process.exit(0)'" });
      },
      /No active Evo candidate to evaluate/,
      "evaluateCandidate without active candidate must throw"
    );

    // Select without active candidate
    await assert.rejects(
      async () => {
        await evo.selectCandidate();
      },
      /No candidate specified to select/,
      "selectCandidate without active candidate must throw"
    );

    // Revert without active candidate
    await assert.rejects(
      async () => {
        await evo.revertCandidate();
      },
      /No candidate specified to revert/,
      "revertCandidate without active candidate must throw"
    );

    // Revert already-accepted candidate
    const dag = LineageDag.forWorkspace(TEST_DIR);
    const acceptedId = dag.getBestCandidate()?.id;
    assert.ok(acceptedId, "Must have an accepted candidate from Test 7");

    await assert.rejects(
      async () => {
        await evo.revertCandidate({ candidate_id: acceptedId });
      },
      /already accepted into baseline and cannot be reverted/,
      "Reverting an accepted candidate must throw"
    );

    console.log("  -> Passed!");
  }

  await cleanup();
  console.log("\nAll Evo Skill tests passed cleanly! [8/8]\n");
}

runTests().catch(async (err) => {
  console.error("Test failure:", err);
  await cleanup();
  process.exit(1);
});
