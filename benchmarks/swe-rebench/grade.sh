#!/bin/bash
# Grade a predictions file produced by run_goose_solve.py against
# nebius/SWE-rebench-leaderboard, using the standard swebench harness (this
# dataset is schema-compatible with swebench.harness.run_evaluation - same
# instance_id/FAIL_TO_PASS/PASS_TO_PASS/docker image conventions).
#
# Pulls one Docker image per distinct repo touched by the sample (not per
# task - repos repeat across instances), applies model_patch inside it, runs
# FAIL_TO_PASS + PASS_TO_PASS, and reports Resolved Rate. This is what
# actually needs internet + disk for image pulls; nothing above this script
# in the pipeline touches Docker.
#
# Usage: bash grade.sh predictions/goose_qwen_2026_03_50.jsonl
set -e
PRED_FILE="${1:?usage: grade.sh <predictions.jsonl>}"
RUN_ID="$(basename "$PRED_FILE" .jsonl)"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

mkdir -p "$HERE/results"

~/swe-rebench-eval/venv/bin/python -m swebench.harness.run_evaluation \
    --dataset_name nebius/SWE-rebench-leaderboard \
    --split 2026_03 \
    --predictions_path "$PRED_FILE" \
    --max_workers 4 \
    --run_id "$RUN_ID" \
    --report_dir "$HERE/results"

echo "Summary json + per-instance logs written under $HERE/results/ and"
echo "./logs/run_evaluation/$RUN_ID/ (swebench's own default log location,"
echo "relative to wherever this script was invoked from)."
