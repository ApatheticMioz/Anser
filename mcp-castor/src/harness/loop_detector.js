/**
 * Action-Hash Loop Detector (Fingerprint-based Stagnation Tripwire).
 *
 * Implements sliding-window action-state fingerprinting to detect recurring,
 * non-mutating tool-call cycles ("doom loops") early (e.g. turn 10-15) rather
 * than waiting for an arbitrary global turn ceiling.
 *
 * Distinguishes:
 * - Legitimate empirical exploration: changing probe scripts, testing different
 *   parameters, varying tools -> hashes differ -> NOT a loop.
 * - True doom loop: executing the exact same tool with identical arguments and
 *   identical status multiple times without any intervening state mutations.
 */

import crypto from "node:crypto";
import {
  DEFAULT_LOOP_DETECTION_WINDOW,
  DEFAULT_LOOP_DETECTION_REPETITIONS,
} from "../config.js";

export class LoopDetector {
  /**
   * @param {object} [options]
   * @param {number} [options.windowSize] Sliding window size in turns (default: 6)
   * @param {number} [options.threshold] Repetition count to trigger loop (default: 3)
   * @param {number} [options.repetitionThreshold] Alias for threshold
   */
  constructor(options = {}) {
    this.windowSize = options.windowSize || DEFAULT_LOOP_DETECTION_WINDOW || 6;
    this.threshold =
      options.threshold ||
      options.repetitionThreshold ||
      DEFAULT_LOOP_DETECTION_REPETITIONS ||
      3;
    this.repetitionThreshold = this.threshold;
    this.history = [];
    this.mutationsSinceLastAction = 0;
  }

  /**
   * Record that a file or workspace state mutation occurred (e.g. edit_file, write_file, apply_patch).
   */
  recordMutation() {
    this.mutationsSinceLastAction++;
  }

  /**
   * Compute a deterministic hash for a tool call.
   * Normalizes argument object keys so formatting differences don't mask identical actions.
   *
   * @param {string} toolName
   * @param {object|string} args
   * @param {object} [result]
   * @returns {string} 16-character hex signature
   */
  computeActionHash(toolName, args, result) {
    let canonicalArgs = "";
    try {
      if (args && typeof args === "object") {
        canonicalArgs = JSON.stringify(args, Object.keys(args).sort());
      } else {
        canonicalArgs = String(args ?? "");
      }
    } catch {
      canonicalArgs = String(args ?? "");
    }
    const exitSig = result ? (result.exitCode ?? (result.isError ? 1 : 0)) : 0;
    return crypto
      .createHash("sha256")
      .update(`${toolName}:${canonicalArgs}:${exitSig}`)
      .digest("hex")
      .slice(0, 16);
  }

  /**
   * Record an executed action and evaluate loop status over the sliding window.
   *
   * @param {string} toolName
   * @param {object|string} args
   * @param {object} [result]
   * @returns {{ isLoop: boolean, repeats: number, repetitionCount: number, fingerprint: string, signature: string, toolName: string }}
   */
  recordAction(toolName, args, result) {
    const hash = this.computeActionHash(toolName, args, result);
    const hadMutation = this.mutationsSinceLastAction > 0;
    this.history.push({
      toolName,
      hash,
      hadMutation,
      timestamp: Date.now(),
    });
    this.mutationsSinceLastAction = 0;

    while (this.history.length > this.windowSize) {
      this.history.shift();
    }

    return this.checkLoop();
  }

  /**
   * Check if the latest action is repeating within the sliding window without intervening mutations.
   *
   * @returns {{ isLoop: boolean, repeats: number, repetitionCount: number, fingerprint: string, signature: string, toolName: string }}
   */
  checkLoop() {
    if (this.history.length === 0) {
      return { isLoop: false, repeats: 0, repetitionCount: 0, fingerprint: "", signature: "", toolName: "" };
    }
    const latest = this.history[this.history.length - 1];
    let matchCount = 0;
    let mutationsInBetween = false;

    for (let i = this.history.length - 1; i >= 0; i--) {
      const item = this.history[i];
      if (item.hash === latest.hash) {
        matchCount++;
      }
      if (item.hadMutation) {
        // Mutation occurred before/at this action; do not count actions before it
        break;
      }
    }

    const isLoop = matchCount >= this.threshold;
    return {
      isLoop,
      repeats: matchCount,
      repetitionCount: matchCount,
      fingerprint: latest.hash,
      signature: latest.hash,
      toolName: latest.toolName,
    };
  }
}
