/**
 * Lineage DAG Service (Evo Candidate Graph)
 *
 * Tracks the tree of evolutionary variations, mutation hypotheses,
 * test outcomes, and fitness scores in `.evo/lineage.json`.
 *
 * FX4 (D4): LineageDag is a per-workspace SINGLETON. Two subsystems
 * (EvoLineageEngine and EvoOperator) previously each constructed their own
 * instance against the same `.evo/lineage.json`, each holding a private
 * in-memory copy; the second writer's blind persist() clobbered the first
 * writer's nodes (last-writer-wins data loss). `forWorkspace(root)` now
 * returns one shared instance per canonical workspace root, and persist()
 * is a read-modify-write merge (re-read on-disk, union by node id, atomic
 * tmp+rename) so concurrent writers' nodes all survive.
 *
 * FX4 (D15): the file's `version` field is now GATED on load. A file carrying
 * an unknown or future version throws LineageVersionError (naming both
 * versions) instead of being silently parsed.
 *
 * FX4 (D1): the legacy `candidates` migration maps statuses honestly —
 * neutral/unknown map to "neutral", never a fabricated "rejected".
 */

import fs from "node:fs";
import path from "node:path";
import { canonicalizePath } from "../../wsl_bridge.js";

// D15: the lineage file format version this build writes and understands.
export const LINEAGE_VERSION = "2026.1";
// Every version this build can safely parse. A file carrying any OTHER
// version (unknown or future) is refused on load — we never attempt to parse
// a format we do not understand (fail-fast, no silent migration).
export const KNOWN_LINEAGE_VERSIONS = new Set([LINEAGE_VERSION]);

/**
 * Thrown when a lineage.json carries a version this build does not know.
 * The message names BOTH the file's version and the current version so the
 * mismatch is unambiguous.
 */
export class LineageVersionError extends Error {
  constructor(fileVersion, currentVersion, file) {
    super(
      `LineageVersionError: ${file} declares version '${fileVersion}' but this build ` +
        `only knows ${JSON.stringify([...KNOWN_LINEAGE_VERSIONS])} (current '${currentVersion}'). ` +
        `Refusing to parse an unknown/future lineage format.`
    );
    this.name = "LineageVersionError";
    this.fileVersion = fileVersion;
    this.currentVersion = currentVersion;
  }
}

/**
 * D1: honest mapping of a (possibly legacy) status string to the canonical
 * lowercase status. Never fabricates a failure: neutral/unknown map to
 * "neutral", not "rejected".
 */
function mapLegacyStatus(status) {
  const s = typeof status === "string" ? status.trim().toLowerCase() : "";
  if (s === "accepted") return "accepted";
  if (s === "rejected") return "rejected";
  if (s === "pending") return "pending";
  if (s === "neutral") return "neutral";
  // Unknown / missing / legacy "NEUTRAL" / anything else: honest neutral.
  return "neutral";
}

/**
 * The "last-modified" time of a node, used for per-node last-writer-wins in
 * the read-modify-write merge. ISO-8601 timestamps sort lexicographically, so
 * a plain string comparison is a correct recency comparison.
 */
function nodeTime(n) {
  return (n && (n.updatedAt || n.timestamp)) || "";
}

// FX4 (D4): one LineageDag instance per canonical workspace root, per process.
const _instances = new Map();

export class LineageDag {
  /**
   * Returns the shared LineageDag for a workspace root, creating it on first
   * use. The key is the canonical (realpath-resolved) root so that a
   * junction/symlink form and its real form collapse to the same instance.
   *
   * @param {string} root workspace root (any form; canonicalized internally)
   * @returns {LineageDag}
   */
  static forWorkspace(root) {
    const key = canonicalizePath(root || process.cwd());
    let inst = _instances.get(key);
    if (!inst) {
      inst = new LineageDag({ workspaceRoot: key });
      _instances.set(key, inst);
    }
    return inst;
  }

  constructor(options = {}) {
    // P4i: canonicalize the workspace root through the OS symlink/junction
    // layer so the .evo/ directory (lineage.json, snapshots) is anchored to
    // the real path even when the process was launched through a junction.
    this.workspaceRoot = canonicalizePath(options.workspaceRoot || process.cwd());
    this.evoDir = path.join(this.workspaceRoot, ".evo");
    this.dagFile = path.join(this.evoDir, "lineage.json");
    this.nodes = new Map();
    this.rootId = null;
    this.currentHeadId = null;

    this._load();
  }

  _ensureEvoDir() {
    try {
      fs.mkdirSync(this.evoDir, { recursive: true });
    } catch {}
  }

