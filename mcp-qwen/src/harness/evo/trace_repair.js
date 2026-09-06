/**
 * Traceback & Failure Condenser (Structural Repair Engine)
 *
 * Slices noisy test output and stack traces into high-signal, bounded (<=100 token)
 * failure digests. Filters out third-party framework frames (site-packages, node_modules)
 * to locate the exact repository line and symbol where failure occurred.
 */

import path from "node:path";

const THIRD_PARTY_PATTERNS = [
  /\/node_modules\//i,
  /\\node_modules\\/i,
  /\/site-packages\//i,
  /\\site-packages\\/i,
  /\/dist-packages\//i,
  /\\dist-packages\\/i,
  /\/lib\/python\d+\.\d+\//i,
  /internal\/modules\//i,
  /<frozen /i,
  /_pytest\//i,
  /pluggy\//i,
];

export function isThirdPartyFrame(filePath) {
  if (!filePath) return false;
  return THIRD_PARTY_PATTERNS.some((pattern) => pattern.test(filePath));
}

/**
 * Parses raw test stderr/stdout and extracts a condensed, actionable failure digest.
 *
 * @param {object} params
 * @param {string} params.stdout
 * @param {string} params.stderr
 * @param {number} params.exitCode
 * @param {boolean} [params.timedOut]
 * @param {string} [params.workspaceRoot]
 * @returns {{
 *   failureType: string,
 *   targetFile: string|null,
 *   targetLine: number|null,
 *   targetSymbol: string|null,
 *   assertion: string|null,
 *   summary: string
 * }}
 */
export function condenseTraceback({
  stdout = "",
  stderr = "",
  exitCode = 0,
  timedOut = false,
  workspaceRoot = "",
}) {
  if (exitCode === 0 && !timedOut) {
    return {
      failureType: "none",
      targetFile: null,
      targetLine: null,
      targetSymbol: null,
      assertion: null,
      summary: "All checks and tests passed successfully.",
    };
  }

  // Case 1: Timeout / Hang
  if (timedOut || exitCode === 124 || stderr.includes("timed out after")) {
    return {
      failureType: "timed_out",
      targetFile: null,
      targetLine: null,
      targetSymbol: null,
      assertion: null,
      summary: "Execution timed out (process hung, infinite loop, or test exceeded deadline).",
    };
  }

  const combined = `${stderr}\n${stdout}`;
  const lines = combined.split("\n").map((l) => l.trimEnd());

  let targetFile = null;
  let targetLine = null;
  let targetSymbol = null;
  let assertion = null;
  let failureType = "test_failure";

  // Regex 1: Python Traceback frame: File "path/to/file.py", line 42, in func_name
  const pyFrameRegex = /File\s+["']([^"']+)["'],\s+line\s+(\d+)(?:,\s+in\s+([a-zA-Z0-9_<>\.]+))?/i;
  // Regex 2: Node.js / V8 frame: at funcName (path/to/file.js:42:10) or at path/to/file.js:42:10
  const jsFrameRegex = /at\s+(?:([a-zA-Z0-9_$<>.]+)\s+\(([^()]+):(\d+):\d+\)|([^()]+):(\d+):\d+)/i;
  // Regex 3: Python pytest inline error: >   assert ... / E   AssertionError: ...
  const pyAssertionRegex = /^(?:E\s+|>\s+)(AssertionError.*|TypeError.*|ValueError.*|KeyError.*|ZeroDivisionError.*|AttributeError.*|SyntaxError.*|NameError.*)$/i;
  // Regex 4: Jest / Mocha assertion: AssertionError: ... or Error: expect(received).toBe(expected)
  const jsAssertionRegex = /^(AssertionError:.*|Error: expect\(.*\).*|ReferenceError:.*|TypeError:.*|SyntaxError:.*)/i;

  const foundFrames = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Check Python frame
    const pyMatch = line.match(pyFrameRegex);
    if (pyMatch) {
      const fPath = pyMatch[1];
      const fLine = parseInt(pyMatch[2], 10);
      const fSym = pyMatch[3] || null;
      foundFrames.push({ path: fPath, line: fLine, symbol: fSym });
      continue;
    }

    // Check JS frame
    const jsMatch = line.match(jsFrameRegex);
    if (jsMatch) {
      const fSym = jsMatch[1] || null;
      const fPath = jsMatch[2] || jsMatch[4];
      const fLine = parseInt(jsMatch[3] || jsMatch[5], 10);
      foundFrames.push({ path: fPath, line: fLine, symbol: fSym });
      continue;
    }

    // Check Assertion line
    if (!assertion) {
      const aPyMatch = line.match(pyAssertionRegex);
      if (aPyMatch) {
        assertion = aPyMatch[1].trim();
        failureType = "assertion_failure";
      } else {
        const aJsMatch = line.match(jsAssertionRegex);
        if (aJsMatch) {
          assertion = aJsMatch[1].trim();
          failureType = "assertion_failure";
        }
      }
    }
  }

  // Filter frames: pick the first frame that belongs to the workspace and is NOT third-party
  for (const frame of foundFrames) {
    if (!isThirdPartyFrame(frame.path)) {
      targetFile = frame.path;
      targetLine = frame.line;
      targetSymbol = frame.symbol;
      break;
    }
  }

  // If all were third-party, take the last found frame as a fallback
  if (!targetFile && foundFrames.length > 0) {
    const last = foundFrames[foundFrames.length - 1];
    targetFile = last.path;
    targetLine = last.line;
    targetSymbol = last.symbol;
  }

  // Build clean concise summary
  let locStr = "";
  if (targetFile) {
    const base = path.basename(targetFile);
    locStr = ` at ${base}:${targetLine || "?"}${targetSymbol ? ` (${targetSymbol})` : ""}`;
  }

  const errDetail = assertion ? `: ${assertion}` : "";
  const summary = `[FailureDigest] ${failureType}${locStr}${errDetail}`.trim();

  return {
    failureType,
    targetFile,
    targetLine,
    targetSymbol,
    assertion,
    summary,
  };
}
