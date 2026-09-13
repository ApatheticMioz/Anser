# Documentation & Engineering Audits

This directory contains architectural specifications, adversarial audits, engineering ledgers, and formal verification reports for the **LLM_Ecosystem** and the **Anser** harness.

---

## Directory Overview

```
docs/
├── README.md                               # This documentation index
└── audits/
    ├── AUDIT_2026-09-05.md                 # Full repository & configuration drift audit
    ├── ANSER_PROGRESS.md                   # Anser runtime implementation ledger
    ├── PATCHWORK_ADVERSARIAL_AUDIT_2026-09-05.md # Threat modeling & adversarial architecture review
    └── QWEN_EVO_AUDIT.md                   # Collaborative peer-review & stress analysis
```

---

## Audit Index

### 1. [Repository & Configuration Drift Audit (2026-09-05)](audits/AUDIT_2026-09-05.md)
- **Focus**: Cross-platform configuration drift, sync timeouts across orchestrator clients (Claude Code vs. Antigravity IDE), environment variable leakage, and dead code elimination.
- **Key Findings**: Identification of DrvFs path separators across POSIX/NTFS boundaries, unindexed directory traversal traps, and lock contention mitigations.

### 2. [Anser Implementation & Progress Ledger](audits/ANSER_PROGRESS.md)
- **Focus**: Step-by-step development history of the Anser runtime.
- **Components Built**:
  - Embedded Anser microkernel (`src/harness/core/kernel.js`, `events.js`)
  - Structural AST surgery service via `@ast-grep/napi` with syntax-validation safety gates
  - Traceback condenser reducing 8,000-character stack traces to $\le 100$-token digests
  - 5-layer zero-risk sandboxing preventing disk escapes beyond workspace root
  - Closed-loop evolutionary candidate engine (`.evo/lineage.json`)

### 3. [Patchwork Adversarial Security Audit (2026-09-05)](audits/PATCHWORK_ADVERSARIAL_AUDIT_2026-09-05.md)
- **Focus**: Adversarial threat modeling attacking the AST surgery engine, shell executor, and file mutation boundary.
- **Outcomes**: Hardening against symlink escapes (`fs.realpathSync`), Windows reserved device names (`CON`, `PRN`, `AUX`, `NUL`), drive-root destructions (`format C:`, `rm -rf /`), and process group zombie leaks.

### 4. [Qwen-Evo Collaborative Peer Audit](audits/QWEN_EVO_AUDIT.md)
- **Focus**: Joint code-review and stress evaluation executed collaboratively between Lead Architect (Gemini 3.8 Flash) and local coworker (Qwen3.8-27B).
- **Outcomes**: Validation of Evo candidate lineage records, git commit grounding, and prefix-caching stability.

### 5. [Qwen Usage Audit — Balancing Cloud/Local Orchestration (2026-09)](qwen-usage-audit-2026-09.md)
- **Focus**: Dispatch discipline forensic cross-analysis across Antigravity session `38daaf48` and Anser telemetry; empirical basis for CLAUDE.md/GEMINI.md §3 dispatch policy.
- **Outcomes**: Implementation of per-dispatch `reasoning_effort`, 7-day retention, orphan-death events, and `dispatch-scorecard.mjs`.

### 6. [Cross-Session Forensic Audit: vLLM Telemetry & Dispatch Dynamics (2026-09-13)](audits/CROSS_SESSION_VLLM_AND_QWEN_DISPATCH_AUDIT_2026-09-13.md)
- **Focus**: Parallel workload evaluation across Claude Code (WSL2, 23h Q1 paper revision marathon) and Antigravity IDE (Windows, Goose->Anser purge).
- **Outcomes**: Extraction of live vLLM telemetry (93.1% prefix cache hit rate, 57% DFlash2 spec acceptance, 3.99 tokens/step speedup), analysis of 45 tasks (3,997 turns, 1,536 tools), classification of good vs. bad prompts, and preservation of telemetry snapshots.

### 7. [WSL Supervisory Forensic Audit: Antigravity Overseeing Claude Code & Qwen on /final (2026-09-13)](audits/WSL_FINAL_SUPERVISORY_SESSION_AUDIT_2026-09-13.md)
- **Focus**: Deep-dive into WSL Antigravity session `d10f18ad` overseeing Claude Code's 20h revision marathon in `/home/apath/Work/temp/final`.
- **Outcomes**: Forensic diagnosis of the 93-minute Fig 2 probe loop, wait endpoint HTTP 500 error, Zhipu AI / GLM API 400 PDF poison pill rescue via JSONL surgical sanitization, LaTeX float starvation fixes, and the anti-probe dispatch constraint.

---

## Key Architecture References

- **MCP Server Architecture**: [`mcp-qwen/index.js`](../mcp-qwen/index.js)
- **Engineering Decisions & Benchmark Changelog**: [`docs/archive/DEVELOPMENT_NOTES_2026.md`](archive/DEVELOPMENT_NOTES_2026.md)
- **[OLD] SWE-rebench Validation Suite (Early Prototype Runner)**: [`benchmarks/swe-rebench/README.md`](../benchmarks/swe-rebench/README.md)
- **Upstream vLLM Wedge Repro Report**: [`benchmarks/wedge-repro/RESULTS.md`](../benchmarks/wedge-repro/RESULTS.md)
