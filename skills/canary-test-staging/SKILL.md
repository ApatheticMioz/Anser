---
name: canary-test-staging
description: Stage changes behind a targeted test file and run the narrow suite before the full chain.
keywords: [canary, smoke test, staging suite, test gate, narrow test, targeted test]
---
# Canary Test Staging

Before you trust a change, prove it on the smallest possible surface, then
widen. Do not run the full test chain as your first signal.

## Checklist
1. Write or identify ONE targeted test case or file that exercises exactly the code
   you changed (a canary).
2. Run just that narrow test first (e.g. `cargo test <test_name>`, `pytest path/to/test.py::test_case`, `npm test -- <test_file>`, `go test -run <pattern>`).
3. If it passes, run the next-narrower group (the module's related tests).
4. Only after those are green, run the full test suite (e.g. `cargo test`, `pytest`, `npm test`, `go test ./...`).
5. If a canary fails, fix the code — do not weaken the canary to make it pass.

## Rules
- A canary must be fast (seconds) and deterministic (no network, no flaky
  timing).
- Never delete or skip a failing canary to "unblock" the build; that hides
  the regression.
- If you add a new capability, add its canary in the same change.
