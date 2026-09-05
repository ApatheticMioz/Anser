/**
 * NVIDIA AVO Operator (Agentic Variation Operators Core Engine)
 *
 * Implements the autonomous evolutionary loop:
 *   propose -> mutate -> execute -> evaluate -> select / revert
 *
 * Features:
 * - Deterministic file snapshotting and rollback
 * - Closed-loop fitness scoring and Lineage DAG tracking
 * - Stagnation circuit breaker
 * - Cordis plugin exposing AVO tools to Qwen
 */

import fs from "node:fs";
import path from "node:path";
import { LineageDag } from "./lineage_dag.js";
import { ClosedLoopEvaluator } from "./evaluator.js";
import { AvoWatchdog } from "./watchdog.js";
import { IS_WINDOWS } from "../../config.js";
import { toPosixWslPath, toWindowsPath, canonicalizePath } from "../../wsl_bridge.js";

export class AvoOperator {
  constructor(options = {}) {
    // P4i: canonicalize the AVO workspace root through the OS symlink/junction
    // resolution layer so a junction/symlink cwd is stored as its real path.
    // assertWithinWorkspace then compares realpath against a real root,
    // eliminating false containment errors while still catching real escapes.
    this.workspaceRoot = canonicalizePath(options.workspaceRoot || process.cwd());
    this.shell = options.shell;
    this.snapshotsDir = path.join(this.workspaceRoot, ".avo", "snapshots");

    this.dag = new LineageDag({ workspaceRoot: this.workspaceRoot });
    this.evaluator = new ClosedLoopEvaluator({ shell: this.shell });
    this.watchdog = new AvoWatchdog(options.watchdogOptions || {});

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
   * Proposes a new mutation candidate and snapshots target files for deterministic rollback.
   *
   * @param {object} params
   * @param {string} params.hypothesis Description of the code variation
   * @param {Array<string>} [params.files_to_modify] List of file paths to be mutated
   * @returns {object} The created candidate node
   */
  async proposeCandidate({ hypothesis, files_to_modify = [] }) {
    const candidateId = `cand_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const snapshotDir = path.join(this.snapshotsDir, candidateId);
    fs.mkdirSync(snapshotDir, { recursive: true });

    // Snapshot existing versions of files and record manifest
    const snapshotManifest = [];
    for (const relPath of files_to_modify) {
      const fullPath = path.isAbsolute(relPath) ? relPath : path.resolve(this.workspaceRoot, relPath);
      const existed = fs.existsSync(fullPath) && fs.statSync(fullPath).isFile();
      let targetBackup = null;
      if (existed) {
        targetBackup = path.join(snapshotDir, encodeURIComponent(relPath));
        fs.copyFileSync(fullPath, targetBackup);
      }
      snapshotManifest.push({ relPath, fullPath, targetBackup, existed });
    }
    fs.writeFileSync(path.join(snapshotDir, "manifest.json"), JSON.stringify(snapshotManifest, null, 2), "utf8");

    const node = this.dag.addCandidate({
      id: candidateId,
      hypothesis,
      filesModified: files_to_modify,
      metrics: {
        snapshotDir,
        snapshotCount: snapshotManifest.filter((m) => m.existed).length,
      },
    });

    this.activeCandidate = {
      node,
      snapshotDir,
      snapshotManifest,
    };

    return {
      candidate_id: candidateId,
      parent_id: node.parentId,
      hypothesis,
      files_snapshotted: snapshotManifest.filter((m) => m.existed).length,
      message: `Candidate ${candidateId} registered. Workspace files safely snapshotted for rollback. You may now perform code mutations.`,
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
      throw new Error("No active AVO candidate to evaluate. Call avo_propose_candidate first.");
    }

    const evalResult = await this.evaluator.evaluate({
      command,
      cwd: this.workspaceRoot,
      primaryMetric: primary_metric,
      timeout_ms,
    });

    const candidateId = this.activeCandidate.node.id;
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
        ? "Fitness improved or verified. Call avo_select_candidate to accept."
        : "Candidate failed or degraded fitness. Call avo_revert_candidate to cleanly rollback.",
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
                this.assertWithinWorkspace(item.fullPath);
                fs.unlinkSync(item.fullPath);
                revertedCount++;
              } catch (err) {
                console.error(`[AvoOperator] Error deleting new file ${item.fullPath}:`, err.message);
              }
            }
          } else if (item.targetBackup && fs.existsSync(item.targetBackup)) {
            try {
              this.assertWithinWorkspace(item.fullPath);
              fs.copyFileSync(item.targetBackup, item.fullPath);
              revertedCount++;
            } catch (err) {
              console.error(`[AvoOperator] Error reverting ${item.fullPath}:`, err.message);
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
          console.error(`[AvoOperator] Error reverting ${fullPath}:`, err.message);
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
 * Cordis Plugin to mount AvoOperator into Context.
 */
export function avoPlugin(ctx, options = {}) {
  const shell = ctx.get("shell");
  const avo = new AvoOperator({
    workspaceRoot: options.workspaceRoot || process.cwd(),
    shell,
    watchdogOptions: options.watchdogOptions,
  });

  ctx.provide("avo", avo);

  ctx.registerTool("avo_propose_candidate", {
    description: "NVIDIA AVO: Propose an evolutionary code mutation hypothesis and snapshot target files for rollback",
    parameters: {
      type: "object",
      properties: {
        hypothesis: { type: "string", description: "The rationale and objective of this code variation" },
        files_to_modify: {
          type: "array",
          items: { type: "string" },
          description: "List of file paths that will be mutated in this variation",
        },
      },
      required: ["hypothesis"],
    },
    execute: (args) => avo.proposeCandidate(args),
  });

  ctx.registerTool("avo_evaluate_candidate", {
    description: "NVIDIA AVO: Execute closed-loop verification command and compute fitness score",
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
    execute: (args) => avo.evaluateCandidate(args),
  });

  ctx.registerTool("avo_select_candidate", {
    description: "NVIDIA AVO: Accept candidate mutation into lineage DAG when tests pass or fitness improves",
    parameters: {
      type: "object",
      properties: {
        candidate_id: { type: "string", description: "Candidate ID to accept (optional, defaults to active)" },
      },
    },
    execute: (args) => avo.selectCandidate(args),
  });

  ctx.registerTool("avo_revert_candidate", {
    description: "NVIDIA AVO: Deterministically rollback workspace files to pre-mutation snapshot when variation fails",
    parameters: {
      type: "object",
      properties: {
        candidate_id: { type: "string", description: "Candidate ID to revert (optional, defaults to active)" },
      },
    },
    execute: (args) => avo.revertCandidate(args),
  });

  ctx.registerTool("avo_status", {
    description: "NVIDIA AVO: Query the evolutionary candidate lineage DAG and current Pareto frontier",
    parameters: { type: "object", properties: {} },
    execute: () => avo.getStatus(),
  });
}