  /**
   * Reads and parses the on-disk lineage file, applying the D15 version gate.
   *
   * @returns {object|null} parsed data, or null when the file is absent or a
   *   transient lock (EBUSY/EPERM) makes it unreadable this tick.
   * @throws {LineageVersionError} when the file's version is unknown/future.
   * @throws {SyntaxError} (via JSON.parse) when the file is corrupt — the
   *   caller quarantines it.
   */
  _readDisk() {
    if (!fs.existsSync(this.dagFile)) return null;
    let raw;
    try {
      raw = fs.readFileSync(this.dagFile, "utf8");
    } catch (err) {
      // Transient Windows file lock (EBUSY/EPERM) while another writer holds
      // the file: a real signal, not corruption. Return null so the caller
      // proceeds from its in-memory copy (the next persist() retries the read).
      if (err && (err.code === "EBUSY" || err.code === "EPERM")) return null;
      throw err;
    }
    const data = JSON.parse(raw); // throws on corrupt JSON (caller quarantines)
    // D15: version gate — refuse unknown/future formats before parsing nodes.
    // A file with no version field is treated as the oldest known version.
    const fileVersion = data && typeof data.version === "string" ? data.version : null;
    if (fileVersion !== null && !KNOWN_LINEAGE_VERSIONS.has(fileVersion)) {
      throw new LineageVersionError(fileVersion, LINEAGE_VERSION, this.dagFile);
    }
    return data;
  }

  _load() {
    this._ensureEvoDir();
    let data = null;
    try {
      data = this._readDisk();
    } catch (err) {
      if (err instanceof LineageVersionError) throw err; // D15: fail-fast, never quarantine a version mismatch
      // Corrupt file: quarantine rather than silently overwriting it.
      const corruptBackup = path.join(this.evoDir, `lineage.json.corrupt-${Date.now()}`);
      console.error(`[LineageDag] Corrupt lineage.json detected. Quarantining to ${corruptBackup}:`, err.message);
      try {
        fs.copyFileSync(this.dagFile, corruptBackup);
      } catch {}
    }

    if (data) {
      this._applyDisk(data);
      return;
    }

    // No readable file: initialize the root baseline node.
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

  /**
   * Merges on-disk state into the in-memory graph (union by node id,
   * per-node last-writer-wins by updatedAt/timestamp). Shared by _load()
   * (initial/reload) and persist() (read-modify-write) so a reload or a
   * concurrent writer's nodes are never lost.
   */
  _applyDisk(data) {
    if (Array.isArray(data.nodes)) {
      for (const n of data.nodes) {
        const existing = this.nodes.get(n.id);
        if (!existing || nodeTime(n) > nodeTime(existing)) {
          this.nodes.set(n.id, n);
        }
      }
    } else if (Array.isArray(data.candidates)) {
      // Backward compatibility migration: import legacy flat candidates.
      // D1: map legacy statuses honestly — never fabricate a failure.
      for (const c of data.candidates) {
        const id = c.candidateId;
        const mapped = {
          id,
          parentId: c.parentCommit || "baseline",
          hypothesis: c.hypothesis || "",
          filesModified: c.filesModified || [],
          metrics: {
            fitness: c.metricScore,
            status: mapLegacyStatus(c.status),
            commitSha: c.commitSha,
            errorLog: c.errorLog,
          },
          timestamp: c.timestamp || new Date().toISOString(),
        };
        const existing = this.nodes.get(id);
        if (!existing || nodeTime(mapped) > nodeTime(existing)) {
          this.nodes.set(id, mapped);
        }
        // Legacy files carry no currentHeadId field; preserve the historical
        // migration semantics — the accepted candidate becomes head. Gated on
        // the honest mapped status, never on a fabricated one.
        if (mapped.metrics.status === "accepted") {
          this.currentHeadId = id;
        }
      }
    }

    // Head: adopt the on-disk head if it is newer than our (merged) head node,
    // or if we have no head yet. Prevents a stale in-memory head from
    // regressing a newer on-disk head (cross-process).
    if (data.currentHeadId) {
      const memHead = this.nodes.get(this.currentHeadId);
      const diskHead = this.nodes.get(data.currentHeadId);
      if (!memHead || (diskHead && nodeTime(diskHead) > nodeTime(memHead))) {
        this.currentHeadId = data.currentHeadId;
      }
    }
    if (!this.rootId && data.rootId) this.rootId = data.rootId;
  }

  /**
   * FX4 (D4): read-modify-write. Re-read the on-disk file and MERGE its nodes
   * into the in-memory graph (union by node id; per-node last-writer-wins by
   * updatedAt) BEFORE writing, so a concurrent writer's nodes survive instead
   * of being clobbered. The write itself is atomic (tmp + rename), the same
   * idiom task_registry.saveTaskToDisk uses.
   */
  persist() {
    this._ensureEvoDir();

    let disk = null;
    try {
      disk = this._readDisk();
    } catch (err) {
      if (err instanceof LineageVersionError) throw err; // D15: fail-fast
      // Transient lock / corrupt: proceed from memory (do not lose our nodes).
    }
    if (disk) this._applyDisk(disk);

    const data = {
      version: LINEAGE_VERSION,
      rootId: this.rootId,
      currentHeadId: this.currentHeadId,
      nodes: Array.from(this.nodes.values()),
      updatedAt: new Date().toISOString(),
    };
    const tmpFile = path.join(this.evoDir, `lineage.tmp_${process.pid}_${Date.now()}`);
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
   * @param {'accepted'|'rejected'|'pending'|'neutral'} [status]
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
