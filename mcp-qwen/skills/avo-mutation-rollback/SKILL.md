---
name: avo-mutation-rollback
description: Safe propose, evaluate, select, revert sequence for AVO mutations with no irreversible steps.
keywords: [rollback, revert, mutation, regression, snapshot, candidate]
---
# AVO Mutation Rollback

A mutation is only safe if it can always be undone. Never let a budget,
timeout, or failure land on a step you cannot roll back.

## Sequence
1. `avo_propose_candidate` — snapshot the target files FIRST. This is the
   rollback anchor; nothing is mutated until this succeeds.
2. Apply the mutation to the working files.
3. `avo_evaluate_candidate` — run the verification command and read the
   fitness score plus the compact failure digest.
4. Decision:
   - Fitness improved and tests pass -> `avo_select_candidate` (commit to
     the lineage DAG).
   - Fitness regressed, tests failed, or the digest shows a real bug ->
     `avo_revert_candidate` (restore the snapshot exactly).
5. Confirm the revert restored the original file contents before continuing.

## Rules
- The snapshot (step 1) must always precede any file mutation.
- If a step is interrupted by a timeout or budget, the next action is to
  revert to the last good snapshot, not to resume mid-mutation.
- Never edit a file that is not in the candidate's snapshot list; those
  changes are not covered by the rollback.
