# Decomposition Granularity Index (DGI) Benchmark & Stress Test

This directory houses the benchmark dataset and evaluation suite for Castor's DGI Gatekeeper (`src/mcp/dgi.rs`).

## Files
- `dataset_110.json`: 110-prompt cross-domain dataset covering:
  - **Research** (25 prompts): Single-topic docs, paper synthesis, API audits, unconstrained multi-topic sprawl.
  - **Coding across Languages** (50 prompts): Rust, Python, Go, TypeScript/JS, C++, spanning micro-fixes, AST surgery, rich specifications, multi-subsystem sprawl, data table bloat, and directive spam.
  - **Writing & Documentation** (20 prompts): Single-document updates (README, RFC, CHANGELOG) vs. multi-chapter monolithic overhauls.
  - **Adversarial Edge Cases** (15 prompts): Exact character boundary transitions (2,490 vs 2,510 chars), syntax-heavy blocks, embedded SQL/JSON dumps, pathless prompts.
- `eval.py`: Standalone evaluation harness for benchmarking classification accuracy, precision, recall, and per-prompt latency.

## Running the Evaluation
```bash
python evals/dgi/eval.py
```
