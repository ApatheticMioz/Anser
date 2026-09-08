# LLM_Ecosystem & Anser Harness

[![Release](https://img.shields.io/github/v/tag/ApatheticMioz/LLM_Ecosystem?label=release)](https://github.com/ApatheticMioz/LLM_Ecosystem/releases)
[![Test Gate: 26/26 Suites Green](https://img.shields.io/badge/Test%20Gate-26%2F26%20Suites%20Green-success.svg)](#10-testing--verification)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Windows%2011%20%7C%20WSL2%20Ubuntu-orange.svg)](https://learn.microsoft.com/en-us/windows/wsl/)
[![Hardware](https://img.shields.io/badge/GPU-RTX%203090%20%2F%204090%20(24GB)-76B900.svg)](#6-model-serving-speculative-decoding--quantization)
[![Context](https://img.shields.io/badge/Context-245%2C760%20Tokens-purple.svg)](#6-model-serving-speculative-decoding--quantization)
[![Serving](https://img.shields.io/badge/Engine-vLLM%20%2B%20DFlash2%20%2B%20KVarN-green.svg)](#6-model-serving-speculative-decoding--quantization)
[![Microkernel](https://img.shields.io/badge/Harness-Anser%20Zero--IPC-brightgreen.svg)](#3-why-anser-is-5x300x-faster-than-legacy-goose)
[![Security](https://img.shields.io/badge/Security-123%2F123%20Vectors%20Blocked%20(137%20Total)-success.svg)](#4-zero-risk-data-containment-the-5-layers-of-defense)
[![SWE-rebench](https://img.shields.io/badge/SWE--rebench-32.0%25%20Resolved-blueviolet.svg)](#8-swe-rebench-validation-benchmark)

**LLM_Ecosystem** is a production-grade, local-first multi-agent pair-programming infrastructure. High-reasoning orchestrators (**Claude 3.7 / 4.5 Sonnet**, **Claude Code**, or **Gemini 3.8 Flash** in Google Antigravity IDE) operate as the **Lead Architect & Meta-Supervisor**, while a locally-served **Qwen3.8-27B** (running on a single 24GB RTX 3090/4090 via vLLM + DFlash2 + KVarN @ 245K context) executes code exploration, structural AST manipulation, testing, and file editing for **$0 token cost**.

Execution is driven by the **Anser Agent Harness**—an in-process **Anser microkernel** combined with **Evo (Autonomous Variation & Optimization)** closed-loop evolutionary mechanics, delivering microsecond tool latency, zero-risk blast-radius sandboxing, bounded traceback repair, and atomic state rollback.

> [!IMPORTANT]
> **Legacy Goose Archival**: The legacy Goose CLI subprocess harness has been archived to branch [`archive/legacy-goose`](https://github.com/ApatheticMioz/LLM_Ecosystem/tree/archive/legacy-goose). The primary production runtime is the **Anser** in-process microkernel.

---

## Table of Contents

1. [System Architecture](#1-system-architecture)
2. [Repository Structure](#2-repository-structure)
3. [Why Anser is 5x–300x Faster Than Legacy Goose](#3-why-anser-is-5x300x-faster-than-legacy-goose)
4. [Zero-Risk Data Containment (The 5 Layers of Defense)](#4-zero-risk-data-containment-the-5-layers-of-defense)
5. [Consolidated MCP Tool Suite (`qwen38-local`)](#5-consolidated-mcp-tool-suite-qwen38-local)
6. [Model Serving, Speculative Decoding & Quantization](#6-model-serving-speculative-decoding--quantization)
7. [Measured Throughput & Benchmarks](#7-measured-throughput--benchmarks)
8. [SWE-rebench Validation Benchmark](#8-swe-rebench-validation-benchmark)
9. [Getting Started & Quickstart](#9-getting-started--quickstart)
   - [Prerequisites](#prerequisites)
   - [WSL2 Backend Setup](#wsl2-backend-setup)
   - [Windows Host Setup](#windows-host-setup)
   - [Client Configuration (Antigravity, Claude Code, Cursor)](#client-configuration)
10. [Testing & Verification](#10-testing--verification)
11. [Documentation & Engineering Audits](#11-documentation--engineering-audits)
12. [Upstream Version Tracking](#12-upstream-version-tracking)
13. [License & Acknowledgments](#13-license--acknowledgments)

---

## 1. System Architecture

```
User <───────────────────> Meta-Supervisor / Lead Architect
                           (Claude Sonnet in Claude Code / Gemini Flash in Antigravity)
                                        │
                                        │  MCP (stdio) - 3 Consolidated Tools:
                                        │  • qwen_coworker (prompt, session_id, cwd, extensions, evo)
                                        │  • qwen_task (status, cancel, list)
                                        │  • qwen_server (status, start, stop)
                                        ▼
             ┌─────────────────────────────────────────────────────────┐
             │  mcp-qwen/index.js (Modular Node.js MCP Server)         │
             │  ├── Sync Race Window (Claude: 45s, Antigravity: 150s)  │
             │  ├── Global Cross-Process Semaphore (MAX_CONCURRENT=1)  │
             │  ├── Native WSL / Windows DrvFs Path Translation        │
             │  └── Zero-Turn HTTP Wait Endpoint (127.0.0.1:18021)     │
             └─────────────────────────────────────────────────────────┘
                                        │
                                        ▼
             Anser Agent Harness (Embedded Microkernel)
             ├── In-process zero-IPC tool execution (0.01ms V8 function calls)
             ├── Structural AST surgery: @ast-grep/napi (ast_search, ast_replace)
             ├── Compile-check safety gates: syntax validated before disk commit
             ├── Traceback condenser: bounded <=100 token digests from raw stderr
             ├── Closed-loop evolutionary engine: lineage tracking (.evo/lineage.json)
             ├── 90-vector zero-trust sandboxed filesystem (C: & D: containment)
             └── Dynamic extensions: free-search-mcp, context7, gh CLI
                                        │
                                        │  Direct SSE Stream / OpenAI API (/v1/chat/completions)
                                        ▼
             vLLM Serving Engine (WSL Ubuntu @ port 18020)
             ├── Qwen3.8-27B (W4A16 AutoRound dense hybrid architecture)
             ├── DFlash2 1.92B Block Drafter (7 draft tokens per pass)
             ├── Lookup-Augmented Speculative Decoding (VLLM_DFLASH2_LOOKUP*)
             ├── KVarN k4v2 KV Cache (245,760 context window ceiling)
             └── Static prompt templates (100% prefix-cache reuse @ 8-9k tok/s)
                                        │
                                        ▼
             GeForce RTX 3090 / 4090 (24 GB VRAM @ 250W Power Cap)
```

---

## 2. Repository Structure

```
LLM_Ecosystem/
├── README.md                       # Master architecture & operational specification
├── CLAUDE.md                       # Protocol guidelines for Claude Code orchestrator
├── GEMINI.md                       # Protocol guidelines for Antigravity IDE orchestrator
│
├── docs/                           # Architecture specs, security reviews & audits
│   ├── README.md                   # Documentation index
│   └── audits/                     # Historical ledgers & adversarial audit reports
│       ├── AUDIT_2026-09-05.md     # Codebase & cross-platform drift audit
│       ├── ANSER_PROGRESS.md# Anser implementation history
│       ├── PATCHWORK_ADVERSARIAL_AUDIT_2026-09-05.md # Threat model & security review
│       └── QWEN_EVO_AUDIT.md       # Peer review & collaborative validation
│
├── mcp-qwen/                       # Anser MCP Server (Node.js)
│   ├── index.js                    # Server entry point exposing tools via stdio
│   ├── stream_proxy.js             # Universal SSE streaming proxy on port 18022
│   ├── package.json                # Dependencies (@modelcontextprotocol/sdk, @ast-grep/napi)
│   ├── update_schemas.py           # Synchronizes tool definitions into Antigravity IDE
│   ├── src/                        # Modular runtime implementation
│   │   ├── config.js               # Central configuration & timeout constants
│   │   ├── goose_runner.js         # Fallback legacy Goose subprocess runner
│   │   ├── evo_engine.js           # Lineage tracker for legacy runner
│   │   ├── semaphore.js            # Cross-process disk-lease lock (MAX_CONCURRENT=1)
│   │   ├── server_lifecycle.js     # vLLM launch, wedge detection & auto-healing
│   │   ├── task_registry.js        # Background task state persistence (~/.qwen/tasks/)
│   │   ├── tools.js                # Zod schemas & dispatch handlers
│   │   ├── wsl_bridge.js           # Dual-platform DrvFs path resolver & process tree killer
│   │   └── harness/                # Anser Core Runtime
│   │       ├── runner.js           # Main execution loop connecting vLLM & tools
│   │       ├── core/               # Anser microkernel (Context, Events, Plugins)
│   │       ├── services/           # Sandboxed FS, AST surgery, Shell executor, Logger
│   │       └── evo/                # Evolutionary operator, Evaluator, DAG, Trace repair
│   └── tests/                      # Automated Test & Validation Suite
│       ├── security.test.js        # 90-vector blast-radius containment audit
│       ├── canary.test.js          # AST search/replace, syntax gate, trace condenser
│       ├── evo.test.js             # Closed-loop evaluation & rollback integration
│       ├── semaphore.test.js       # Cross-process lease exclusion tests
│       ├── stream_proxy.test.js    # Multi-byte UTF-8 & mid-stream chunk tests
│       ├── utf8_proxy.test.js      # Unicode replacement & SSE transport verification
│       ├── fifo_queue.test.js      # MCP tool call serialization test
│       └── benchmark.test.js       # Head-to-head performance benchmark
│
├── scripts/                        # Automation scripts & server launchers
│   ├── status.bat                  # Unified service & GPU status checker (18020/18021)
│   ├── evo_runner.py               # Autonomous evolutionary optimization CLI
│   ├── main/                       # Production vLLM launchers (Windows batch)
│   │   ├── start.bat               # Default launcher -> start_huge.bat
│   │   ├── start_huge.bat          # 245K context launcher (DFlash2 + KVarN k4v2)
│   │   ├── start_fast.bat          # 57K fast context launcher (fp8 KV cache)
│   │   └── stop.bat                # Graceful service shutdown
│   ├── uncensored/                 # Academic / research GGUF model launchers
│   └── wsl/                        # WSL bash scripts invoked by Windows batch files
│       ├── setup_links.sh          # One-step symlink & MCP environment config
│       ├── start_huge.sh           # vLLM huge-context background launcher
│       ├── start_fast.sh           # vLLM fast-context background launcher
│       ├── status.sh               # Health check, silence detector & GPU telemetry
│       └── stop_server.sh          # Clean process-tree termination
│
├── benchmarks/                     # Quantitative generalization benchmarks
│   ├── swe-rebench/                # Docker-graded SWE-rebench pipeline (March 2026 split)
│   └── wedge-repro/                # Upstream vLLM engine-core wedge reproduction & fix
│
└── llama-cpp/                      # Native Windows CUDA build of llama.cpp (b10566+)
```

---

## 3. Why Anser is 5x–300x Faster Than Legacy Goose

| Metric / Dimension | Legacy Goose (Rust CLI Subprocess) | Anser (In-Process Microkernel) | Architectural Root Cause |
|---|---|---|---|
| **Per-Tool IPC Overhead** | 200–500ms per tool action | **0.01ms** | Anser executes tools as direct V8 function calls inside the MCP memory space, eliminating process spawning. |
| **Directory Traversal** | 1,500–12,000ms per operation | **5–40ms** (5x–300x faster) | Ripgrep-powered ignore engine automatically prunes `.venv`, `node_modules`, and caches from file searches. |
| **Time to First Token (TTFT)** | 35,000–60,000ms | **190–2,335ms** | Direct HTTP/1.1 persistent SSE stream with proactive TCP keep-alive pings (`: keep-alive\n\n`). |
| **State Persistence** | SQLite `sessions.db` write locks | **Atomic append-only JSONL** | Zero database locks, instant session branching, and non-blocking background streaming. |
| **Speculative Decoding Speed** | ~40–60 tok/s | **95–130 tok/s** | Static, deterministic prompt structures ensure 100% prefix-cache hit rate on vLLM. |
| **Rollback & Recovery** | N/A (Manual git revert, blind overwrites) | **10,460 snapshot ops/s** | In-memory byte-level snapshotting restores pristine disk state instantaneously upon test regression. |

---

## 4. Zero-Risk Data Containment (The 5 Layers of Defense)

To ensure that neither Qwen nor any autonomous agent can damage files outside the project root (`D:\LLM_Ecosystem` or `/mnt/d/LLM_Ecosystem`), the harness enforces a 5-layer defence-in-depth security model:

```
[Agent Request] 
      │
      ▼
Layer 1: Synchronous PathEscape Normalizer ──> Blocks traversal (../../), C:\, /mnt/c, null-bytes, CON/PRN/AUX
      │
      ▼
Layer 2: Symlink Realpath Containment    ──> Resolves fs.realpathSync; blocks links escaping the workspace
      │
      ▼
Layer 3: Workspace Root Overwrite Guard  ──> Blocks directory deletion or root overwrite
      │
      ▼
Layer 4: Dangerous Shell Filter          ──> Blocks rm -rf /, format C:, del /s C:\, mkfs, dd, fork bombs
      │
      ▼
Layer 5: AST Syntax Gate & Evo Rollback  ──> Validates code via node --check / py_compile before saving;
      │                                       instant byte-for-byte revert on test failure
      ▼
[Safe Disk Operation]
```

1. **Layer 1: Synchronous Path Escape Rejection**: Every file path passed to `readFile`, `writeFile`, `editFile`, `ast_search`, or `ast_replace` is normalized across Windows and WSL DrvFs. Traversal attempts (`../../`), absolute drive targets (`C:\`, `/mnt/c/`), null-byte injections (`\0`), and Windows reserved device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1-9`, `LPT1-9`) throw `PathEscapeError` synchronously.
2. **Layer 2: Symlink Realpath Containment**: The harness invokes `fs.realpathSync()` on existing targets and walks parent chains on new files. Any symlink resolving outside the workspace throws `SymlinkEscapeError`.
3. **Layer 3: Workspace Root Overwrite Guard**: Attempts to delete or overwrite the workspace root or parent drive roots throw `InvalidPathError`.
4. **Layer 4: Dangerous Shell Command Blocking**: The shell executor inspects commands against regex patterns prohibiting catastrophic system destruction (`rm -rf /`, `format C:`, `del /s /q C:\`, `mkfs`, fork bombs). Working directories are validated against the workspace root before spawning.
5. **Layer 5: AST Syntax-Validation Gates & Deterministic Rollback**: Structural replacements via `ast_replace` are checked in memory (`node --check` for JS, `py_compile` for Python) before disk commit. Malformed code is rejected immediately with `SyntaxValidationError`. In Evo mode, workspace snapshots revert regressions with 100% fidelity.

> [!TIP]
> **Empirical Security Verification**: This model is verified by `npm run test:security`, passing **90/90 attack vectors blocked** across both Windows 11 and WSL2 Ubuntu.

---

## 5. Consolidated MCP Tool Suite (`qwen38-local`)

The server exposes 3 consolidated tools to the orchestrator:

### `qwen_coworker`
Primary agentic interface for multi-turn pair-programming, exploration, code editing, and evolutionary optimization.
- **`prompt`** *(string, required)*: Specific task instructions for Qwen.
- **`session_id`** *(string, optional)*: Milestone session identifier (e.g. `"myrepo_phase1"`). Reuses warm KV prefix cache.
- **`cwd`** *(string, optional)*: Target directory (Windows or POSIX path).
- **`extensions`** *(string[], optional)*: Dynamic tool extensions (e.g. `["uvx free-search-mcp"]`, `["npx -y @upstash/context7-mcp"]`).
- **`hypothesis`** *(string, optional)*: Evo hypothesis description for candidate mutation.
- **`test_command`** *(string, optional)*: Verification command executed by the closed-loop evaluator.
- **`metric_name`** *(string, optional)*: Optimization metric extracted from evaluation output.
- **`higher_is_better`** *(boolean, optional)*: Optimization objective direction (default: `true`).
- **`timeout_ms`** *(number, optional)*: Execution timeout budget (default: 4 hours / 14,400,000ms).

#### Execution & Long-Poll Wait Contract
- **Fast Tasks (< 45s / 150s)**: Completes within the synchronous race window and returns the complete deliverable directly in Turn 1.
- **Long Tasks (>= 45s / 150s)**: Yields a durable `taskId` and a `wait_command`:
  ```bash
  curl -s http://127.0.0.1:18021/task/<id>/wait
  ```
  The orchestrator executes this command as an OS-level background task, blocking at **$0 token cost** until automatically notified on completion.

### `qwen_task`
Inspects, manages, and terminates background coworker tasks across memory and disk (`~/.qwen/tasks/`).
- **`action`** *(enum: `"status"` | `"cancel"` | `"list"`, required)*.
- **`task_id`** *(string, optional)*: Unique identifier of the target task.

### `qwen_server`
Controls the 245K vLLM server instance with automated engine-core wedge detection.
- **`action`** *(enum: `"status"` | `"start"` | `"stop"`, required)*.
- **Wedge Detection & Auto-Healing**: Verifies that the engine is not merely answering HTTP pings, but actively scheduling tokens. If the vLLM engine log remains silent for >120s while the port is open, it automatically triggers clean process termination and relaunch.

---

## 6. Model Serving, Speculative Decoding & Quantization

The serving backend runs inside WSL2 Ubuntu at `~/qwen-serving` (forked from [syv-ai/qwen38-27b-rtx3090](https://github.com/syv-ai/qwen38-27b-rtx3090)):

- **Base Architecture**: Qwen3.8-27B (hybrid dense architecture: Gated-DeltaNet + linear/standard attention, 65 layers, MoE-free).
- **Weight Quantization**: W4A16 AutoRound with `--language-model-only` (vision encoder excluded, saving 2.7 GB VRAM).
- **Quantized Head & Embeddings**:
  - `quant_lm_head.py`: 248k-row `lm_head` (2.5 GB bf16) $\to$ int8 group-128 in place (saves ~1.3 GB).
  - `quant_embed.py`: Untied `embed_tokens` matrix $\to$ int8 group-128 (saves ~1.3 GB).
- **DFlash2 Block Speculative Drafter (`SPEC=dflash2`, Default)**:
  - 1.92B parameter, 5-layer non-autoregressive block drafter predicting 7 tokens per pass from target layers 5/19/33/47/61 with a 16-candidate path selector, quantized to ~1.0 GB (`quant_dflash2.py`).
  - Lookup-Augmented Speculation (`VLLM_DFLASH2_LOOKUP*`) enables continuous n-gram continuations from context at up to 381 tok/s.
- **KVarN KV Cache (`CTX=huge`)**:
  - [KVarN](https://github.com/huawei-csl/KVarN) (Huawei CSL, Apache-2.0) Hadamard rotation + iterative variance normalization (4-bit keys / 2-bit values per 128-token tile, ~840 B/token/layer).
  - Yields a **268,169-token pool** at `max-model-len=245760` within a pinned 5.26 GiB VRAM budget on the 24 GB RTX 3090.

---

## 7. Measured Throughput & Benchmarks

*Hardware: Single GeForce RTX 3090 24GB @ 250W Power Cap, `CTX=huge`, `SPEC=dflash2`, `KVarN k4v2`.*

### Single-User Generation Speed

| Workload / Scenario | tok/s | Tokens / Step |
|---|---|---|
| Default Short Prompt (`DFLASH_TOKENS=7`, Lookup ON) | **130** | 3.3 |
| Code Generation & AST Mutation | **89** | 2.8 |
| File Edit & Patch Application | **65** | 2.4 |
| Document Reproduction (Verbatim Copy/Quote) | **259** | 3.3–7.8 |
| `DFLASH_TOKENS=15` Reproduction Mode | up to **381** | 3.4–15.0 |
| Six-Task Real-Prompt Suite Average | **53** | 3.0 |

### Prefill Throughput & Time-to-First-Token (TTFT)

| Context Length | Prefill Speed | TTFT |
|---|---|---|
| 1,000 tokens | ~1,740–1,810 tok/s | 0.56–0.85 s |
| 16,000 tokens | ~1,570–1,600 tok/s | 10.3–14.7 s |
| 100,000 tokens | ~1,000–1,050 tok/s | 103–129 s |
| **Prefix Cache Hit (Same `session_id`)** | **~8,000–9,000 tok/s** | **< 0.5 s** |

### 11-Hour Multi-Agent Production Marathon Telemetry (v5.1.0 Validation)

In an unbroken 11.25-hour autonomous pairing session across Gemini 3.8 Flash (Antigravity Meta-Supervisor), GLM-5.3-Flash / Claude Code (Lead Architect), and Qwen3.8-27B (Anser Coworker), the stack delivered the following production metrics:

| Production Telemetry Dimension | Empirical Measurement | Operational Value |
|---|---|---|
| **Cumulative Prefill Volume** | **56,312,194 tokens** | Processed locally on RTX 3090 at **$0 token cost** |
| **Cumulative Generation Volume** | **1,749,192 tokens** | Multi-pass codebase refactoring & structural AST surgery |
| **Empirical Prefill Throughput** | **9,454.3 tok/s** | Average across 56.3M prompt tokens (warm prefix-cache hits reaching 8,000–9,500+ tok/s; cold prefill 1,000–1,810 tok/s) |
| **Empirical Generation (Decode) Speed** | **58.2 tok/s** | Sustained pure decode throughput (1.75M tokens / 30,077s; mean TPOT 15.42 ms $\to$ **64.9 tok/s** instantaneous) |
| **Effective End-to-End Turn Speed** | **48.5 tok/s** | Round-trip throughput across all conversation turns including prefill & tool-call handling |
| **Speculative Accepted Tokens** | **1,379,412 tokens** | **78.86% acceptance rate** on DFlash2 1.92B non-autoregressive drafter |
| **Active Micro-Sessions Completed** | **134 sessions** | Micro-session roll cadence preventing KV cache decay |
| **Microkernel Lifecycle Events** | **6,140+ events** | Append-only event telemetry logged in `~/.qwen/sessions/` |
| **Total Tool Invocations** | **1,939+ calls** | Autonomous execution across Windows and WSL environments |
| **Hardware VRAM Footprint** | **24,136 MiB / 24,576 MiB** | Universal 245K context + KVarN k4v2 cache |
| **Operating Temperatures** | **31°C - 58°C** | Steady thermal curve under 250W power cap |
| **Zero-Turn OS Wait Savings** | **~590M tokens** | Zero-turn HTTP long-poll (`:18021`) eliminated polling tax |
| **Test Gate Verification** | **26/26 Suites Green** | 100% exit 0 under `npm run test:all` (zero skips) |

### 13-Hour Autonomous Production Marathon Telemetry (v5.2.0 End-to-End Overhaul — Sept 7, 2026)

In an unbroken 13.1-hour autonomous pairing session driving the full 6-phase UI overhaul of `enterprise-app` across Claude Code (GLM-5.3 / GLM-5.3-Flash) and local Qwen3.8-27B (Anser Coworker on RTX 3090), the stack delivered the following production metrics:

| Production Telemetry Dimension | Empirical Measurement | Operational Value |
|---|---|---|
| **Cumulative Prefill Volume** | **73,317,306 tokens** (~73.3M) | Absorbed large multi-file ASTs & git diffs locally at **$0 token cost** |
| **Prefix Cache Hit Rate** | **93.80% (68,842,624 tokens)** | Sustained warm prefix cache throughput (~8,000–9,500 tok/s) |
| **Cumulative Generation Volume** | **1,490,578 tokens** (~1.49M) | Full test-time reasoning and code generation delivered at $0 |
| **DFlash2 Speculative Decoding** | **53.45% draft acceptance** | 1,176,978 accepted / 2,202,011 drafted across 7 draft positions |
| **Total Engine Requests** | **883 requests** | 882 `stop`, 1 `length`, **0 error, 0 abort, 0 repetition** |
| **Orchestrator Token Volume** | **53,081,643 tokens** (~53.1M) | 11.08M input, 341.8K output, 41.66M cache read |
| **Orchestrator Tool Calls** | **245 calls** | 38 Qwen coworker dispatches, 38 zero-turn curl waits, 21 PowerShell |
| **MCP Process Stability (PID 16912)** | **80.59 MB RSS, 0 crashes** | Zero memory growth or socket leaks over 13 hours continuous uptime |
| **Zero-Turn OS Wait Savings** | **~650M tokens saved** | 38 background blocking curl tasks eliminated supervisor polling tax |
| **Shipped Production Deliverables** | **6 UI Overhaul Phases** | Commits `d2383c6` $\to$ `9869945`, paying down 10 lint errors (76 baseline) |

#### Empirical Operational Friction Analysis & Resolution (4+ Incidents Audited)
Detailed audit of the transcripts reveals **6 critical operational friction modes** encountered across the marathon:
1. **`engine_empty_response` Stream Cutoff** (`06:19 UTC`): Phase 0 review final response cut off after 32 tool calls; recovered by resuming the warm session with a compact verdict-only directive. Fixed in `runner.js` via honest retry classification.
2. **`curl (56) Connection reset by peer`** (`06:53 UTC`): Wait endpoint dropped connection under concurrent SSE load; recovered by verifying task liveness and adding `--retry-all-errors`. Hardened in `tools.js` and `task_registry.js`.
3. **Universal 245K Context Ceiling Overflow** (`09:46 UTC`): Multi-turn accumulation of 900+ LOC files filled the 245K context; recovered by rolling session ID to `ui_ovh_p2_b`. Codified in micro-session roll protocol.
4. **vLLM Stream Idle Watchdog (900s) & 4 Stalled Intervals** (`17:11 UTC`): Monolithic review prompt reading 1,000+ LOC and multiple diffs caused extended prefill/deliberation that tripped the 15-min idle watchdog after Claude waited through 3 consecutive 10-minute task timeouts (30 min total); recovered by compacting prompt to targeted greps which passed in 197.9s.
5. **vLLM JSON Serialization Glitch / Malformed Wake Payload** (`13:15 UTC`): `Unterminated string` masked by stream proxy with HTTP 200 and exit code 0 (`isError=false`); resolved by enforcing Rule 8 (Fail-Fast, zero error masking).
6. **Report Generation Stream Cutoff** (`14:46 UTC`): Output stream truncated mid-sentence due to output token ceiling exhaustion; resolved by decoupling reasoning tokens via `QWEN_MAX_REASONING_TOKENS=32768`.

*Complete raw logs, Prometheus dumps, GPU telemetry, and parsed metrics are preserved in [`benchmarks/sessions/session_20260907/`](benchmarks/sessions/session_20260907/).*

---

## 8. SWE-rebench Validation Benchmark

To evaluate real-world software engineering generalization without data contamination, the stack was benchmarked against [SWE-rebench](https://swe-rebench.com/) (Nebius, `nebius/SWE-rebench-leaderboard`), using fresh GitHub issues created after model training cutoffs (March 2026 split):

- **Resolved Rate (Best-of-1)**: **32.0% (16/50)** on uncurated fresh GitHub issues.
- **Attempted Resolution Rate**: **57.1% (16/28)** for issues completed within the 900s timeout budget.
- Full reproduction scripts and grading reports are documented in [benchmarks/swe-rebench/README.md](benchmarks/swe-rebench/README.md).

---

## 9. Getting Started & Quickstart

### Prerequisites

- **Host OS**: Windows 11 (build 22621+) with WSL2 enabled.
- **WSL Distribution**: Ubuntu 22.04 LTS or Ubuntu 24.04 LTS.
- **GPU**: GPU with $\ge 24\text{ GB}$ VRAM (GeForce RTX 3090, 4090, RTX 6000 Ada, or A100/H100).
- **Host Tools**: Node.js $\ge 18.0.0$, Python $\ge 3.10$, Git.
- **WSL Tools**: CUDA Container Toolkit / CUDA 12.4+, Python 3.11/3.12, Node.js 18+.

### WSL2 Backend Setup

1. Inside WSL2, clone the model serving repository:
   ```bash
   git clone https://github.com/syv-ai/qwen38-27b-rtx3090.git ~/qwen-serving
   cd ~/qwen-serving
   # Follow ~/qwen-serving/README.md for venv setup and weight download
   ```
2. Initialize launcher symlinks from the workspace:
   ```bash
   bash /mnt/d/LLM_Ecosystem/scripts/wsl/setup_links.sh
   ```

### Windows Host Setup

1. Install Node.js dependencies in the MCP server:
   ```powershell
   cd D:\LLM_Ecosystem\mcp-qwen
   npm install
   ```
2. Start the local vLLM serving stack:
   ```powershell
   .\scripts\main\start_huge.bat
   ```
3. Verify GPU and port status:
   ```powershell
   .\scripts\status.bat
   ```

### Client Configuration

#### 1. Google Antigravity IDE
Add the following to `~/.gemini/config/mcp_config.json` (or your project's `.agents/mcp.json`):
```json
{
  "mcpServers": {
    "qwen38-local": {
      "command": "node",
      "args": ["D:/LLM_Ecosystem/mcp-qwen/index.js"],
      "env": {
        "QWEN_RACE_MS": "150000"
      }
    }
  }
}
```
Run `python mcp-qwen/update_schemas.py` to populate tool schemas and supervisory instructions.

#### 2. Anthropic Claude Code
Register via CLI:
```bash
claude mcp add --scope user qwen-anser node D:/LLM_Ecosystem/mcp-qwen/index.js
```
Or add to `~/.claude.json`:
```json
{
  "mcpServers": {
    "qwen38-local": {
      "command": "node",
      "args": ["D:/LLM_Ecosystem/mcp-qwen/index.js"],
      "env": {
        "QWEN_RACE_MS": "45000"
      }
    }
  }
}
```

#### 3. Cursor / Windsurf / VSCode
Add to Cursor MCP Settings (`mcp.json`):
```json
{
  "mcpServers": {
    "qwen38-local": {
      "command": "node",
      "args": ["D:/LLM_Ecosystem/mcp-qwen/index.js"]
    }
  }
}
```

---


### Environment Variables

The MCP server exposes the following environment-variable knobs (all defined in `mcp-qwen/src/config.js`):

| Variable | Default | Meaning |
|---|---|---|
| `QWEN_RACE_MS` | `45000` | Synchronous race window (ms) before yielding to the zero-turn long-poll wait. |
| `QWEN_MAX_CONCURRENT` | `1` | Maximum concurrent execution slots (cross-process semaphore). |
| `QWEN_STATE_DIR` | `~/.qwen` (or `/mnt/c/Users/<user>/.qwen` on WSL) | Root directory for task state, slot leases, and Evo lineage. |
| `QWEN_MIN_TIMEOUT_MS` | `600000` (10 min) | Minimum per-task timeout budget (ms). |
| `QWEN_INACTIVITY_TIMEOUT_MS` | `1800000` (30 min) | Inactivity timeout: kill task if no tool activity for this duration. |
| `QWEN_FIRST_TOKEN_TIMEOUT_MS` | `240000` (4 min) | Timeout for first token from vLLM after request dispatch. |
| `QWEN_MAX_TURNS` | *(unset / unbounded)* | Hard cap on agent turns per task (null = orchestrator-governed). |
| `QWEN_WEDGE_SILENCE_S` | `120` | Seconds of engine-log silence before wedge detection triggers auto-heal. |
| `QWEN_AUTO_HEAL` | `true` (disable with `0`) | Enable automatic vLLM process kill & relaunch on detected engine wedge. |
| `QWEN_LOG_PATH` | `/tmp/mcp_launch_huge.log` | Path to the vLLM engine log used for wedge silence monitoring. |
| `VLLM_PORT` | `18020` | Port for the vLLM OpenAI-compatible API endpoint. |
| `STATUS_PORT` | `18021` | Port for the zero-turn long-poll HTTP status/wait server. |
| `STREAM_PROXY_PORT` | `18022` | Port for the universal SSE streaming proxy. |

## 10. Testing & Verification

The repository includes a comprehensive 26-suite test gate covering zero-trust containment, POSIX routing, syntax validation, live SSE streaming, and process reaping:

```powershell
cd D:\LLM_Ecosystem\mcp-qwen

# Run 23 offline suites (Security + AST + Syntax + Reaping + Schema Parity)
npm test

# Run all 26 suites including live-engine benchmarks and proxy checks
npm run test:all

# Run individual targeted suites:
npm run test:security    # 137-vector containment (123 attack vectors blocked, 14 allow vectors)
npm run test:canary      # AST search, syntax gates, traceback condenser, Evo eval
npm run test:evo         # Closed-loop evaluation & snapshot rollback (live engine)
npm run test:semaphore   # Cross-process lease exclusion tests (private state dir)
npm run test:proxy       # Universal UTF-8 streaming proxy & repetition breaker
npm run test:syntax      # Pre-commit syntax gates across JS, TS, Python, Go, Rust, JSON
npm run test:schema_parity # Antigravity JSON vs live zod schema drift lock
```

All test suites enforce the **Universal UNIX LF (`\n`) Invariant (Rule 7)**: any CRLF mismatch trips `LineEndingMismatchError` as an immediate dead-man fuse. All test suites run identically on both **Windows 11** and **WSL2 Ubuntu**.

---

## 11. Documentation & Engineering Audits

Detailed design decisions, threat models, and architectural evaluations are indexed in [`docs/README.md`](docs/README.md):

- [mcp-qwen Incident-Derived Design Specification](mcp-qwen/docs/DESIGN.md) (L1–L17 architectural post-mortems)
- [mcp-qwen Production Specification](mcp-qwen/README.md)
- [Repository & Configuration Drift Audit](docs/audits/AUDIT_2026-09-05.md)
- [Anser Implementation & Progress Ledger](docs/audits/ANSER_PROGRESS.md)
- [Patchwork Adversarial Security Audit](docs/audits/PATCHWORK_ADVERSARIAL_AUDIT_2026-09-05.md)
- [Qwen-Evo Collaborative Peer Audit](docs/audits/QWEN_EVO_AUDIT.md)
- [Engineering Notes & Delegation History](docs/archive/DEVELOPMENT_NOTES_2026.md)

---

## 12. Upstream Version Tracking

| Component | Local Tree / Commit | Upstream Project | Upstream Status |
|---|---|---|---|
| **vLLM Serving (`~/qwen-serving`)** | `69ba4d0` (Git tree) / `2ae239f` (Active venv) | [`syv-ai/qwen38-27b-rtx3090`](https://github.com/syv-ai/qwen38-27b-rtx3090) | Synced to `origin/main` |
| **llama.cpp Windows (`llama-cpp/`)** | `bb4caa754` (Build 10566, Clang 20.1.8) | [`ggerganov/llama.cpp`](https://github.com/ggerganov/llama.cpp) | Official Releases (`b10566+`) |
| **Model Context Protocol SDK** | `^1.30.0` | [`modelcontextprotocol/typescript-sdk`](https://github.com/modelcontextprotocol/typescript-sdk) | SOTA Spec |
| **AST Grep Engine** | `^0.45.3` | [`ast-grep/ast-grep`](https://github.com/ast-grep/ast-grep) | Dual-platform native NAPI |

---

## 13. License & Acknowledgments

This project is licensed under the [MIT License](LICENSE).

### Acknowledgments
- **Qwen Team (Alibaba Cloud)** for Qwen3.8-27B.
- **vLLM Project** for high-throughput LLM serving.
- **Huawei CSL** for the [KVarN](https://github.com/huawei-csl/KVarN) variance-normalized KV cache.
- **Inco AI** for the [DFlash2](https://inco.ai/blog/dflash2/) non-autoregressive block drafter architecture.
- **Herrington Darkholme & contributors** for [ast-grep](https://github.com/ast-grep/ast-grep).
- **Anser & Evo** for microkernel patterns and closed-loop evolutionary optimization principles.
