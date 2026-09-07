import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { LineageDag } from "./harness/evo/lineage_dag.js";

const execFileAsync = promisify(execFile);

/**
 * Evo Lineage Engine (Aug 2026 SOTA Specification)
 * 
 * Delegates to the unified LineageDag engine to guarantee atomic persistence,
 * single-writer synchronization, and graph-based candidate tracking.
 */
export class EvoLineageEngine {
  constructor(cwd) {
    this.cwd = cwd;
    this.evoDir = path.join(cwd, ".evo");
    this.dag = new LineageDag({ workspaceRoot: cwd });
  }

  async init() {
    this.dag._load();
  }

  get state() {
    // Compatibility view for legacy callers
    const nodes = Array.from(this.dag.nodes.values());
    const candidates = nodes
      .filter((n) => n.id !== "baseline")
      .map((n) => ({
        candidateId: n.id,
        parentCommit: n.parentId,
        commitSha: n.metrics?.commitSha,
        hypothesis: n.hypothesis,
        filesModified: n.filesModified,
        metricScore: n.metrics?.fitness ?? n.metrics?.score ?? null,
        status: n.metrics?.status === "accepted" ? "ACCEPTED" : "FAILED",
        timestamp: n.timestamp,
        errorLog: n.metrics?.errorLog ?? null,
      }));

    const best = this.dag.getBestCandidate();
    return {
      initializedAt: nodes[0]?.timestamp || new Date().toISOString(),
      bestCommit: best?.metrics?.commitSha || "baseline",
      bestMetric: best?.metrics?.fitness ?? null,
      targetMetricName: null,
      higherIsBetter: true,
      candidates,
    };
  }

  async getCurrentCommit() {
    try {
      const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: this.cwd });
      return stdout.trim();
    } catch {
      return "uncommitted_init";
    }
  }

  async save() {
    this.dag.persist();
  }

  /**
   * Generates a grounded, hallucination-free lineage brief for the agent.
   */
  async getLineageBrief() {
    await this.init();
    const nodes = Array.from(this.dag.nodes.values()).filter((n) => n.id !== "baseline");
    if (nodes.length === 0) {
      return (
        `Evo Lineage Status: Fresh baseline.\n` +
        `No candidate variations evaluated yet.`
      );
    }

    const recent = nodes.slice(-8);
    const summaryLines = recent.map((n) => {
      const statusIcon = n.metrics?.status === "accepted" ? "[OK]" : "[FAIL]";
      const metricStr = n.metrics?.fitness !== null && n.metrics?.fitness !== undefined
        ? `Metric: ${n.metrics.fitness}`
        : "No metric";
      const failSnippet = n.metrics?.errorLog ? ` | Error: ${n.metrics.errorLog.slice(0, 120).replace(/\n/g, " ")}` : "";
      return `${statusIcon} [${n.id}] Hypothesis: "${n.hypothesis}" -> ${n.metrics?.status?.toUpperCase()} (${metricStr})${failSnippet}`;
    });

    const best = this.dag.getBestCandidate();
    return (
      `=== Evo Candidate Lineage History ===\n` +
      `Active Head: ${this.dag.currentHeadId} (Best Score: ${best?.metrics?.fitness ?? "N/A"})\n` +
      `Total Candidates Evaluated: ${nodes.length}\n` +
      `Recent Trajectory (Last ${recent.length}):\n` +
      summaryLines.join("\n") +
      `\n============================================`
    );
  }

  async getLineageContext() {
    return this.getLineageBrief();
  }

  extractMetric(output, name) {
    if (!output || !name) return null;
    let value = null;
    for (const line of String(output).split(/\r?\n/)) {
      if (!line.toLowerCase().includes(String(name).toLowerCase())) continue;
      const nums = line.match(/-?\d+(?:\.\d+)?/g);
      if (nums && nums.length > 0) value = Number(nums[nums.length - 1]);
    }
    return value === null || Number.isNaN(value) ? null : value;
  }

  async recordCandidate({
    hypothesis,
    testCommand,
    metricScore,
    metricValue,
    targetMetricName,
    metricName,
    higherIsBetter = true,
    stdout,
    stderr,
    testStderr,
    exitCode,
    filesModified,
    status: callerStatus,
  } = {}) {
    await this.init();
    const metric = metricScore ?? metricValue ?? null;
    const errText = stderr ?? testStderr ?? "";
    const passed =
      exitCode !== undefined ? exitCode === 0 : callerStatus !== "FAILED";
    const candidateId = `cand_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const currentCommit = await this.getCurrentCommit();

    const best = this.dag.getBestCandidate();
    const bestScore = best?.metrics?.fitness ?? null;

    let isImprovement = false;
    if (passed && metric !== null && metric !== undefined) {
      if (bestScore === null) {
        isImprovement = true;
      } else if (higherIsBetter && metric > bestScore) {
        isImprovement = true;
      } else if (!higherIsBetter && metric < bestScore) {
        isImprovement = true;
      }
    }

    const status = isImprovement
      ? "accepted"
      : passed
        ? "neutral"
        : "rejected";

    const node = this.dag.addCandidate({
      id: candidateId,
      parentId: this.dag.currentHeadId,
      hypothesis,
      filesModified: filesModified ?? [],
      metrics: {
        fitness: metric,
        status,
        commitSha: currentCommit,
        errorLog: !passed ? (errText || stdout || "").slice(-800) : null,
      },
    });

    if (isImprovement) {
      this.dag.currentHeadId = candidateId;
      this.dag.persist();
      return {
        status: "ACCEPTED",
        candidateId,
        message: `Candidate ${candidateId} improved metric to ${metric} (new active baseline).`,
      };
    } else {
      return {
        status: status.toUpperCase(),
        candidateId,
        message: `Candidate ${candidateId} evaluated (Status: ${status.toUpperCase()}). Working tree preserved for inspection.`,
      };
    }
  }
}
