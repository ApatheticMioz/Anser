---
name: hypothesis-generation
description: Evo discipline — state a measurable hypothesis, snapshot, evaluate, then select or revert.
keywords: [hypothesis, evo, fitness, benchmark, optimization, candidate, lineage]
---
# Hypothesis Generation (Evo Discipline)

Every code change you make to improve a metric is a *candidate*. Treat it as
a falsifiable hypothesis, not a guess.

## Checklist
1. State the hypothesis in one measurable sentence:
   "Changing X will raise <metric> from A to B because <mechanism>."
2. Snapshot the files you are about to mutate with `evo_propose_candidate`
   BEFORE editing (pass the exact file list).
3. Make the minimal change that tests the mechanism — one variable at a time.
4. Run the verification with `evo_evaluate_candidate` (the test command).
5. Read the fitness score and the compact failure digest.
6. If it improved: `evo_select_candidate`. If it regressed or failed:
   `evo_revert_candidate` to restore the snapshot.

## Rules
- Never batch unrelated changes into one candidate — you cannot attribute
  the fitness delta.
- A candidate that cannot be measured is not a hypothesis; do not propose it.
- Keep the hypothesis text short and specific; it is stored in the lineage.
