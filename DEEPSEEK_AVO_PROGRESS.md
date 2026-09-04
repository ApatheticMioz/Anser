# DeepSeek AVO: Autonomous Agent Harness & Evolutionary Framework
**Engineering Progress, Decision Ledger, & Comparative Benchmarks**

- **Project Lead**: Lead Architect (Gemini 3.8 Flash / Claude GLM-5.3) & Autonomous Execution Engine (Qwen3.8-27B)
- **Start Date**: 2026-09-05
- **Git Branch**: `feat/deepseek-avo`
- **Status**: Milestone 1 (In Progress)

---

## 1. Executive Summary & Vision

The **DeepSeek AVO** project unifies the two leading agent paradigms of 2026 into a single, cohesive, local-first runtime for Qwen3.8-27B:
1. **DeepSeek Harness (`dsh` / Cordis Meta-Framework)**: A microkernel plugin architecture where "everything is a plugin" with reversible effects, strict filesystem sandboxing, and append-only event streams.
2. **NVIDIA AVO (*Agentic Variation Operators*, arXiv:2603.24517)**: An autonomous evolutionary optimization loop (`propose -> mutate -> execute -> evaluate -> select/revert`) guided by live closed-loop execution feedback (profilers, test runners, compiler metrics).

### Key Architectural Shifts from Legacy Goose
| Dimension | Legacy Goose CLI Wrapper | DeepSeek AVO Harness |
| :--- | :--- | :--- |
| **Runtime Model** | Monolithic interactive CLI binary | Modular Cordis-style microkernel in native JS/Node |
| **Tool Sandboxing** | Un-sandboxed host shell (crawls `.venv`) | Path-isolated sandbox with automated `.ignore` filters |
| **Session Persistence**| Opaque SQLite per OS (`sessions.db`) | Append-only JSONL event logs with instant branching |
| **Turn Ceilings** | Hardcoded `--max-turns 50` | Policy-governed, prompt-scoped, or unbounded |
| **Optimization Loop** | One-shot code generation | Closed-loop evolutionary mutation & metric lineage |
| **Process Control** | Fragile CLI subprocess wrapper | Direct SSE stream handling, keep-alive, & clean signals |

---

## 2. Milestone Roadmap

- [ ] **Milestone 1: Git Worktree Setup & Architectural Foundation**
  - [x] Dedicated progress ledger initialized (`DEEPSEEK_AVO_PROGRESS.md`)
  - [ ] Git branch/worktree `feat/deepseek-avo` created
  - [ ] Technical specifications and interfaces documented
- [ ] **Milestone 2: Cordis-Style Microkernel & Service Layer**
  - [ ] `mcp-qwen/src/harness/core/kernel.js`: Microkernel, dependency injection, reversible effect disposers
  - [ ] `mcp-qwen/src/harness/core/events.js`: Typed event bus
  - [ ] `mcp-qwen/src/harness/services/provider_vllm.js`: Direct HTTP/SSE streaming client with keep-alive
  - [ ] `mcp-qwen/src/harness/services/sandbox_fs.js`: Sandboxed filesystem dispatcher with auto `.ignore`
  - [ ] `mcp-qwen/src/harness/services/shell_executor.js`: Process group manager with synchronous signal traps
  - [ ] `mcp-qwen/src/harness/services/event_logger.js`: Append-only JSONL session ledger with branching
- [ ] **Milestone 3: NVIDIA AVO Evolutionary Engine**
  - [ ] `mcp-qwen/src/harness/avo/avo_operator.js`: The evolutionary loop (`propose -> mutate -> execute -> evaluate`)
  - [ ] `mcp-qwen/src/harness/avo/evaluator.js`: Closed-loop metric extractor (throughput, latency, test pass/fail)
  - [ ] `mcp-qwen/src/harness/avo/lineage_dag.js`: Candidate mutation tree in `.avo/lineage.json`
  - [ ] `mcp-qwen/src/harness/avo/watchdog.js`: Stagnation breaker and token velocity monitor
- [ ] **Milestone 4: Integration with `mcp-qwen` & Dual-Engine Dispatch**
  - [ ] Add `DeepSeekAvoRunner` as primary execution engine in `goose_runner.js`
  - [ ] Maintain legacy Goose CLI as fallback (`QWEN_ENGINE=legacy_goose`)
  - [ ] Update MCP tool schemas & verify `:18021` coordinator integration
- [ ] **Milestone 5: Comparative Benchmarking & Validation**
  - [ ] Benchmark 1: Filesystem traversal latency (DrvFs `.venv` ignore test)
  - [ ] Benchmark 2: Multi-turn prompt prefill & context accumulation
  - [ ] Benchmark 3: Real closed-loop evolutionary optimization run
- [ ] **Milestone 6: GitHub Hygiene, Review & PR Delivery**
  - [ ] Full test suite validation
  - [ ] Atomic git commits
  - [ ] Pull Request documentation and final review

---

## 3. Decision Log & Engineering Journal

### Entry 001 - 2026-09-05: Project Kickoff & Architectural Decisions
- **Decision 1.1 (Runtime Language)**: Implement the DeepSeek AVO harness in native modern ECMAScript (ESM) inside `mcp-qwen/src/harness/`. This eliminates binary wrapper latency, runs cross-platform across Windows and WSL without compilation, and shares the existing Node.js memory footprint.
- **Decision 1.2 (Direct Model Transport)**: Bypass Goose's CLI formatting. Connect directly to the local vLLM stream proxy (`:18022`) via native Fetch/SSE with proactive `: keep-alive` frames.
- **Decision 1.3 (Ripgrep-Powered Sandbox)**: Implement path sandboxing in `sandbox_fs.js` utilizing ripgrep with default ignore rules (`.venv`, `node_modules`, `.git`, `__pycache__`, `target`). This permanently eliminates the WSL 9P DrvFs traversal hangs.
