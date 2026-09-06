---
name: traceback-condensing
description: Condense a failing test run into a minimal failure digest before retrying.
keywords: [traceback, stack trace, error digest, trace_repair, assertion failure, pytest, failed test]
---
# Traceback Condensing

When a test run or build fails, do NOT paste the raw multi-hundred-line
traceback into your reasoning. Condense it into a compact failure digest
first, then act on the digest.

## Checklist
1. Identify the FIRST user-code frame (skip site-packages, stdlib, and
   framework internals). That is where the real bug lives.
2. Extract the exact file, line, and symbol from that frame.
3. Capture the assertion message or exception type + message verbatim.
4. Reduce the digest to at most ~100 tokens:
   `[FailureDigest] <type> at <file>:<line> in <symbol>: <message>`
5. Use the digest (not the raw traceback) to form your next hypothesis.

## Rules
- Never re-emit the full traceback into a tool call or the final answer.
- If the digest points at a test file (not source), the bug is likely in the
  code under test — go read that source file next.
- If the digest is a network/timeout error, that is an environment issue, not
  a code bug — say so and do not "fix" unrelated code.
