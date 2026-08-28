# LLM_Ecosystem

Local-first LLM delegation stack: Claude Sonnet 5 (in Claude Code) / Gemini 3.7 Flash (in Antigravity IDE) orchestrates as the **Lead Architect / Meta-Supervisor**, while a locally-served **Qwen3.8-27B** (vLLM + DFlash2 + KVarN @ 245K context) executes bounded implementation tasks for free ($0 token cost) via the **Goose Agent Harness** as the **Autonomous Variation & Execution Operator (Coworker)**.

Agent-facing rules and invariant protocols live in the global user memory at `~/.claude/CLAUDE.md` (mirrored to `~/.gemini/GEMINI.md` across Windows and WSL; loaded into every session, so no project-level copy is kept in this repo). This document serves as the comprehensive human-readable architectural specification, benchmark reference, and operational guide.

---

## 1. Repository Layout

```
D:\LLM_Ecosystem\
├── README.md                   This architecture & operational specification
├── scripts\                    Windows-side launchers & automation drivers
│   ├── avo_runner.py           NVIDIA AVO loop driver: reads .avo/lineage.json,
│   │                           queries local Qwen for candidate hypotheses, and emits
│   │                           qwen_coworker dispatch packets under .avo/avq/
│   ├── status.bat              Unified service checker (checks port 18020 & 18021)
│   ├── main\                   Delegation stack launchers (vLLM + MCP + Goose)
│   │   ├── start.bat           Default entry point -> start_huge.bat
│   │   ├── start_huge.bat      CTX=huge (245,760 ctx, DFlash2, KVarN k4v2)
│   │   ├── start_fast.bat      CTX=fast (57,344 ctx, ~107-130 tok/s, fp8 cache)
│   │   └── stop.bat            Stops the active vLLM instance
│   ├── uncensored\             Manual / academic-use model (NOT MCP-wired)
│   │   ├── download_model.sh   One-time GGUF fetch into WSL
│   │   ├── start.bat           Starts llama-server on port 18020 (reasoning ON)
│   │   ├── start_noreason.bat  Starts llama-server (reasoning OFF: -rea off)
│   │   └── stop.bat            Stops llama-server
│   └── wsl\                    WSL bash equivalents invoked by the .bat scripts
│       ├── setup_links.sh      Symlinks launchers into ~/qwen-serving/launchers
│       ├── start_huge.sh       vLLM huge context launcher (VLLM_DFLASH2_CHAIN=0, disabled 2026-08-28: wedge suspect)
│       ├── start_fast.sh       vLLM fast context launcher
│       ├── status.sh           WSL-side health & port check
│       ├── stop.sh             WSL-side process terminator
│       ├── wait_ready.sh       Startup readiness polling loop
│       ├── run_qb.sh           Batch prompt helper
│       └── wait_qb.sh          Batch queue waiter
├── llama-cpp\                  Native Windows CUDA build of llama.cpp (serves
│                               scripts\uncensored\ GGUF models on Windows)
├── mcp-qwen\                   MCP Server (Node.js v4.2.0) exposing local Qwen to orchestrators
│   ├── index.js                3 consolidated SOTA tools (qwen_coworker, qwen_task,
│   │                           qwen_server), zero-turn wait HTTP server @ localhost:18021,
│   │                           global goose semaphore (cross-process leases,
│   │                           MAX_CONCURRENT_GOOSE=1), and WSL path routing
│   ├── avo_engine.js           AVO lineage engine (git-grounded candidate records
│   │                           in <cwd>/.avo/lineage.json)
│   ├── test_fifo_queue.js      Automated test suite for serialized task execution
│   ├── test_global_semaphore.js Cross-process lease-semaphore test (no vLLM needed)
│   ├── mcp_client_test.js      MCP client connectivity & protocol test harness
│   ├── update_schemas.py       Regenerates per-tool JSON schemas into Antigravity IDE
│   ├── NOTES.md                Complete engineering decisions, benchmark logs & changelog
│   └── package.json            Dependencies (@modelcontextprotocol/sdk, zod)
├── benchmarks\
│   └── swe-rebench\            Contamination-resistant validation benchmark pipeline
│                               (March 2026 split, Docker-graded, 32.0% resolved rate)
├── .venv\                      Standalone Open WebUI Python environment (optional Web UI)
├── .webui_secret_key           Open WebUI session secret key
├── .mcp.json                   Local MCP placeholder configuration
└── .claude\                    Claude Code harness state
```

