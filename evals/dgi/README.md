# Decomposition Granularity Index (DGI) Benchmark & Stress Test

This directory houses the benchmark dataset and evaluation suite for Castor's DGI Gatekeeper (`src/mcp/dgi.rs`).

## Files
- `dataset.json`: **Master benchmark dataset (187 prompts)** combining the 110 cross-domain benchmark prompts and all 77 historical dispatches from the large Claude-Code session.
- `dataset_110.json`: 110 synthetic cross-domain prompts covering:
  - **Research** (25 prompts): Single-topic docs, paper synthesis, API audits, unconstrained multi-topic sprawl.
  - **Coding across Languages** (50 prompts): Rust, Python, Go, TypeScript/JS, C++, spanning micro-fixes, AST surgery, rich specifications, multi-subsystem sprawl, data table bloat, and directive spam.
  - **Writing & Documentation** (20 prompts): Single-document updates (README, RFC, CHANGELOG) vs. multi-chapter monolithic overhauls.
  - **Adversarial Edge Cases** (15 prompts): Exact character boundary transitions (2,490 vs 2,510 chars), syntax-heavy blocks, embedded SQL/JSON dumps, pathless prompts.
- `dataset_claude_77.json`: All 77 real `castor_coworker` dispatches from the historical Claude-Code session (`dd5babd8-bdda-4232-bc62-a42421ac7296.jsonl`), including the 7 calibration anchors.
- `eval.py`: Standalone evaluation harness for benchmarking classification accuracy, precision, recall, and per-prompt latency.

## Running the Evaluation
```bash
# Evaluate master dataset (187 prompts)
python evals/dgi/eval.py

# Or evaluate a specific subset
python evals/dgi/eval.py evals/dgi/dataset_110.json
python evals/dgi/eval.py evals/dgi/dataset_claude_77.json
```
