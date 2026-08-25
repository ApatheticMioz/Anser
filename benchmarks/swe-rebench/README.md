# SWE-rebench eval: Goose + Qwen3.8-27B, CTX=huge

Validates the actual served, quantized model (not the self-reported 61.7
SWE-bench Pro figure, which was almost certainly measured on a different
checkpoint/precision) against a **contamination-resistant** benchmark.

**Status: complete.** Result: **32.0% Resolved Rate (16/50)**, best-of-1,
44% of the sample never got a solve attempt within the 900s timeout — see
[results/results.md](results/results.md) for the full breakdown (including
the more informative 57.1% per-attempt rate) and an honest log of the five
real bugs (two in the solve script, three in the grading path — one of
which was upstream, in SWE-rebench's own `eval.py`) found and fixed before
this number could be trusted.

## Why this benchmark and not SWE-bench Verified/Pro

OpenAI retired SWE-bench Verified in Feb 2026 after an audit found 59.4% of
"hard" tasks flawed and frontier models reproducing gold patches verbatim
from the task ID alone (10.6% documented leakage). SWE-bench Pro was
scrapped by the same team ~5 months later for the same failure mode. Both are
disqualified for "validate my setup cleanly."

[SWE-rebench](https://swe-rebench.com/) (Nebius) rebuilds its **leaderboard**
eval set from real GitHub issues opened in a given month, published as
monthly splits on `nebius/SWE-rebench-leaderboard` (distinct from the much
larger `nebius/SWE-rebench-V2`, which is a training-oriented pool with tasks
dating back to 2021 and is NOT contamination-resistant - do not sample from
it for evaluation). A model can't have memorized a month's issues if they
postdate its training cutoff.

**Split used: `2026_03`** (110 tasks) - the most recent split actually
published as of 2026-08-24 (`get_dataset_config_names` only lists a `default`
config; splits are discovered from the dataset's own split list, currently
`2025_01` .. `2026_03`; nothing newer was available despite the live
leaderboard *site* showing an "August 2026" snapshot - that site figure is
evidently computed from a batch not yet published to this HF dataset).
March 2026 still safely postdates Qwen3.5's Feb 24 2026 release and
Sonnet 5's January 2026 knowledge cutoff, so it's clean for this purpose -
just not as fresh as the site implies. Re-check for a newer split
(`2026_04`+) before reusing this setup for a future run.

## What this measures, and what it doesn't

- **Goose + Qwen alone, best-of-1.** Per your scope: no Sonnet in the loop
  (no delegation-architecture question here, just "is the model any good"),
  single attempt per task (SWE-rebench's own leaderboard protocol is 5 runs
  per problem, best-of-5 Resolved Rate - our number is **not** directly
  comparable to the published 53.7%/65.3% figures, only roughly so; a wider
  gap either way could just be best-of-1 vs best-of-5 variance, not a real
  capability gap).
- Python-only by construction (`nebius/SWE-rebench-leaderboard`'s 2026_03
  split has no `language` field and every sampled repo is a Python
  ecosystem project - pandas, scikit-learn, scrapy, etc.).
- The 50-task sample (seeded, reproducible: `--seed 20260824`) is a
  **directional** signal, not a tight confidence interval - see
  `D:\LLM_Ecosystem\README.md`'s benchmarking section for why a bigger run
  is a separate, later decision.

## Pipeline and where everything lives

Scripts and results live here (`D:\LLM_Ecosystem\benchmarks\swe-rebench\`,
Windows-side, version-controllable). Heavy/native artifacts live in WSL's own
filesystem for I/O reasons (cross-filesystem `/mnt/d` access is slow for many
small files - venvs, HF dataset cache, Docker layers):

| What | Where | Why there |
|---|---|---|
| This repo's scripts, task samples, results | `D:\LLM_Ecosystem\benchmarks\swe-rebench\` | Windows-editable, alongside the rest of this repo |
| Harness venv (`swebench`, `datasets`) | WSL: `~/swe-rebench-eval/venv` | Isolated from `~/qwen-serving`'s venv (different, potentially conflicting pins); native ext4 for venv perf |
| HF dataset cache | WSL: `~/.cache/huggingface` (default) | Native fs |
| Docker images (grading step only) | WSL Docker's own storage (default) | Native fs; Docker already installed (29.5.3), 641 GB free on `/` |
| Solve-step scratch clones (Goose+Qwen step) | Windows: `%LOCALAPPDATA%\Temp\swe-rebench-scratch` (default, `--workdir` to override) | Goose itself is Windows-native (`goose.exe`), same as `mcp-qwen/index.js` |

### 1. Sample tasks (done - non-GPU, already run)

```bash
# WSL, inside the isolated venv
~/swe-rebench-eval/venv/bin/python sample_tasks.py --split 2026_03 --n 50 --seed 20260824
```
Output: `predictions/sample_2026_03_50.jsonl` - 50 tasks, `problem_statement`
+ repo/commit info only. Deliberately excludes `test_patch`/`FAIL_TO_PASS`/
`PASS_TO_PASS` - the harness pulls those straight from the HF dataset by
`instance_id` at grading time, so the solve step never sees them.

### 2. Solve (done)

```powershell
# Windows, from this directory
py -3.11 run_goose_solve.py --tasks predictions\sample_2026_03_50.jsonl --out predictions\goose_qwen_2026_03_50.jsonl
```
One fresh `goose.exe run --no-session` per task (no cross-task memory),
same `GOOSE_PROVIDER=openai` / `GOOSE_MODEL=qwen3.8-27b` / `OPENAI_HOST` /
`OPENAI_BASE_PATH` env pattern `mcp-qwen/index.js` uses for
`delegate_coding_task` - kept in sync with it deliberately; if that env
setup changes there, mirror it here. Resumable (skips `instance_id`s already
in `--out`), so a killed run just re-invokes cleanly. Took several hours in
practice - 22/50 tasks genuinely exhausted the 900s per-task budget without
producing a patch (real signal about task difficulty in unfamiliar large
repos, not a bug - see results/results.md). Two real script bugs were found
and fixed mid-run (Windows codepage crash on Goose's UTF-8 output; a locked
leftover scratch dir colliding with a fresh `mkdir`) - both fixes are in
the current version of this script.

### 3. Grade (done)

```bash
# WSL
bash grade.sh predictions/goose_qwen_2026_03_50.jsonl
```
Uses SWE-rebench's own `scripts/eval.py` (cloned from
`SWE-rebench/SWE-rebench-V2` to `~/swe-rebench-eval/repo`, patched - see
below) - **not** the generic PyPI `swebench` package, which does not work
against this dataset's schema (confirmed by reading its source: it expects
a pre-baked `eval_script`/`eval_type` per instance that this dataset
doesn't carry). Pulls one Docker image per instance, applies the patch,
runs `FAIL_TO_PASS`+`PASS_TO_PASS`, reports per-instance results.
**One upstream bug found and patched locally**: `eval.py` assumed the repo
is checked out at `/{repo-name}` inside the container; live inspection of
an actual container showed it's at the standard SWE-bench `/testbed` path
instead, which made every single `git apply` fail with a false "not a git
repository" error until fixed. Result: [results/results.md](results/results.md).

## Repos in the current 50-task sample

Azure-Samples/azure-search-openai-demo, Beever-AI/beever-atlas,
Deltares/HYDROLIB-core, GenericMappingTools/pygmt, HKUDS/OpenHarness,
MemPalace/mempalace, PyCQA/isort, PyPSA/PyPSA, Ultraplot/UltraPlot,
agentscope-ai/QwenPaw, agronholm/anyio, alibaba/OpenSandbox,
apache/iceberg-python, astronomy-commons/lsdb, conan-io/conan,
databricks/dbt-databricks, graphistry/pygraphistry, harumiWeb/exstruct,
hiero-ledger/hiero-sdk-python, holoviz/param, huggingface/huggingface_hub,
keras-team/keras, macbre/sql-metadata, meltano/meltano,
nesquena/hermes-webui, pallets-eco/wtforms, pallets/click, pandas-dev/pandas,
pipecat-ai/pipecat, pyinfra-dev/pyinfra, python-scim/scim2-models,
raullenchai/Rapid-MLX, schemathesis/schemathesis, scikit-learn/scikit-learn,
scrapy/scrapy, sigma67/ytmusicapi, sqlfluff/sqlfluff, sunpy/sunpy,
tobymao/sqlglot, tox-dev/tox, vprusso/toqito, zauberzeug/nicegui.

## Sources

- [OpenAI: why SWE-bench Verified no longer measures frontier capability](https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified/)
- [SWE-rebench leaderboard](https://swe-rebench.com/)
- [nebius/SWE-rebench-leaderboard dataset](https://huggingface.co/datasets/nebius/SWE-rebench-leaderboard)
- [nebius/SWE-rebench-V2 dataset (training pool, not used for eval here)](https://huggingface.co/datasets/nebius/SWE-rebench-V2)
