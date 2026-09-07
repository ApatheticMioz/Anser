/**
 * Goose-runner status -> isError mapping verification (offline, pure).
 *
 * The mapping is the single source of truth `isSuccessStatus(status)` in
 * src/goose_runner.js. It must:
 *   - treat "completed" and "completed_ceiling" as SUCCESS (isError = false),
 *   - treat every other known status as FAILURE (isError = true),
 *   - FAIL CLOSED on unknown / null / undefined statuses.
 *
 * This closes the coverage hole confirmed by the M0b audit: no suite previously
 * asserted the task-completion mapping, so the F4-class false-failure (a
 * complete deliverable flipped to isError:true) and any future mapping
 * regression would go undetected.
 */
import assert from "node:assert/strict";
import { isSuccessStatus } from "../src/goose_runner.js";

const SUCCESS_STATUSES = ["completed", "completed_ceiling"];
const FAILURE_STATUSES = [
  "failed",
  "engine_empty_response",
  "reasoning_budget_exhausted",
  "length_limit_reached",
  "turn_limit_reached",
  "aborted",
];
const FAIL_CLOSED_INPUTS = [undefined, null, "", "COMPLETED", "Completed", "ok", "success"];

let passed = 0;
let failed = 0;

function check(label, fn) {
  try {
    fn();
    passed++;
    console.log(`  [PASS] ${label}`);
  } catch (err) {
    failed++;
    console.error(`  [FAIL] ${label}: ${err.message}`);
  }
}

console.log("=== Goose Runner status->isError Mapping Verification (offline) ===\n");

for (const status of SUCCESS_STATUSES) {
  check(`success status "${status}" -> isSuccessStatus true`, () => {
    assert.equal(isSuccessStatus(status), true, `"${status}" must map to success`);
  });
}

for (const status of FAILURE_STATUSES) {
  check(`failure status "${status}" -> isSuccessStatus false`, () => {
    assert.equal(isSuccessStatus(status), false, `"${status}" must map to failure`);
  });
}

for (const input of FAIL_CLOSED_INPUTS) {
  check(
    `fail-closed input ${JSON.stringify(input)} -> isSuccessStatus false`,
    () => {
      assert.equal(
        isSuccessStatus(input),
        false,
        `${JSON.stringify(input)} must fail closed (treated as failure)`
      );
    }
  );
}

console.log(
  `\nGoose Runner Mapping Verification: ${passed} / ${passed + failed} checks passed`
);
if (failed > 0) {
  console.log("Verdict: MAPPING CHECK(S) FAILED.");
  process.exit(1);
}
console.log("Verdict: ALL MAPPING CHECKS PASSED.");
process.exit(0);
