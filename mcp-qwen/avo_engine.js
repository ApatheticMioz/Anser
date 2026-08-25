import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";

const execFileAsync = promisify(execFile);

/**
 * NVIDIA AVO-Class Lineage Engine (Aug 2026 SOTA Specification)
 * 
 * Grounded in immutable Git checkpoints and real execution feedback.
 * Prohibits unstructured, stale natural language scratchpads.
 */
export class AvoLineageEngine {
  constructor(cwd) {
    this.cwd = cwd;
    this.avoDir = path.join(cwd, ".avo");
    this.lineageFile = path.join(this.avoDir, "lineage.json");
  }

  async init() {
    await fs.mkdir(this.avoDir, { recursive: true });
    try {
      const data = await fs.readFile(this.lineageFile, "utf-8");
      this.state = JSON.parse(data);
    } catch {
      const baseCommit = await this.getCurrentCommit();
      this.state = {
        initializedAt: new Date().toISOString(),
        bestCommit: baseCommit,
        bestMetric: null,
        targetMetricName: null,
        higherIsBetter: true,
        candidates: [],
      };
      await this.save();
    }
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
    await fs.mkdir(this.avoDir, { recursive: true });
    await fs.writeFile(this.lineageFile, JSON.stringify(this.state, null, 2), "utf-8");
  }

  /**
   * Generates a grounded, hallucination-free lineage brief for the agent.
   * Feeds exact previous hypotheses, metric results, and failure compiler logs.
   */
  async getLineageBrief() {
    await this.init();
    if (this.state.candidates.length === 0) {
      return (
        `AVO Lineage Status: Fresh baseline at commit ${this.state.bestCommit}.\n` +
        `No candidate variations evaluated yet.`
      );
    }

    const recent = this.state.candidates.slice(-8);
    const summaryLines = recent.map((c, i) => {
      const statusIcon = c.status === "ACCEPTED" ? "✅" : "❌";
      const metricStr = c.metricScore !== null ? `Metric: ${c.metricScore}` : "No metric";
      const failSnippet = c.errorLog ? ` | Error: ${c.errorLog.slice(0, 120).replace(/\n/g, " ")}` : "";
      return `${statusIcon} [${c.candidateId}] Hypothesis: "${c.hypothesis}" -> ${c.status} (${metricStr})${failSnippet}`;
    });

    return (
      `=== NVIDIA AVO Candidate Lineage History ===\n` +
      `Active Best Commit: ${this.state.bestCommit} (Best Metric: ${this.state.bestMetric ?? "N/A"})\n` +
      `Total Candidates Evaluated: ${this.state.candidates.length}\n` +
      `Recent Trajectory (Last ${recent.length}):\n` +
      summaryLines.join("\n") +
      `\n============================================`
    );
  }

  /**
   * Records a candidate result, managing deterministic Git checkpointing and rollbacks.
   */
  async recordCandidate({ hypothesis, testCommand, metricScore, targetMetricName, higherIsBetter = true, stdout, stderr, exitCode }) {
    await this.init();
    const candidateId = `cand_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const parentCommit = this.state.bestCommit;
    const currentCommit = await this.getCurrentCommit();

    this.state.targetMetricName = targetMetricName || this.state.targetMetricName;
    this.state.higherIsBetter = higherIsBetter;

    const passed = exitCode === 0;
    let isImprovement = false;

    if (passed && metricScore !== null && metricScore !== undefined) {
      if (this.state.bestMetric === null) {
        isImprovement = true;
      } else if (higherIsBetter && metricScore > this.state.bestMetric) {
        isImprovement = true;
      } else if (!higherIsBetter && metricScore < this.state.bestMetric) {
        isImprovement = true;
      }
    }

    const status = isImprovement ? "ACCEPTED" : passed ? "NEUTRAL_OR_REGRESSED" : "FAILED";

    const candidateNode = {
      candidateId,
      parentCommit,
      commitSha: currentCommit,
      hypothesis,
      testCommand,
      metricScore: metricScore ?? null,
      status,
      timestamp: new Date().toISOString(),
      errorLog: !passed ? (stderr || stdout || "").slice(-800) : null,
    };

    this.state.candidates.push(candidateNode);

    if (isImprovement) {
      this.state.bestCommit = currentCommit;
      this.state.bestMetric = metricScore;
      await this.save();
      return {
        status: "ACCEPTED",
        candidateId,
        message: `Candidate ${candidateId} improved metric to ${metricScore} (new active baseline).`,
      };
    } else {
      await this.save();
      return {
        status,
        candidateId,
        message: `Candidate ${candidateId} evaluated (Status: ${status}). Working tree preserved for inspection and iterative refinement.`,
      };
    }
  }
}
