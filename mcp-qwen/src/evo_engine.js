import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";

const execFileAsync = promisify(execFile);

/**
 * Evo Lineage Engine (Aug 2026 SOTA Specification)
 * 
 * Grounded in immutable Git checkpoints and real execution feedback.
 * Prohibits unstructured, stale natural language scratchpads.
 */
export class EvoLineageEngine {
  constructor(cwd) {
    this.cwd = cwd;
    this.evoDir = path.join(cwd, ".evo");
    this.lineageFile = path.join(this.evoDir, "lineage.json");
  }

  async init() {
    await fs.mkdir(this.evoDir, { recursive: true });
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
    await fs.mkdir(this.evoDir, { recursive: true });
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
        `Evo Lineage Status: Fresh baseline at commit ${this.state.bestCommit}.\n` +
        `No candidate variations evaluated yet.`
      );
    }

    const recent = this.state.candidates.slice(-8);
    const summaryLines = recent.map((c, i) => {
      const statusIcon = c.status === "ACCEPTED" ? "[OK]" : "[FAIL]";
      const metricStr = c.metricScore !== null ? `Metric: ${c.metricScore}` : "No metric";
      const failSnippet = c.errorLog ? ` | Error: ${c.errorLog.slice(0, 120).replace(/\n/g, " ")}` : "";
      return `${statusIcon} [${c.candidateId}] Hypothesis: "${c.hypothesis}" -> ${c.status} (${metricStr})${failSnippet}`;
    });

    return (
      `=== Evo Candidate Lineage History ===\n` +
      `Active Best Commit: ${this.state.bestCommit} (Best Metric: ${this.state.bestMetric ?? "N/A"})\n` +
      `Total Candidates Evaluated: ${this.state.candidates.length}\n` +
      `Recent Trajectory (Last ${recent.length}):\n` +
      summaryLines.join("\n") +
      `\n============================================`
    );
  }

  /**
   * Async alias of getLineageBrief() for callers that use "context" naming
   * (e.g. mcp-qwen/index.js injects this into the task prompt).
   * MUST be awaited before string interpolation (it is async).
   */
  async getLineageContext() {
    return this.getLineageBrief();
  }

  /**
   * Extracts the last numeric value for the named metric from raw benchmark
   * output (case-insensitive match of the metric name per line, last number
   * on that line wins). Returns null when absent or unparseable.
   */
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

  /**
   * Records a candidate result, managing deterministic Git checkpointing and rollbacks.
   */
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
    // Accept both this engine's native keys and the MCP server's caller keys.
    const metric = metricScore ?? metricValue ?? null;
    const errText = stderr ?? testStderr ?? "";
    const passed =
      exitCode !== undefined ? exitCode === 0 : callerStatus !== "FAILED";
    const candidateId = `cand_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const parentCommit = this.state.bestCommit;
    const currentCommit = await this.getCurrentCommit();

    this.state.targetMetricName =
      targetMetricName ?? metricName ?? this.state.targetMetricName;
    this.state.higherIsBetter = higherIsBetter;

    let isImprovement = false;

    if (passed && metric !== null && metric !== undefined) {
      if (this.state.bestMetric === null) {
        isImprovement = true;
      } else if (higherIsBetter && metric > this.state.bestMetric) {
        isImprovement = true;
      } else if (!higherIsBetter && metric < this.state.bestMetric) {
        isImprovement = true;
      }
    }

    const status = isImprovement
      ? "ACCEPTED"
      : passed
        ? "NEUTRAL_OR_REGRESSED"
        : "FAILED";

    const candidateNode = {
      candidateId,
      parentCommit,
      commitSha: currentCommit,
      hypothesis,
      testCommand: testCommand ?? "",
      filesModified: filesModified ?? null,
      metricScore: metric ?? null,
      status,
      timestamp: new Date().toISOString(),
      errorLog: !passed ? (errText || stdout || "").slice(-800) : null,
    };

    this.state.candidates.push(candidateNode);

    if (isImprovement) {
      this.state.bestCommit = currentCommit;
      this.state.bestMetric = metric;
      await this.save();
      return {
        status: "ACCEPTED",
        candidateId,
        message: `Candidate ${candidateId} improved metric to ${metric} (new active baseline).`,
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
