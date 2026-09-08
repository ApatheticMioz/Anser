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

### 1. [Repository & Configuration Drift Audit (2026-09-05)](file:///d:/LLM_Ecosystem/docs/audits/AUDIT_2026-09-05.md)
- **Focus**: Cross-platform configuration drift, sync timeouts across orchestrator clients (Claude Code vs. Antigravity IDE), environment variable leakage, and dead code elimination.
- **Key Findings**: Identification of DrvFs path separators across POSIX/NTFS boundaries, unindexed directory traversal traps, and lock contention mitigations.

### 2. [Anser Implementation & Progress Ledger](file:///d:/LLM_Ecosystem/docs/audits/ANSER_PROGRESS.md)
- **Focus**: Step-by-step development history of the Anser runtime.
- **Components Built**:
  - Embedded Anser microkernel (`src/harness/core/kernel.js`, `events.js`)
  - Structural AST surgery service via `@ast-grep/napi` with syntax-validation safety gates
  - Traceback condenser reducing 8,000-character stack traces to $\le 100$-token digests
  - 5-layer zero-risk sandboxing preventing disk escapes beyond workspace root
  - Closed-loop evolutionary candidate engine (`.evo/lineage.json`)

### 3. [Patchwork Adversarial Security Audit (2026-09-05)](file:///d:/LLM_Ecosystem/docs/audits/PATCHWORK_ADVERSARIAL_AUDIT_2026-09-05.md)
- **Focus**: Adversarial threat modeling attacking the AST surgery engine, shell executor, and file mutation boundary.
- **Outcomes**: Hardening against symlink escapes (`fs.realpathSync`), Windows reserved device names (`CON`, `PRN`, `AUX`, `NUL`), drive-root destructions (`format C:`, `rm -rf /`), and process group zombie leaks.

### 4. [Qwen-Evo Collaborative Peer Audit](file:///d:/LLM_Ecosystem/docs/audits/QWEN_EVO_AUDIT.md)
- **Focus**: Joint code-review and stress evaluation executed collaboratively between Lead Architect (Gemini 3.8 Flash) and local coworker (Qwen3.8-27B).
- **Outcomes**: Validation of Evo candidate lineage records, git commit grounding, and prefix-caching stability.

---

## Key Architecture References

- **MCP Server Architecture**: [`mcp-qwen/index.js`](file:///d:/LLM_Ecosystem/mcp-qwen/index.js)
- **Engineering Decisions & Benchmark Changelog**: [`docs/archive/DEVELOPMENT_NOTES_2026.md`](archive/DEVELOPMENT_NOTES_2026.md)
- **SWE-rebench Validation Suite**: [`benchmarks/swe-rebench/README.md`](file:///d:/LLM_Ecosystem/benchmarks/swe-rebench/README.md)
- **Upstream vLLM Wedge Repro Report**: [`benchmarks/wedge-repro/RESULTS.md`](file:///d:/LLM_Ecosystem/benchmarks/wedge-repro/RESULTS.md)
