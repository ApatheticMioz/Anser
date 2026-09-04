/**
 * Lineage DAG Service (NVIDIA AVO Candidate Graph)
 *
 * Tracks the tree of evolutionary variations, mutation hypotheses,
 * test outcomes, and fitness scores in `.avo/lineage.json`.
 */

import fs from "node:fs";
import path from "node:path";

export class LineageDag {
  constructor(options = {}) {
    this.workspaceRoot = options.workspaceRoot || process.cwd();
    this.avoDir = path.join(this.workspaceRoot, ".avo");
    this.dagFile = path.join(this.avoDir, "lineage.json");
    this.nodes = new Map();
    this.rootId = null;
    this.currentHeadId = null;

    this._load();
  }

  _ensureAvoDir() {
    try {
      fs.mkdirSync(this.avoDir, { recursive: true });
    } catch {}
  }

  _load() {
    this._ensureAvoDir();
    if (fs.existsSync(this.dagFile)) {
      try {
        const raw = fs.readFileSync(this.dagFile, "utf8");
        const data = JSON.parse(raw);
        this.rootId = data.rootId || null;
        this.currentHeadId = data.currentHeadId || null;
        if (Array.isArray(data.nodes)) {
          for (const n of data.nodes) {
            this.nodes.set(n.id, n);
          }
        }
        return;
      } catch (err) {
        // Quarantine corrupt file rather than silently overwriting it
        const corruptBackup = path.join(this.avoDir, `lineage.json.corrupt-${Date.now()}`);
        console.error(`[LineageDag] Corrupt lineage.json detected. Quarantining to ${corruptBackup}:`, err.message);
        try {
          fs.copyFileSync(this.dagFile, corruptBackup);
        } catch {}
      }
    }

    // Initialize root baseline node
    const rootNode = {
      id: "baseline",
      parentId: null,
      hypothesis: "Initial baseline configuration",
      filesModified: [],
      metrics: { fitness: 0, status: "accepted" },
      timestamp: new Date().toISOString(),
    };
    this.rootId = "baseline";
    this.currentHeadId = "baseline";
    this.nodes.set("baseline", rootNode);
    this.persist();
  }

  persist() {
    this._ensureAvoDir();
    const data = {
      version: "2026.1",
      rootId: this.rootId,
      currentHeadId: this.currentHeadId,
      nodes: Array.from(this.nodes.values()),
      updatedAt: new Date().toISOString(),
    };
    const tmpFile = path.join(this.avoDir, `lineage.tmp_${process.pid}_${Date.now()}`);
    try {
      fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), "utf8");
      fs.renameSync(tmpFile, this.dagFile);
    } catch (err) {
      console.error(`[LineageDag] Failed to persist lineage.json atomically:`, err.message);
      try {
        if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
      } catch {}
    }
  }

  /**
   * Adds a new mutation candidate node to the lineage DAG.
   *
   * @param {object} candidate
   * @param {string} [candidate.id]
   * @param {string} [candidate.parentId]
   * @param {string} candidate.hypothesis
   * @param {Array<string>} [candidate.filesModified]
   * @param {object} [candidate.metrics]
   * @returns {object} The created candidate node
   */
  addCandidate({ id, parentId, hypothesis, filesModified = [], metrics = {} }) {
    const candidateId = id || `cand_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const effectiveParent = parentId || this.currentHeadId || this.rootId;

    const node = {
      id: candidateId,
      parentId: effectiveParent,
      hypothesis,
      filesModified,
      metrics: {
        fitness: null,
        status: "pending",
        ...metrics,
      },
      timestamp: new Date().toISOString(),
    };

    this.nodes.set(candidateId, node);
    this.persist();
    return node;
  }

  /**
   * Updates evaluation metrics and status for a candidate.
   *
   * @param {string} id
   * @param {object} metrics
   * @param {'accepted'|'rejected'|'pending'} [status]
   */
  updateMetrics(id, metrics, status) {
    const node = this.nodes.get(id);
    if (!node) {
      throw new Error(`Candidate node '${id}' not found in Lineage DAG`);
    }

    node.metrics = {
      ...node.metrics,
      ...metrics,
    };
    if (status) {
      node.metrics.status = status;
      if (status === "accepted") {
        this.currentHeadId = id;
      }
    }
    node.updatedAt = new Date().toISOString();
    this.persist();
    return node;
  }

  /**
   * Returns the candidate node with the highest fitness score.
   */
  getBestCandidate() {
    let best = null;
    for (const node of this.nodes.values()) {
      if (node.metrics?.status === "accepted" && typeof node.metrics.fitness === "number") {
        if (!best || node.metrics.fitness > best.metrics.fitness) {
          best = node;
        }
      }
    }
    return best || this.nodes.get(this.rootId);
  }

  /**
   * Returns complete lineage trace from root to a given node.
   * @param {string} [nodeId]
   */
  getAncestry(nodeId) {
    const targetId = nodeId || this.currentHeadId;
    const chain = [];
    let cur = this.nodes.get(targetId);

    while (cur) {
      chain.unshift(cur);
      cur = cur.parentId ? this.nodes.get(cur.parentId) : null;
    }
    return chain;
  }

  /**
   * Summarizes the lineage graph for LLM context injection.
   */
  toSummary() {
    const all = Array.from(this.nodes.values());
    const accepted = all.filter((n) => n.metrics?.status === "accepted");
    const rejected = all.filter((n) => n.metrics?.status === "rejected");
    const best = this.getBestCandidate();

    return {
      totalCandidates: all.length,
      acceptedCount: accepted.length,
      rejectedCount: rejected.length,
      currentHead: this.currentHeadId,
      bestFitness: best?.metrics?.fitness ?? 0,
      bestCandidateId: best?.id ?? "baseline",
    };
  }
}
