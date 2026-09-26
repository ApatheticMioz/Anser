/**
 * Evo Operator (Evolutionary Variation Operators Core Engine)
 *
 * Implements the autonomous evolutionary loop:
 *   propose -> mutate -> execute -> evaluate -> select / revert
 *
 * Features:
 * - Deterministic file snapshotting and rollback
 * - Closed-loop fitness scoring and Lineage DAG tracking
 * - Stagnation circuit breaker
 * - Anser plugin exposing Evo tools
 */

import fs from "node:fs";
import path from "node:path";
import { LineageDag } from "./lineage_dag.js";
import { ClosedLoopEvaluator } from "./evaluator.js";
import { EvoWatchdog } from "./watchdog.js";
import { IS_WINDOWS } from "../../config.js";
import { toPosixWslPath, toWindowsPath, canonicalizePath } from "../../wsl_bridge.js";
import { skillsDir, splitFrontmatter, parseFrontmatter } from "../../skills.js";

export class EvoOperator {
  constructor(options = {}) {
    // P4i: canonicalize the Evo workspace root through the OS symlink/junction
    // resolution layer so a junction/symlink cwd is stored as its real path.
    // assertWithinWorkspace then compares realpath against a real root,
    // eliminating false containment errors while still catching real escapes.
    this.workspaceRoot = canonicalizePath(options.workspaceRoot || process.cwd());
    this.shell = options.shell;
    this.snapshotsDir = path.join(this.workspaceRoot, ".evo", "snapshots");

    // FX4 (D4): share the per-workspace singleton DAG with EvoLineageEngine so
    // both writers merge into one graph instead of clobbering each other.
    this.dag = LineageDag.forWorkspace(this.workspaceRoot);
    this.evaluator = new ClosedLoopEvaluator({ shell: this.shell });
    this.watchdog = new EvoWatchdog(options.watchdogOptions || {});

    this.activeCandidate = null;
    this._ensureDirs();
  }

  _ensureDirs() {
    try {
      fs.mkdirSync(this.snapshotsDir, { recursive: true });
    } catch {}
  }

