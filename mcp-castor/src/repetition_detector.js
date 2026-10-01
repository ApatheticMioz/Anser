/**
 * Stateful degenerate-repetition guard for SSE streams.
 *
 * Detects two classes of runaway repetition:
 *   - Single-character runs, governed by tiered limits:
 *     CODE_LIMIT (1000) for code/diff-significant characters, DIVIDER_LIMIT
 *     (250) for whitespace/markdown dividers, and DEFAULT_LIMIT (100) for
 *     everything else.
 *   - Multi-character pattern loops (a unit of 4-32 characters repeated
 *     PATTERN_REPEAT_COUNT times), excluding "pure" runs made entirely of
 *     code-significant or divider characters (those are covered by the
 *     single-character tiered limits).
 */

/**
 * Stable prefix of the stream-proxy guard marker. The stream proxy appends
 * this marker (with the detected repetition type and pattern interpolated)
 * to a stream it has circuit-broken for runaway repetition; the Castor runner
 * (src/harness/runner.js) matches on this prefix to detect guard-truncated
 * degenerate finals and strips the full marker when measuring the
 * substantive remainder.
 * @type {string}
 */
export const GUARD_MARKER_PREFIX =
  "[StreamProxy Guard: Runaway repetition loop (";

/**
 * Template for the full stream-proxy guard marker. The `${type}` and
 * `${pattern}` placeholders are interpolated by the breaker with the detected
 * repetition type (e.g. "character" / "pattern") and the repeated unit.
 * @type {string}
 */
export const GUARD_MARKER_TEMPLATE =
  "\n\n[StreamProxy Guard: Runaway repetition loop (${type}: ${pattern}) detected and safely truncated]\n\n";

// Characters that appear in long consecutive runs in model output (git-diff
// '+' hunks, code, URLs, JSON, math).
const CODE_REPEAT_CHARS = new Set(
  "+./\\<>|:;()[]{}'\"!?,~^&%$@".split("")
);

// Whitespace / standard markdown divider characters (governed by
// DIVIDER_LIMIT).
const DIVIDER_CHARS = new Set(["-", "=", "*", "#", " ", "\t", "\n", "_"]);

// Union of code-significant and divider/whitespace characters. A repeating
// unit made entirely of these is a "pure" run (e.g. a git-diff '+' hunk, a
// '====' divider, a '////' comment) and is governed by the single-character
// tiered limits; the block-level detector skips it. Multi-character phrase
// loops (e.g. "the the the") contain letters outside this set and are caught
// by the block detector.
const PURE_RUN_CHARS = new Set([...CODE_REPEAT_CHARS, ...DIVIDER_CHARS]);

const CODE_LIMIT = 1000;
const DIVIDER_LIMIT = 250;
const DEFAULT_LIMIT = 100;
const PATTERN_REPEAT_COUNT = 40;

/**
 * Stateful detector for runaway repetition in a streamed text stream. Feed
 * chunks via {@link RepetitionDetector#feed}; it tracks the trailing
 * single-character run and a rolling window of recent text for
 * multi-character pattern loops.
 */
export class RepetitionDetector {
  constructor() {
    this.lastChar = "";
    this.charRepeatCount = 0;
    this.rolling = "";
  }

  /**
   * Feeds a chunk of streamed text into the detector.
   * @param {string} text - The next chunk of streamed text.
   * @returns {{type: string, pattern: string, count: number}|null} A
   *   detection object (`type` is "character" or "pattern", `pattern` is the
   *   repeated unit, `count` is the run length) when degenerate repetition is
   *   detected, or null otherwise.
   */
  feed(text) {
    if (!text || typeof text !== "string") return null;

    // 1. Single character consecutive repetition (e.g. "!!!!!!!!!!!!!!!!...")
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === this.lastChar) {
        this.charRepeatCount++;
        let limit;
        if (CODE_REPEAT_CHARS.has(ch)) {
          limit = CODE_LIMIT;
        } else if (DIVIDER_CHARS.has(ch)) {
          limit = DIVIDER_LIMIT;
        } else {
          limit = DEFAULT_LIMIT;
        }
        if (this.charRepeatCount >= limit) {
          return { type: "character", pattern: ch, count: this.charRepeatCount };
        }
      } else {
        this.lastChar = ch;
        this.charRepeatCount = 1;
      }
    }

    // 2. Multi-character pattern repetition (e.g. repeating phrases or tokens)
    this.rolling = (this.rolling + text).slice(-1500);
    const len = this.rolling.length;
    for (let unitLen = 4; unitLen <= 32; unitLen++) {
      const neededLen = unitLen * PATTERN_REPEAT_COUNT;
      if (len < neededLen) continue;
      const unit = this.rolling.slice(-unitLen);
      // Skip "pure" runs: units made entirely of code-significant or
      // divider/whitespace characters (e.g. "++", "====", "////", "|---|"). These are
      // governed by the single-character tiered limits above, so the
      // block-level detector must not also trip on them.
      let isPureRun = true;
      for (let k = 0; k < unit.length; k++) {
        if (!PURE_RUN_CHARS.has(unit[k])) {
          isPureRun = false;
          break;
        }
      }
      if (isPureRun) continue;
      let isRep = true;
      for (let r = 1; r < PATTERN_REPEAT_COUNT; r++) {
        const seg = this.rolling.slice(len - (r + 1) * unitLen, len - r * unitLen);
        if (seg !== unit) {
          isRep = false;
          break;
        }
      }
      if (isRep) {
        return { type: "pattern", pattern: unit, count: PATTERN_REPEAT_COUNT };
      }
    }

    return null;
  }
}
