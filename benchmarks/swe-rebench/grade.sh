#!/bin/bash
# Grade a predictions file against nebius/SWE-rebench-leaderboard using
# SWE-rebench's OWN eval tool (scripts/eval.py from SWE-rebench/SWE-rebench-V2,
# cloned to ~/swe-rebench-eval/repo). CORRECTED 2026-08-24: the generic PyPI
# `swebench` package's run_evaluation does NOT work against this dataset -
# it expects a pre-baked `eval_script`/`eval_type`/`log_parser` triple per
# instance (a newer/different harness API), while this dataset ships
# `install_config` + `harbor_*` fields for SWE-rebench's own tool instead.
# Confirmed by reading eval.py directly: it reads `image_name` (not `image`),
# builds the eval script itself from `install_config.test_cmd` +
# `install_config.log_parser`, and applies `patch`/`test_patch` inside the
# container - no Docker image build step needed, just `docker pull` of the
# already-built per-instance image.
#
# Usage: bash grade.sh predictions/goose_qwen_2026_03_50.jsonl
set -e
PRED_FILE="${1:?usage: grade.sh <predictions.jsonl>}"
RUN_ID="$(basename "$PRED_FILE" .jsonl)"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EVAL_REPO="$HOME/swe-rebench-eval/repo"
VENV="$HOME/swe-rebench-eval/venv/bin/python"

mkdir -p "$HERE/results"

# Convert our {instance_id, model_patch, ...} JSONL to eval.py's expected
# [{"instance_id":..., "patch":...}, ...] JSON list.
"$VENV" -c "
import json
rows = []
with open('$PRED_FILE', encoding='utf-8') as f:
    for line in f:
        r = json.loads(line)
        rows.append({'instance_id': r['instance_id'], 'patch': r['model_patch']})
with open('$HERE/predictions/patches_${RUN_ID}.json', 'w', encoding='utf-8') as f:
    json.dump(rows, f, ensure_ascii=False, indent=2)
print(f'Wrote {len(rows)} patch entries')
"

# --instance-ids scopes eval.py to exactly the sampled instances - without it,
# eval.py grades the WHOLE hf-split (110 tasks for 2026_03), wasting ~60 Docker
# pulls/test runs on instances that were never sampled or solved (confirmed the
# hard way: the first grading run graded all 110 and had to be filtered after
# the fact in analysis instead of at the source).
INSTANCE_IDS=$("$VENV" -c "
import json
with open('$PRED_FILE', encoding='utf-8') as f:
    ids = [json.loads(l)['instance_id'] for l in f if l.strip()]
print(','.join(ids))
")

cd "$EVAL_REPO"
"$VENV" scripts/eval.py \
    --hf-dataset nebius/SWE-rebench-leaderboard \
    --hf-config default \
    --hf-split 2026_03 \
    --patches "$HERE/predictions/patches_${RUN_ID}.json" \
    --instance-ids "$INSTANCE_IDS" \
    --max-workers 4 \
    --report-json "$HERE/results/${RUN_ID}_report.json"

echo "Report written to $HERE/results/${RUN_ID}_report.json"
