/**
 * RepetitionDetector — stateful degenerate-repetition guard for SSE streams.
 *
 * Extracted from stream_proxy.js so it can be unit-tested in isolation
 * (importing stream_proxy.js directly would start the HTTP listener, which
 * is unsafe inside a test process).
 *
 * Tiered single-character repetition limits:
 *   - code/diff-significant characters (git-diff '+' hunks, code, URLs, JSON,
 *     math) get a HIGH limit of 500 so legitimate long runs in model reports
 *     are never mistaken for a degenerate loop.
 *   - whitespace / standard markdown dividers keep 120.
 *   - everything else stays at the strict 35 (true degeneracy still trips).
 *
 * Block-level (multi-character) repetition detection and any total-stream
 * bound are intentionally left unchanged.
 */

// Characters that legitimately appear in long consecutive runs inside
// legitimate model output (git-diff '+' hunks, code, URLs, JSON, math).
export const CODE_REPEAT_CHARS = new Set(
  "+./\\<>|:;()[]{}'\"!?,~^&%$@".split("")
);

// Whitespace / standard markdown divider characters (limit 120).
const DIVIDER_CHARS = new Set(["-", "=", "*", "#", " ", "\t", "\n", "_"]);

// Union of code-significant and divider/whitespace characters. A repeating
// unit made up ENTIRELY of these is a "pure" run (e.g. a git-diff '+' hunk,
// a '====' divider, a '////' comment) and is governed by the single-character
// tiered limits above — the block-level detector must NOT also trip on it.
// Genuine multi-character phrase loops (e.g. "the the the") contain letters
// outside this set and are still caught by the block detector.
const PURE_RUN_CHARS = new Set([...CODE_REPEAT_CHARS, ...DIVIDER_CHARS]);

const CODE_LIMIT = 500;
const DIVIDER_LIMIT = 120;
const DEFAULT_LIMIT = 35;

export class RepetitionDetector {
  constructor() {
    this.lastChar = "";
    this.charRepeatCount = 0;
    this.rolling = "";
  }

  // Returns { type, pattern, count } if degenerate repetition is detected, else null
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
    this.rolling = (this.rolling + text).slice(-600);
    const len = this.rolling.length;
    for (let unitLen = 2; unitLen <= 24; unitLen++) {
      const neededLen = unitLen * 18;
      if (len < neededLen) continue;
      const unit = this.rolling.slice(-unitLen);
      // Skip "pure" runs: units made entirely of code-significant or
      // divider/whitespace characters (e.g. "++", "====", "////"). These are
      // governed by the single-character tiered limits above, so the
      // block-level detector must not also trip on them. Genuine multi-char
      // phrase loops (letters outside this set) are still caught.
      let isPureRun = true;
      for (let k = 0; k < unit.length; k++) {
        if (!PURE_RUN_CHARS.has(unit[k])) {
          isPureRun = false;
          break;
        }
      }
      if (isPureRun) continue;
      let isRep = true;
      for (let r = 1; r < 18; r++) {
        const seg = this.rolling.slice(len - (r + 1) * unitLen, len - r * unitLen);
        if (seg !== unit) {
          isRep = false;
          break;
        }
      }
      if (isRep) {
        return { type: "pattern", pattern: unit, count: 18 };
      }
    }

    return null;
  }
}
