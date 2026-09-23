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

// M3b: the exact marker text the stream proxy appends to a stream it has
// circuit-broken for runaway repetition (stream_proxy.js breakerChunk). This
// is the SINGLE SOURCE OF TRUTH for that string: the proxy emits it, and the
// Anser runner (src/harness/runner.js) detects it in the accumulated final
// text to classify guard-truncated degenerate finals honestly (retry, then
// "degenerate_response_truncated") instead of a false "completed".
//
// The marker is a template: the breaker interpolates the detected repetition
// type and pattern (e.g. "character" / "\"a\"" or "pattern" / "the the ").
// The runner matches on the stable prefix (GUARD_MARKER_PREFIX) so it is
// robust to the interpolated detail, and strips the full marker (prefix +
// detail + closing bracket) when measuring the substantive remainder.
export const GUARD_MARKER_PREFIX =
  "[StreamProxy Guard: Runaway repetition loop (";
export const GUARD_MARKER_TEMPLATE =
  "\n\n[StreamProxy Guard: Runaway repetition loop (${type}: ${pattern}) detected and safely truncated]\n\n";

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

const CODE_LIMIT = 1000;
const DIVIDER_LIMIT = 250;
const DEFAULT_LIMIT = 100;
const PATTERN_REPEAT_COUNT = 40;

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
