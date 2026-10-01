/**
 * Evolutionary Watchdog & Stagnation Circuit Breaker (Evo)
 *
 * Protects agent runs against:
 * - Mutation stagnation (consecutive rejected candidates)
 * - Token generation velocity decay (speculative decoding / KV pressure)
 * - Infinite loops without fitness improvement
 */

export class EvoWatchdog {
  constructor(options = {}) {
    this.maxConsecutiveRejections = options.maxConsecutiveRejections || 4;
    this.consecutiveRejections = 0;
    this.stagnationTripped = false;
    this.tokenVelocityHistory = [];
  }

  /**
   * Records candidate evaluation outcome.
   * @param {'accepted'|'rejected'} status
   * @returns {{ tripped: boolean, message?: string }}
   */
  recordCandidateOutcome(status) {
    if (status === "accepted") {
      this.consecutiveRejections = 0;
      this.stagnationTripped = false;
      return { tripped: false };
    }

    this.consecutiveRejections++;
    if (this.consecutiveRejections >= this.maxConsecutiveRejections) {
      this.stagnationTripped = true;
      return {
        tripped: true,
        consecutiveRejections: this.consecutiveRejections,
        message: `[Evo Watchdog Circuit Breaker] Stagnation detected: ${this.consecutiveRejections} consecutive candidate mutations were rejected. Recommend varying mutation strategy, reverting to baseline, or inspecting error stack trace directly.`,
      };
    }

    return { tripped: false, consecutiveRejections: this.consecutiveRejections };
  }

  /**
   * Records token generation velocity.
   * @param {number} tokensPerSec
   */
  recordVelocity(tokensPerSec) {
    if (typeof tokensPerSec === "number" && tokensPerSec > 0) {
      this.tokenVelocityHistory.push(tokensPerSec);
      if (this.tokenVelocityHistory.length > 10) {
        this.tokenVelocityHistory.shift();
      }
    }
  }

  /**
   * Checks whether token generation velocity has degraded significantly.
   */
  isVelocityDegraded() {
    if (this.tokenVelocityHistory.length < 3) return false;
    const first = this.tokenVelocityHistory[0];
    const latest = this.tokenVelocityHistory[this.tokenVelocityHistory.length - 1];
    // More than 50% decay indicates KV cache context exhaustion
    return latest < first * 0.5;
  }

  reset() {
    this.consecutiveRejections = 0;
    this.stagnationTripped = false;
    this.tokenVelocityHistory = [];
  }
}