> [!NOTE]
> The vLLM server, model weights, and backend serving codebase live in WSL Ubuntu at `~/qwen-serving` (a fork of [syv-ai/qwen38-27b-rtx3090](https://github.com/syv-ai/qwen38-27b-rtx3090)). `mcp-qwen/index.js` and `scripts/main/*.bat` provide the unified Windows-side management and agentic bridge.

---

## 2. System Architecture

```
User <───> Meta-Supervisor / Lead Architect
            (Claude Sonnet 5 in Claude Code / Gemini 3.7 Flash in Antigravity)
                               │
                               │  MCP (stdio) - 3 Consolidated Tools:
                               │  - qwen_coworker (prompt, session_id, cwd, extensions, avo)
                               │  - qwen_task (status, cancel, list)
                               │  - qwen_server (status, start, stop)
                               ▼
            ┌─────────────────────────────────────────────────────────┐
            │  mcp-qwen/index.js (v4.2.0 Unified MCP Server)           │
            │  ├── 45s Sync Race (fast tasks return Turn 1 directly)   │
            │  ├── Background Task Manager (~/.qwen/tasks/ JSON)       │
            │  ├── Global Goose Semaphore (MAX_CONCURRENT_GOOSE=1)     │
            │  ├── Native WSL / Windows Path Routing & UNC Sanitizer   │
            │  └── Zero-Turn HTTP Wait Endpoint (localhost:18021)      │
            └─────────────────────────────────────────────────────────┘
                               │
                               ▼
            Goose Agent Harness (block/goose Rust binary)
            - Spawned per task with persistent named sessions (--resume)
            - Autonomous tool loop: file edit, AST rewrite, bash/cmd execution
            - Attached extensions: free-search-mcp, context7, gh CLI
                               │
                               │  OpenAI-compatible API (/v1/chat/completions)
                               ▼
            vLLM Engine (WSL Ubuntu @ port 18020)
            - Qwen3.8-27B (W4A16 AutoRound, dense hybrid architecture)
            - DFlash2 1.92B Block Drafter (VLLM_DFLASH2_CHAIN=0, 7 draft tok)
            - Lookup-Augmented Speculation (VLLM_DFLASH2_LOOKUP*)
            - KVarN k4v2 KV Cache (245,760 context ceiling)
            - Prefix Caching enabled (KV reuse across session turns)
                               │
                               ▼
            NVIDIA GeForce RTX 3090 (24 GB VRAM @ 250W Power Cap)
```

---

## 3. Core Protocols & Invariants

### Prescriptive Role Division
- **Lead Architect (Meta-Supervisor)**: System architecture, task decomposition, formal interface design, test specification formulation, rendered UI inspection / multimodal visual QA (native browser subagent), and synthesizing final user deliverables.
- **Local Coworker (Qwen via Goose & MCP @ $0)**: Autonomous hands-on execution: codebase editing, AST manipulation, terminal commands, 50k–200k token repository ingestion, deep web research (`uvx free-search-mcp`), library API lookups (`npx -y context7@latest`), and git operations (`gh` / `git`).

### Execution Contracts & Invariants
1. **Rule 0 — No Raw I/O Loops (Turn 1 Invariant)**: The Lead Architect is strictly forbidden from manually calling exploratory file tools (`list_dir`, `view_file`, `grep_search`, `run_command`) to inspect unfamiliar repositories or documents on Turn 1. It must dispatch exploration and fact ingestion directly to `qwen_coworker` at $0.
2. **Zero-Turn Long-Poll Execution Contract**:
   - **Fast Tasks (< 45s)**: `qwen_coworker` completes inside the 45s synchronous race window and returns the complete deliverable directly in Turn 1.
   - **Long Tasks (>= 45s)**: `qwen_coworker` yields a durable `taskId` and a `wait_command` (`curl -s http://127.0.0.1:18021/task/<id>/wait`). The orchestrator runs this wait command in the background, blocking at OS level with **$0 token cost** until automatically notified on completion. Manual LLM timer loops are prohibited.
3. **Global Concurrency Control (`MAX_CONCURRENT_GOOSE=1`)**: All coworker tasks *machine-wide* are serialized through a cross-process disk-lease semaphore (`~/.qwen/goose_slots/`) shared by every MCP server instance — N concurrent Claude sessions still yield exactly one goose at a time (an in-process limit alone was useless, since every surface spawns its own server process). Tasks waiting for a slot are `queued` on disk (`~/.qwen/tasks/`) with no watchdog or budget ticking, and dispatch automatically when the holder releases; dead holders' leases are reclaimed (pid liveness + heartbeat staleness). Raise the global cap with `QWEN_MAX_CONCURRENT` (keep ≤ engine `MAX_SEQS=8`, or dispatches queue invisibly inside vLLM instead of here).
4. **Cross-Platform WSL/Windows Agnosticism**: Seamless path translation maps POSIX paths (`/home/apath/...`) to Windows UNC (`\\wsl.localhost\Ubuntu\...`) and Windows paths (`D:\...`) to POSIX (`/mnt/d/...`). UNC working directories are cleanly resolved inside WSL to prevent Windows `cmd.exe` UNC directory crashes.
5. **Milestone-Scoped Session Lifecycle**:
   - **Within a Milestone (1–15 Turns)**: Dispatched to the same named `session_id` (`<workspace>_<milestone>`). Reuses the loaded vLLM prefix cache (~8,000–9,000 tok/s prefill, <0.5s wakeup) for continuous episodic memory.
   - **Between Milestones (Context Reset)**: Step up to a new milestone session ID (e.g. `auth_feature` $\to$ `billing_stripe`), shedding stale terminal stdout and resetting active context to the 15k–30k token sweet spot for peak decode throughput (~120–133 tok/s).
6. **Directed Milestone Co-Design Pattern**:
   - **Turn 1 (Fact Ingestion & AST Extraction)**: Qwen maps codebase and AST at $0.
   - **Supervisor Alignment**: Lead Architect reviews extraction and confirms patch specification.
   - **Turn 2 (Directed Mutation / Patch)**: Dispatched to the *same* `session_id` (100% prefix cache hit, finishes in 15–30s).
   - **Turn 3 (Verification & Atomic Git Commit)**: Dispatched to verify builds and create atomic git commits (`feat:`, `fix:`, etc.).
7. **No Direct Goose Invocations (Rule 10)**: All coworker executions must proceed exclusively through the `qwen_coworker` MCP tool, ensuring process isolation, JSONL stream filtering, watchdog timeouts, and task persistence.

---

## 4. Consolidated MCP Tool Suite (`qwen38-local`)

The MCP server (`mcp-qwen/index.js`) exposes three consolidated tools:

### `qwen_coworker`
Primary agentic interface for multi-turn collaboration, code editing, deep research, and AVO mutations.
- **Parameters**:
  - `prompt` *(string, required)*: Task instructions for Qwen.
  - `session_id` *(string, optional)*: Milestone session identifier (e.g. `"myrepo_milestone1"`).
  - `cwd` *(string, optional)*: Target working directory (Windows or POSIX).
  - `extensions` *(string[], optional)*: Dynamic MCP extensions (e.g. `["uvx free-search-mcp"]`, `["npx -y context7@latest"]`).
  - `hypothesis` *(string, optional)*: AVO hypothesis description.
  - `test_command` *(string, optional)*: Post-run verification test command.
  - `metric_name` *(string, optional)*: Quantitative optimization metric name.
  - `higher_is_better` *(boolean, optional)*: Metric optimization direction.
  - `timeout_ms` *(number, optional)*: Maximum background execution budget (default 1 hour).

### `qwen_task`
Manages and queries coworker task execution across memory and disk (`~/.qwen/tasks/`).
- **Parameters**:
  - `action` *(enum: `"status"` | `"cancel"` | `"list"`, required)*.
  - `task_id` *(string, optional)*: Specific task ID for status or cancellation.

### `qwen_server`
Controls the local 245K vLLM server instance lifecycle, with engine-core wedge detection.
- **Parameters**:
  - `action` *(enum: `"status"` | `"start"` | `"stop"`, required)*.
- **Wedge detection**: the port answering is *not* proof of health — a hung engine core keeps `/v1/models` at 200 while every completion is accepted and never scheduled (2026-08-28: 4.5h hang, GPU pegged at 100%, every task killed at the 601s inactivity watchdog with zero stream chunks). Status reads the engine's unconditional 10s stats lines (`/tmp/mcp_launch_huge.log`): >120s of stats silence while the port answers = wedged → automatic kill + relaunch (cross-instance-guarded via `~/.qwen/tasks/.engine_heal.lock`; disable with `QWEN_AUTO_HEAL=0`, tune threshold with `QWEN_WEDGE_SILENCE_S`). Status also reports live gauges — running/waiting requests, KV cache %, engine-stats age. `qwen_coworker` runs the same gate before every dispatch, so a dispatch into a wedged engine self-heals instead of hanging.
- **First-Token Timeout** (on `qwen_coworker`): if goose emits zero output within 120s of spawn (`QWEN_FIRST_TOKEN_TIMEOUT_MS`), the task fails fast with an explicit "engine wedged or saturated, no work performed" message — distinct from the 600s mid-stream inactivity heartbeat, which only applies after streaming has begun.

---

## 5. Model Serving, Speculative Decoding & Quantization Architecture

- **Base Model**: Qwen3.8-27B (Qwen3.5 hybrid dense architecture — Gated-DeltaNet + linear/standard attention, 65 layers, MoE-free).
- **Weight Quantization**: W4A16 AutoRound (`Qwen3.8-27B-W4A16-AutoRound`) with `--language-model-only` (vision encoder removed, saving 2.7 GB VRAM).
- **Memory Optimizations**:
  1. `quant_lm_head.py`: 248k-row `lm_head` (2.5 GB bf16) $\to$ int8 group-128 in place (saves ~1.3 GB).
  2. `quant_embed.py`: Untied `embed_tokens` matrix $\to$ int8 group-128 (saves ~1.3 GB).
  3. `quant_mtp.py`: MTP speculative decode draft module $\to$ int8.
  4. `build_draft_vocab.py`: Slices a 40,960-row subset of `lm_head` calibrated on model outputs for speculative verification.
- **Speculative Decoding Options**:
  - **DFlash2 Block Drafter (`SPEC=dflash2`, Default)**: 1.92B parameter, 5-layer non-autoregressive block drafter predicting 7 tokens per pass from target layers 5/19/33/47/61 with a 16-candidate path selector, quantized to ~1.0 GB (`quant_dflash2.py`). `VLLM_DFLASH2_CHAIN` disabled (2026-08-28): upstream-off by default, +7% on copy-heavy workloads only, and the prime suspect for the recurring engine-core wedges (see `mcp-qwen/NOTES.md`).
  - **Lookup-Augmented Drafting (`VLLM_DFLASH2_LOOKUP*`)**: Proposes context continuations directly when reproducing or quoting documents (speeds up to 381 tok/s).
  - **MTP Drafter (`SPEC=mtp`, Fallback)**: Int4-GPTQ single-layer chain drafter (4 draft tokens, split-KV verify attention).
- **KVarN KV Cache (`CTX=huge`)**:
  - [KVarN](https://github.com/huawei-csl/KVarN) (Huawei CSL, Apache-2.0) Hadamard rotation + iterative variance normalization (4-bit keys / 2-bit values per 128-token tile, ~840 B/token/layer).
  - Yields a **268,169-token pool** at `max-model-len=245760` within a pinned 5.26 GiB VRAM budget on the 24 GB RTX 3090.
- **CUDA Graph Modes**: `SPEC=dflash2 CTX=huge` runs `FULL_AND_PIECEWISE` across all 128 residues. `SPEC=mtp CTX=huge` falls back to `PIECEWISE`.

---

## 6. Measured Throughput (RTX 3090 @ 250W, `CTX=huge`, `SPEC=dflash2`, `KVarN k4v2`)

### Single-User Decode Throughput

| Variant / Workload | tok/s | Tokens / Step |
|---|---|---|
| Default Short Prompt (`DFLASH_TOKENS=7`, Lookup ON) | **130** | 3.3 |
| Code Generation & AST Mutation | **89** | 2.8 |
| File Edit & Patch Application | **65** | 2.4 |
| Document Reproduction (Verbatim Copy/Quote) | **259** | 3.3–7.8 |
| `DFLASH_TOKENS=15` Reproduction Mode | up to **381** | 3.4–15.0 |
| Six-Task Real-Prompt Suite Average | **53** | 3.0 |

> [!NOTE]
> Measured 2026-08-23 with `VLLM_DFLASH2_CHAIN=1`. Since `3522dc7` (2026-08-28) CHAIN is disabled
> (wedge mitigation): expect roughly these numbers minus ~7% on copy-heavy workloads, parity on prose.

### Prefill Throughput & TTFT

| Input Length | Prefill Speed | Single-Request TTFT |
|---|---|---|
| 1k tokens | ~1,740–1,810 tok/s | 0.56–0.85 s |
| 16k tokens | ~1,570–1,600 tok/s | 10.3–14.7 s |
| 100k tokens | ~1,000–1,050 tok/s | 103–129 s |
| **Prefix Cache Hit (Named Session Reuse)** | **~8,000–9,000 tok/s** | **< 0.5 s** |

---

## 7. SWE-rebench Benchmark Pipeline

To measure true generalization without contamination, the Goose + Qwen stack was evaluated against [SWE-rebench](https://swe-rebench.com/) (Nebius, `nebius/SWE-rebench-leaderboard`), using monthly issue splits post-dating training cutoffs (March 2026 split `2026_03`).

- **Resolved Rate (Best-of-1)**: **32.0% (16/50)** on uncurated fresh GitHub issues.
- **Attempted Resolution Rate**: **57.1% (16/28)** for issues completed within the 900s timeout budget.
- Full reproduction scripts, harness fixes (resolving Docker container paths in upstream `eval.py`), and per-issue breakdown are documented in [benchmarks/swe-rebench/README.md](benchmarks/swe-rebench/README.md) and [benchmarks/swe-rebench/results/results.md](benchmarks/swe-rebench/results/results.md).

---

## 8. Operational Quickstart

### Starting & Stopping Services

```powershell
# Start the standard huge-context model (245,760 context ceiling)
.\scripts\main\start_huge.bat

# Check running service status (vLLM on 18020, MCP wait on 18021)
.\scripts\status.bat

# Stop the main model
.\scripts\main\stop.bat
```

### Running Autonomous Optimization Loops (AVO)

```powershell
# Drive an iterative AVO optimization round on any target repository
python .\scripts\avo_runner.py --cwd "D:\path\to\target_repo" --metric "benchmark_score" --higher-is-better
```

---

## 9. Key References

- `~/.claude/CLAUDE.md` — Hierarchical NVIDIA AVO & Multi-Agent Protocol (global user memory, not tracked in this repo).
- [mcp-qwen/NOTES.md](mcp-qwen/NOTES.md) — Investigation history, architecture design records, and engineering changelog.
- [benchmarks/swe-rebench/](benchmarks/swe-rebench/) — Benchmark harness and evaluation results.
- [DFlash2: Non-Autoregressive Block Speculative Decoding](https://inco.ai/blog/dflash2/)
- [KVarN: Variance-Normalized 4/2-bit KV Cache](https://github.com/huawei-csl/KVarN)