  assertWithinWorkspace(targetPath) {
    let p = String(targetPath || "").trim();
    if (!IS_WINDOWS && (p.includes("\\") || /^[a-zA-Z]:/.test(p))) {
      p = toPosixWslPath(p);
    } else if (IS_WINDOWS && (p.startsWith("/mnt/") || p.startsWith("/"))) {
      p = toWindowsPath(p);
    }
    const normTarget = path.normalize(p);
    const normRoot = path.normalize(this.workspaceRoot);

    // P4i: canonicalize BOTH sides of the containment comparison through the
    // OS symlink/junction resolution layer so a junction-form target is
    // compared against the real root in the same "real" path space. Real
    // escapes (../outside, symlink-to-outside) still resolve outside the
    // real root and are caught.
    const realTarget = canonicalizePath(normTarget);
    const realRoot = canonicalizePath(normRoot);
    const rel = path.relative(realRoot, realTarget);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`SecurityContainmentError: Refusing file operation outside workspace root: '${targetPath}'`);
    }
  }

  /**
   * Resolves the target SKILL.md for a given skill name.
   * Searches workspace skills, workspace .agents skills, and repo-level skills.
   * If creating a new skill, defaults to <workspaceRoot>/skills/<name>/SKILL.md
   * (or <workspaceRoot>/.agents/skills/<name>/SKILL.md if .agents exists).
   * @param {string} skillName
   * @returns {string} full path
   */
  resolveSkillPath(skillName) {
    const cleanName = String(skillName || "").trim().replace(/\.md$/i, "");
    if (!cleanName || cleanName.includes("..") || cleanName.includes("/") || cleanName.includes("\\")) {
      throw new Error(`Invalid skill name '${skillName}': must be a simple identifier`);
    }

    const candidates = [
      path.join(this.workspaceRoot, ".agents", "skills", cleanName, "SKILL.md"),
      path.join(this.workspaceRoot, "skills", cleanName, "SKILL.md"),
    ];

    try {
      const repoSkills = path.join(skillsDir(), cleanName, "SKILL.md");
      candidates.push(repoSkills);
    } catch {}

    for (const cand of candidates) {
      if (fs.existsSync(cand)) {
        return canonicalizePath(cand);
      }
    }

    const agentsDir = path.join(this.workspaceRoot, ".agents", "skills");
    if (fs.existsSync(agentsDir)) {
      return path.join(agentsDir, cleanName, "SKILL.md");
    }
    return path.join(this.workspaceRoot, "skills", cleanName, "SKILL.md");
  }

  assertWithinWorkspaceOrSkills(targetPath) {
    let isInside = false;
    try {
      this.assertWithinWorkspace(targetPath);
      isInside = true;
    } catch {}
    if (isInside) return;

    try {
      let p = String(targetPath || "").trim();
      if (!IS_WINDOWS && (p.includes("\\") || /^[a-zA-Z]:/.test(p))) {
        p = toPosixWslPath(p);
      } else if (IS_WINDOWS && (p.startsWith("/mnt/") || p.startsWith("/"))) {
        p = toWindowsPath(p);
      }
      const sDir = canonicalizePath(skillsDir());
      const realTarget = canonicalizePath(path.normalize(p));
      const rel = path.relative(sDir, realTarget);
      if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
        return;
      }
    } catch {}

    throw new Error(`SecurityContainmentError: Refusing skill operation outside workspace and skills root: '${targetPath}'`);
  }

  /**
   * Validates frontmatter syntax and required fields on any modified skills.
   * @param {Array<object>} snapshotManifest
   * @returns {{ valid: boolean, errors: Array<string> }}
   */
  validateSkillFrontmatter(snapshotManifest) {
    const errors = [];
    const skillItems = (snapshotManifest || []).filter((m) => m.isSkill);
    for (const item of skillItems) {
      if (!fs.existsSync(item.fullPath)) {
        errors.push(`Skill file '${item.fullPath}' does not exist on disk after mutation`);
        continue;
      }
      try {
        const content = fs.readFileSync(item.fullPath, "utf8");
        const { frontmatter, body } = splitFrontmatter(content);
        if (!frontmatter || !frontmatter.trim()) {
          errors.push(`Skill '${item.skillName}' is missing required YAML frontmatter (--- markers)`);
          continue;
        }
        const meta = parseFrontmatter(frontmatter);
        if (!meta.name || !meta.name.trim()) {
          errors.push(`Skill '${item.skillName}' frontmatter is missing required 'name' field`);
        }
        if (!meta.description || !meta.description.trim()) {
          errors.push(`Skill '${item.skillName}' frontmatter is missing required 'description' field`);
        }
        if (!body || !body.trim()) {
          errors.push(`Skill '${item.skillName}' markdown workflow body is empty`);
        }
      } catch (err) {
        errors.push(`Skill '${item.skillName}' error parsing frontmatter: ${err.message}`);
      }
    }
    return { valid: errors.length === 0, errors };
  }

  /**
   * Proposes a new mutation candidate and snapshots target files and/or skills for deterministic rollback.
   *
   * @param {object} params
   * @param {string} params.hypothesis Description of the code variation
   * @param {Array<string>} [params.files_to_modify] List of file paths to be mutated
   * @param {Array<string>} [params.skills_to_modify] Optional list of skill names to evolve
   * @returns {object} The created candidate node
   */
  async proposeCandidate({ hypothesis, files_to_modify = [], skills_to_modify = [] }) {
    if (!hypothesis || typeof hypothesis !== "string") {
      throw new Error("Evo hypothesis is required to propose a candidate.");
    }
    const candidateId = `cand_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const snapshotDir = path.join(this.snapshotsDir, candidateId);
    fs.mkdirSync(snapshotDir, { recursive: true });

    // Snapshot existing versions of files and record manifest
    const snapshotManifest = [];
    for (const relPath of files_to_modify) {
      const fullPath = path.isAbsolute(relPath) ? relPath : path.resolve(this.workspaceRoot, relPath);
      this.assertWithinWorkspace(fullPath);
      const existed = fs.existsSync(fullPath) && fs.statSync(fullPath).isFile();
      let targetBackup = null;
      if (existed) {
        targetBackup = path.join(snapshotDir, encodeURIComponent(relPath));
        fs.copyFileSync(fullPath, targetBackup);
      }
      snapshotManifest.push({ relPath, fullPath, targetBackup, existed, isSkill: false });
    }

    // Snapshot procedural skills
    for (const skillName of skills_to_modify) {
      const skillPath = this.resolveSkillPath(skillName);
      this.assertWithinWorkspaceOrSkills(skillPath);
      const existed = fs.existsSync(skillPath) && fs.statSync(skillPath).isFile();
      const relPath = path.relative(this.workspaceRoot, skillPath);
      let targetBackup = null;
      if (existed) {
        targetBackup = path.join(snapshotDir, `skill_${encodeURIComponent(skillName)}.md`);
        fs.copyFileSync(skillPath, targetBackup);
      }
      snapshotManifest.push({
        relPath,
        fullPath: skillPath,
        targetBackup,
        existed,
        isSkill: true,
        skillName,
      });
    }

    fs.writeFileSync(path.join(snapshotDir, "manifest.json"), JSON.stringify(snapshotManifest, null, 2), "utf8");

    const node = this.dag.addCandidate({
      id: candidateId,
      hypothesis,
      filesModified: files_to_modify,
      skillsModified: skills_to_modify,
      metrics: {
        snapshotDir,
        snapshotCount: snapshotManifest.filter((m) => m.existed).length,
      },
    });

    this.activeCandidate = {
      node,
      snapshotDir,
      snapshotManifest,
      skillsModified: skills_to_modify,
    };

    const snapshottedCount = snapshotManifest.filter((m) => m.existed).length;
    return {
      candidate_id: candidateId,
      parent_id: node.parentId,
      hypothesis,
      files_snapshotted: snapshottedCount,
      skills_snapshotted: snapshotManifest.filter((m) => m.isSkill && m.existed).length,
      message: `Candidate ${candidateId} registered. ${snapshottedCount} target artifact(s) safely snapshotted for rollback. You may now perform mutations.`,
    };
  }

  /**
   * Evaluates the candidate using closed-loop execution.
   *
   * @param {object} params
   * @param {string} params.command Test, lint, or benchmark command
   * @param {string} [params.primary_metric] Metric to prioritize ("throughput", "latency_ms", "tests_passed")
   * @param {number} [params.timeout_ms]
   */
  async evaluateCandidate({ command, primary_metric = "tests_passed", timeout_ms = 120_000 }) {
    if (!this.activeCandidate) {
      throw new Error("No active Evo candidate to evaluate. Call evo_propose_candidate first.");
    }

    const candidateId = this.activeCandidate.node.id;

    // Validate skill frontmatter before running evaluation command
    const skillValidation = this.validateSkillFrontmatter(this.activeCandidate.snapshotManifest);
    if (!skillValidation.valid) {
      this.dag.updateMetrics(candidateId, {
        fitness: 0,
        evalCommand: command,
        evalMetrics: { tests_passed: 0, skill_validation: "failed" },
        exitCode: 1,
        passed: false,
      });
      return {
        candidate_id: candidateId,
        passed: false,
        fitness: 0,
        best_known_fitness: this.dag.getBestCandidate()?.metrics?.fitness ?? 0,
        is_improvement: false,
        metrics: { skill_errors: skillValidation.errors },
        failure_digest: `SkillFrontmatterValidationError: ${skillValidation.errors.join("; ")}`,
        failure_detail: { errors: skillValidation.errors },
        stdout: "",
        stderr: skillValidation.errors.join("\n"),
        recommendation: "Candidate skill has malformed frontmatter. Fix formatting or call evo_revert_candidate.",
      };
    }

    const evalResult = await this.evaluator.evaluate({
      command,
      cwd: this.workspaceRoot,
      primaryMetric: primary_metric,
      timeout_ms,
    });
    this.dag.updateMetrics(candidateId, {
      fitness: evalResult.fitness,
      evalCommand: command,
      evalMetrics: evalResult.metrics,
      exitCode: evalResult.exitCode,
      passed: evalResult.passed,
    });

    const best = this.dag.getBestCandidate();
    const isImprovement = evalResult.passed && evalResult.fitness >= (best?.metrics?.fitness ?? -Infinity);

    return {
      candidate_id: candidateId,
      passed: evalResult.passed,
      fitness: evalResult.fitness,
      best_known_fitness: best?.metrics?.fitness ?? 0,
      is_improvement: isImprovement,
      metrics: evalResult.metrics,
      failure_digest: evalResult.failureDigest?.summary || null,
      failure_detail: evalResult.failureDigest || null,
      stdout: evalResult.stdout.slice(0, 1000),
      stderr: evalResult.stderr.slice(0, 1000),
      recommendation: isImprovement
        ? "Fitness improved or verified. Call evo_select_candidate to accept."
        : "Candidate failed or degraded fitness. Call evo_revert_candidate to cleanly rollback.",
    };
  }

  /**
   * Accepts the candidate and advances the lineage head.
   *
   * @param {object} params
   * @param {string} [params.candidate_id]
   */
  async selectCandidate({ candidate_id } = {}) {
    const id = candidate_id || this.activeCandidate?.node?.id;
    if (!id) {
      throw new Error("No candidate specified to select");
    }

    if (this.activeCandidate && this.activeCandidate.snapshotManifest) {
      const skillValidation = this.validateSkillFrontmatter(this.activeCandidate.snapshotManifest);
      if (!skillValidation.valid) {
        throw new Error(`Cannot select candidate: Skill frontmatter validation failed: ${skillValidation.errors.join("; ")}`);
      }
    }

    this.dag.updateMetrics(id, {}, "accepted");
    this.watchdog.recordCandidateOutcome("accepted");
    this.activeCandidate = null;

    return {
      candidate_id: id,
      status: "accepted",
      current_head: id,
      message: `Candidate ${id} accepted into lineage DAG. Workspace changes preserved as new baseline.`,
    };
  }

  /**
   * Deterministically rolls back files to pre-mutation snapshot.
   *
   * @param {object} params
   * @param {string} [params.candidate_id]
   */
  async revertCandidate({ candidate_id } = {}) {
    const id = candidate_id || this.activeCandidate?.node?.id;
    if (!id) {
      throw new Error("No candidate specified to revert");
    }

    // A3 Fix: Validate candidate in DAG before touching any files!
    const node = this.dag.nodes.get(id);
    if (!node) {
      throw new Error(`Candidate '${id}' does not exist in lineage DAG`);
    }
    if (node.metrics?.status === "accepted") {
      throw new Error(`Candidate '${id}' is already accepted into baseline and cannot be reverted.`);
    }

    const snapshotDir = path.join(this.snapshotsDir, id);
    const manifestFile = path.join(snapshotDir, "manifest.json");
    let revertedCount = 0;

    if (fs.existsSync(manifestFile)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
        for (const item of manifest) {
          if (!item.existed) {
            // A1 Fix: Newly created file that did not exist before mutation -> delete it cleanly!
            if (fs.existsSync(item.fullPath)) {
              try {
                if (item.isSkill) {
                  this.assertWithinWorkspaceOrSkills(item.fullPath);
                } else {
                  this.assertWithinWorkspace(item.fullPath);
                }
                fs.unlinkSync(item.fullPath);
                revertedCount++;
                if (item.isSkill) {
                  const parentDir = path.dirname(item.fullPath);
                  try {
                    if (fs.existsSync(parentDir) && fs.readdirSync(parentDir).length === 0) {
                      fs.rmdirSync(parentDir);
                    }
                  } catch {}
                }
              } catch (err) {
                console.error(`[EvoOperator] Error deleting new file ${item.fullPath}:`, err.message);
              }
            }
          } else if (item.targetBackup && fs.existsSync(item.targetBackup)) {
            try {
              if (item.isSkill) {
                this.assertWithinWorkspaceOrSkills(item.fullPath);
              } else {
                this.assertWithinWorkspace(item.fullPath);
              }
              fs.copyFileSync(item.targetBackup, item.fullPath);
              revertedCount++;
            } catch (err) {
              console.error(`[EvoOperator] Error reverting ${item.fullPath}:`, err.message);
            }
          }
        }
      } catch {}
    } else if (fs.existsSync(snapshotDir)) {
      const files = fs.readdirSync(snapshotDir);
      for (const f of files) {
        if (f === "manifest.json") continue;
        const relPath = decodeURIComponent(f);
        const fullPath = path.resolve(this.workspaceRoot, relPath);
        const backupPath = path.join(snapshotDir, f);
        try {
          fs.copyFileSync(backupPath, fullPath);
          revertedCount++;
        } catch (err) {
          console.error(`[EvoOperator] Error reverting ${fullPath}:`, err.message);
        }
      }
    }

    this.dag.updateMetrics(id, {}, "rejected");
    const watchdogStatus = this.watchdog.recordCandidateOutcome("rejected");
    this.activeCandidate = null;

    return {
      candidate_id: id,
      status: "rejected",
      files_reverted: revertedCount,
      watchdog: watchdogStatus,
      message: `Candidate ${id} reverted. Workspace restored cleanly to parent snapshot.`,
    };
  }

  /**
   * Returns complete overview of evolutionary lineage and current best score.
   */
  getStatus() {
    return {
      summary: this.dag.toSummary(),
      activeCandidate: this.activeCandidate?.node?.id || null,
      watchdogTripped: this.watchdog.stagnationTripped,
    };
  }
}

/**
 * Anser Plugin to mount EvoOperator into Context.
 */
export function evoPlugin(ctx, options = {}) {
  const shell = ctx.get("shell");
  const evo = new EvoOperator({
    workspaceRoot: options.workspaceRoot || process.cwd(),
    shell,
    watchdogOptions: options.watchdogOptions,
  });

  ctx.provide("evo", evo);

  ctx.registerTool("evo_propose_candidate", {
    description: "Evo: Propose an evolutionary code mutation hypothesis and snapshot target files for rollback",
    parameters: {
      type: "object",
      properties: {
        hypothesis: { type: "string", description: "The rationale and objective of this code variation" },
        files_to_modify: {
          type: "array",
          items: { type: "string" },
          description: "List of file paths that will be mutated in this variation",
        },
        skills_to_modify: {
          type: "array",
          items: { type: "string" },
          description: "Optional list of skill names (from skills/<name>/SKILL.md or .agents/skills/<name>/SKILL.md) to evolve",
        },
      },
      required: ["hypothesis"],
    },
    execute: (args) => evo.proposeCandidate(args),
  });

  ctx.registerTool("evo_evaluate_candidate", {
    description: "Evo: Execute closed-loop verification command and compute fitness score",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Verification command (e.g. npm test, pytest, node test.js)" },
        primary_metric: {
          type: "string",
          enum: ["tests_passed", "throughput", "latency_ms"],
          default: "tests_passed",
        },
        timeout_ms: { type: "integer", default: 120000 },
      },
      required: ["command"],
    },
    execute: (args) => evo.evaluateCandidate(args),
  });

  ctx.registerTool("evo_select_candidate", {
    description: "Evo: Accept candidate mutation into lineage DAG when tests pass or fitness improves",
    parameters: {
      type: "object",
      properties: {
        candidate_id: { type: "string", description: "Candidate ID to accept (optional, defaults to active)" },
      },
    },
    execute: (args) => evo.selectCandidate(args),
  });

  ctx.registerTool("evo_revert_candidate", {
    description: "Evo: Deterministically rollback workspace files to pre-mutation snapshot when variation fails",
    parameters: {
      type: "object",
      properties: {
        candidate_id: { type: "string", description: "Candidate ID to revert (optional, defaults to active)" },
      },
    },
    execute: (args) => evo.revertCandidate(args),
  });

  ctx.registerTool("evo_status", {
    description: "Evo: Query the evolutionary candidate lineage DAG and current Pareto frontier",
    parameters: { type: "object", properties: {} },
    execute: () => evo.getStatus(),
  });
}
