import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { LineageDag } from "./harness/evo/lineage_dag.js";

const execFileAsync = promisify(execFile);

/**
 * D1: honest status mapping for the legacy `state` view. Never fabricates a
 * failure: only a genuinely rejected candidate is FAILED; neutral/pending/
 * unknown map to their honest names.
 */
function mapStatusToLegacy(status) {
  const s = typeof status === "string" ? status.trim().toLowerCase() : "";
  if (s === "accepted") return "ACCEPTED";
  if (s === "rejected") return "FAILED";
  if (s === "pending") return "PENDING";
  if (s === "neutral") return "NEUTRAL";
  return "UNKNOWN";
}

/**
 * Evo Lineage Engine (Aug 2026 SOTA Specification)
 * 
 * Delegates to the unified LineageDag engine to guarantee atomic persistence,
 * single-writer synchronization, and graph-based candidate tracking.
 *
 * FX4 (D4): the DAG is a per-workspace SINGLETON (LineageDag.forWorkspace) so
 * this engine and the EvoOperator share one in-memory graph and one
 * read-modify-write persist path — no more last-writer-wins clobbering.
 */
export class EvoLineageEngine {
  constructor(cwd) {
    this.cwd = cwd;
    this.evoDir = path.join(cwd, ".evo");
    this.dag = LineageDag.forWorkspace(cwd);
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
        // D1: honest status — never fabricate a failure for a neutral/pending/
        // unknown candidate.
        status: mapStatusToLegacy(n.metrics?.status),
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

  /**
   * D2: returns the current git commit SHA, or null when it genuinely cannot
   * be determined (no git repo, git unavailable, or a non-zero exit). Callers
   * must treat null as "unknown" — never as a fabricated commit hash.
   */
  async getCurrentCommit() {
    try {
      const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: this.cwd });
      const sha = stdout.trim();
      return sha || null;
    } catch {
      return null;
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
    // D2: getCurrentCommit() returns null when the commit is genuinely unknown
    // (no repo / git unavailable). Record that as an honest null parentage —
    // never a fabricated commit hash.
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
