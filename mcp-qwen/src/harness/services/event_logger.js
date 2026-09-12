/**
 * Append-Only JSONL Session Event Logger (Anser Harness)
 *
 * Provides:
 * - Transparent, zero-binary event ledger (replaces opaque SQLite sessions.db)
 * - Atomic append-only writes for turns, tokens, tool invocations, and metrics
 * - Session branching (forking state at turn N for parallel evolutionary candidates)
 * - Anser plugin integration
 */

import fs from "node:fs";
import path from "node:path";
import { QWEN_STATE_DIR } from "../../config.js";

export class EventLoggerService {
  constructor(options = {}) {
    this.sessionId = options.sessionId || `session_${Date.now()}`;
    this.baseDir = options.baseDir || path.join(QWEN_STATE_DIR, "sessions");
    this.sessionDir = path.join(this.baseDir, this.sessionId);
    this.logFile = path.join(this.sessionDir, "events.jsonl");
    this.metaFile = path.join(this.sessionDir, "metadata.json");

    this._ensureDirectories();
  }

  _ensureDirectories() {
    try {
      fs.mkdirSync(this.sessionDir, { recursive: true });
    } catch {}
  }

  /**
   * Appends an event to the session's JSONL stream.
   * @param {object} event
   */
  append(event) {
    const entry = {
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
      ...event,
    };
    const line = JSON.stringify(entry) + "\n";
    try {
      fs.appendFileSync(this.logFile, line, "utf8");
    } catch (err) {
      console.error(`[EventLogger] Failed to write event:`, err.message);
    }
    return entry;
  }

  /**
   * Returns true when the session's event stream already carries a terminal
   * event (a `session_end` or `session_error`). Used by the orphan-marking
   * path to guard against a DOUBLE terminal: a session that already ended
   * (cleanly or by error) must not receive a second terminal event when its
   * task is later reaped as orphaned.
   *
   * The scan is a single read of the existing file (no write) and tolerates
   * malformed lines (they are skipped, matching readAll), so a partially
   * written / corrupt trailing line can never throw into the caller.
   *
   * @returns {boolean}
   */
  hasTerminalEvent() {
    if (!fs.existsSync(this.logFile)) return false;
    let content;
    try {
      content = fs.readFileSync(this.logFile, "utf8");
    } catch {
      return false;
    }
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue; // malformed line: skip, never throw
      }
      if (ev && (ev.type === "session_end" || ev.type === "session_error")) {
        return true;
      }
    }
    return false;
  }

  /**
   * Reads all recorded events for the session.
   * @returns {Array<object>}
   */
  readAll() {
    if (!fs.existsSync(this.logFile)) return [];
    try {
      const content = fs.readFileSync(this.logFile, "utf8");
      return content
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * Reconstructs the LLM conversation messages from the event stream.
   * @returns {Array<object>}
   */
  getConversationHistory() {
    const events = this.readAll();
    const messages = [];

    for (const ev of events) {
      if (ev.type === "user_message") {
        messages.push({ role: "user", content: ev.content });
      } else if (ev.type === "assistant_message") {
        const msg = { role: "assistant", content: ev.content || "" };
        if (ev.toolCalls && ev.toolCalls.length > 0) {
          msg.tool_calls = ev.toolCalls;
        }
        messages.push(msg);
      } else if (ev.type === "tool_result") {
        messages.push({
          role: "tool",
          tool_call_id: ev.toolCallId,
          content: typeof ev.result === "string" ? ev.result : JSON.stringify(ev.result ?? ev.error ?? ""),
        });
      }
    }
    return messages;
  }

  /**
   * Forks/branches this session at a specific event index or turn count.
   * Creates an independent session directory with historical events intact.
   *
   * @param {string} newSessionId
   * @param {number} [cutoffIndex]
   * @returns {EventLoggerService}
   */
  branch(newSessionId, cutoffIndex = null) {
    const allEvents = this.readAll();
    const sliced = cutoffIndex !== null ? allEvents.slice(0, cutoffIndex) : [...allEvents];

    const childLogger = new EventLoggerService({
      sessionId: newSessionId,
      baseDir: this.baseDir,
    });

    for (const ev of sliced) {
      childLogger.append({ ...ev, parentSessionId: this.sessionId, branchedAt: new Date().toISOString() });
    }

    return childLogger;
  }

  /**
   * Saves or updates metadata for this session.
   * @param {object} meta
   */
  saveMetadata(meta = {}) {
    const data = {
      sessionId: this.sessionId,
      updatedAt: new Date().toISOString(),
      ...meta,
    };
    try {
      fs.writeFileSync(this.metaFile, JSON.stringify(data, null, 2), "utf8");
    } catch {}
  }
}

/**
 * Anser Plugin to mount EventLoggerService into Context.
 */
export function eventLoggerPlugin(ctx, options = {}) {
  const logger = new EventLoggerService(options);
  ctx.provide("logger", logger);

  return () => {
    logger.saveMetadata({ status: "closed" });
  };
}
