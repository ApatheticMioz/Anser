# Anser

**The Universal 245K Agent Microkernel for Local LLMs.**

[![CI](https://github.com/ApatheticMioz/Anser/actions/workflows/ci.yml/badge.svg)](https://github.com/ApatheticMioz/Anser/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/Node-20%20%7C%2022-3C873A?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Test Gate: 36/36](https://img.shields.io/badge/Test%20Gate-36%2F36%20Suites%20Green-success.svg)](#testing--verification)
[![Context](https://img.shields.io/badge/Context-245%2C760%20Tokens-purple.svg)](#model-serving--speculative-decoding)
[![Serving](https://img.shields.io/badge/Engine-vLLM%20%2B%20DFlash2%20%2B%20KVarN-green.svg)](#model-serving--speculative-decoding)
[![Security](https://img.shields.io/badge/Security-137%2F137%20Vectors%20Contained-success.svg)](#zero-trust-sandboxed-file-operations)
[![SWE-rebench](https://img.shields.io/badge/SWE--rebench-32.0%25%20Resolved-blueviolet.svg)](#swe-rebench-validation-benchmark)

> **Anser** lets a high-reasoning cloud orchestrator (the *Lead Architect*)
> drive a **locally-served Qwen3.8-27B** — 245K context on a single 24 GB GPU,
> speculative decoding, **$0 token cost** — to explore, edit, and test code
> inside a zero-trust sandbox. No cloud token hoarding. No per-token bill.
> Your code never leaves your machine.

---

## Table of Contents

1. [The Core Problem](#the-core-problem)
2. [System Architecture](#system-architecture)
3. [Key Features](#key-features)
4. [Quickstart (3 Steps)](#quickstart-3-steps)
5. [Model Serving, Speculative Decoding & Quantization](#model-serving--speculative-decoding)
6. [Production Marathon Telemetry (11h & 13h Runs)](#production-marathon-telemetry)
7. [SWE-rebench Validation Benchmark](#swe-rebench-validation-benchmark)
8. [Zero-Trust Sandboxed File Operations](#zero-trust-sandboxed-file-operations)
9. [Testing & Verification](#testing--verification)
10. [Repository Structure](#repository-structure)
11. [Contributing](#contributing)
12. [License & Acknowledgments](#license--acknowledgments)

---

## The Core Problem

**Why did we build Anser?**

The dominant pattern for agentic coding is *cloud token hoarding*: a powerful
orchestrator (Claude, Gemini) reads entire repositories into a paid cloud
context, pays per token, and ships your source code to a datacenter. Three
problems follow:

1. **Cost.** Bulk-reading a large codebase into a frontier model is expensive
   per task, and it compounds across a long autonomous session.
2. **Privacy.** Your source, secrets, and machine identity transit a third
   party.
3. **Latency & ceiling.** Cloud round-trips and context windows cap how much
   you can do in one shot.

**Anser inverts the model.** A high-reasoning *Lead Architect* (Claude /
Gemini, in the cloud or in Antigravity) does the thinking and planning, while
a **local Qwen3.8-27B** — 245K context, served on a single 24 GB GPU via
vLLM + DFlash2 + KVarN — does the *hands-on* work: exploration, structural AST
surgery, testing, and file editing. The local model runs at **$0 token cost**,
so the orchestrator can offload arbitrarily large, repetitive, token-hungry
work to it without a bill. Your code stays on your machine.

> **The one-line pitch:** *Cloud brain, local hands, zero token cost, 245K
> context, zero-trust sandbox.*

---

## System Architecture

```
Lead Architect (cloud: Claude / Gemini / Antigravity)
        |
        |  MCP over stdio - 3 consolidated tools:
        |    qwen_coworker  (prompt, session_id, cwd, extensions, evo)
        |    qwen_task      (status, cancel, list)
        |    qwen_server    (status, start, stop)
        v
mcp-qwen/  (Node.js MCP server + Anser microkernel)
  - In-process zero-IPC tool execution (0.01 ms V8 calls)
  - Structural AST surgery: @ast-grep/napi (ast_search / ast_replace)
  - Compile-check safety gates (syntax validated before disk commit)
  - Bounded traceback condenser (<= 100-token failure digests)
  - Zero-turn HTTP wait endpoint (127.0.0.1:18021)
  - 5-layer zero-trust sandboxed filesystem
  - Closed-loop evolutionary engine (.evo/lineage.json)
        |
        |  Direct SSE stream / OpenAI API (/v1/chat/completions)
        v
vLLM serving engine (WSL2 / Linux, :18020)
  - Qwen3.8-27B (W4A16 AutoRound, --language-model-only)
  - DFlash2 1.92B block drafter (7 draft tokens/pass)
  - KVarN k4v2 KV cache (245,760-token ceiling)
  - Static prompt templates (100% prefix-cache reuse)
        |
        v
GeForce RTX 3090 / 4090 (24 GB VRAM)
```

**The split is the point.** The Lead Architect never bulk-reads source into
cloud context; it dispatches *focused, single-concern* tasks to the local
Coworker, which returns raw ground-truth facts. Long tasks yield a durable
`taskId` + a zero-turn `curl` wait, so the orchestrator blocks at **$0**
instead of polling.

---

## Key Features

- **Zero-Turn Reactive Wait (`/task/<id>/wait`).** Long tasks return a
  `wait_command` (`curl -s http://127.0.0.1:18021/task/<id>/wait`). The
  orchestrator runs it as an OS-level background process that blocks at
  **$0 token cost** and wakes on completion — eliminating the polling tax
  (measured ~590M–650M tokens saved per marathon).
- **Zero-Trust Sandboxed File Ops.** Every `read_file` / `write_file` /
  `edit_file` / `apply_patch` / `search_code` / `ast_*` call is normalized and
  contained by a **5-layer defense** (PathEscape -> Symlink Realpath ->
  Root-Overwrite Guard -> Dangerous-Shell Filter -> AST Syntax Gate + Evo
  Rollback). Verified by a **137-vector** containment suite.
- **Stdio-Pure MCP Bridge.** A clean stdio MCP server exposing exactly three
  consolidated tools; no stray stdout, no side channels. Remote MCP extensions
  (`free-search-mcp`, `context7`, `gh`) mount as `ext_<server>_<tool>`.
- **Structural AST Surgery with Compile-Check Gates.** `ast_search` /
  `ast_replace` / `ast_replace_batch` via `@ast-grep/napi`; rewrites are
  syntax-validated in memory before disk commit, so a bad edit is rejected and
  the file stays pristine.
- **Stale-Lock Recovery.** The cross-process slot lease uses `O_EXCL` disk
  locks with rename-to-tombstone recovery; a dead owner's lease is reclaimed,
  a live owner's is never stolen.
- **Engine Wedge Detection + Auto-Heal.** The harness verifies vLLM is
  *scheduling tokens*, not just answering pings; a silent engine (>120 s)
  triggers a clean kill + relaunch.
- **Closed-Loop Evolution (Evo).** `evo_propose/evaluate/select/revert`
  snapshot files, run a verification command, and roll back deterministically
  on regression — a lineage DAG in `.evo/lineage.json`.

---

## Quickstart (3 Steps)

No hardcoded paths. `<repo>` is wherever you cloned. **No GPU required** for
steps 1–2 (the test gate runs offline).

**1. Clone & install**
```bash
git clone https://github.com/ApatheticMioz/Anser.git
cd Anser/mcp-qwen
npm ci
```

**2. Verify the test gate (offline, no GPU)**
```bash
npm run test:all          # 36 suites; the 4 live suites skip honestly
# or, to force the live suites to skip on a GPU-less box:
TEST_OFFLINE=1 npm run test:all
```

**3. Register the MCP server with your orchestrator**
```bash
# Claude Code
claude mcp add --scope user qwen-anser node <repo>/mcp-qwen/index.js

# Google Antigravity IDE (generate tool schemas into the IDE's MCP dir)
python <repo>/mcp-qwen/update_schemas.py
```

**Optional — run the live model.** To actually drive Qwen (not just test the
harness), stand up a vLLM serving of Qwen3.8-27B on `:18020` per
[Model Serving](#model-serving--speculative-decoding). The MCP server boots the
engine on first dispatch (up to 180 s) and starts the stream proxy on `:18022`.

> **Prereqs:** Node 20+ and Git. For the live stack: a >= 24 GB GPU, WSL2 or
> Linux, CUDA 12.4+. See [Contributing](#contributing) for the full setup.

---

## Model Serving & Speculative Decoding

The serving backend (a fork of a community Qwen3.8-27B vLLM setup) runs in
WSL2 / Linux and is **optional** for contributors — the harness and its full
test gate work without it.

- **Base:** Qwen3.8-27B, hybrid dense (Gated-DeltaNet + attention), 65 layers,
  MoE-free.
- **Quantization:** W4A16 AutoRound, `--language-model-only` (vision encoder
  excluded, saving ~2.7 GB VRAM); `lm_head` and `embed_tokens` quantized to
  int8 group-128.
- **Speculative decoding:** DFlash2 1.92B non-autoregressive block drafter
  (7 tokens/pass) with lookup-augmented n-gram continuation.
- **KV cache:** KVarN (Huawei CSL, Apache-2.0) 4-bit keys / 2-bit values per
  128-token tile, yielding a **245,760-token** ceiling within a pinned VRAM
  budget on a 24 GB card.

Measured single-user decode: ~130 tok/s (short), ~89 (code), up to ~381
(reproduction mode); prefix-cache hits ~8,000–9,000 tok/s. Full telemetry in
[`benchmarks/`](benchmarks/).

---

## Production Marathon Telemetry

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
| **Test Gate Verification** | **36/36 Suites Green** | 100% exit 0 under `npm run test:all` (zero skips) |

---

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

#### Empirical Operational Friction Analysis & Resolution (6 Critical Modes Audited)
Detailed audit of the transcripts reveals **6 critical operational friction modes** encountered and hardened across the marathon:
1. **`engine_empty_response` Stream Cutoff** (`06:19 UTC`): Phase 0 review final response cut off after 32 tool calls; recovered by resuming the warm session with a compact verdict-only directive. Fixed in `runner.js` via honest retry classification.
2. **`curl (56) Connection reset by peer`** (`06:53 UTC`): Wait endpoint dropped connection under concurrent SSE load; recovered by verifying task liveness and adding `--retry-all-errors`. Hardened in `tools.js` and `task_registry.js`.
3. **Universal 245K Context Ceiling Overflow** (`09:46 UTC`): Multi-turn accumulation of 900+ LOC files filled the 245K context; recovered by rolling session ID to `ui_ovh_p2_b`. Codified in micro-session roll protocol.
4. **vLLM Stream Idle Watchdog (900s) & 4 Stalled Intervals** (`17:11 UTC`): Monolithic review prompt reading 1,000+ LOC and multiple diffs caused extended prefill/deliberation that tripped the 15-min idle watchdog after Claude waited through 3 consecutive 10-minute task timeouts (30 min total); recovered by compacting prompt to targeted greps which passed in 197.9s.
5. **vLLM JSON Serialization Glitch / Malformed Wake Payload** (`13:15 UTC`): `Unterminated string` masked by stream proxy with HTTP 200 and exit code 0 (`isError=false`); resolved by enforcing Rule 8 (Fail-Fast, zero error masking).
6. **Report Generation Stream Cutoff** (`14:46 UTC`): Output stream truncated mid-sentence due to output token ceiling exhaustion; resolved by decoupling reasoning tokens via `QWEN_MAX_REASONING_TOKENS=32768`.

*Complete raw logs, Prometheus dumps, GPU telemetry, and parsed metrics are preserved in [`benchmarks/sessions/session_20260907/`](benchmarks/sessions/session_20260907/).*

---

## SWE-rebench Validation Benchmark

To evaluate real-world software engineering generalization without data contamination, the stack was benchmarked against [SWE-rebench](https://swe-rebench.com/) (Nebius, `nebius/SWE-rebench-leaderboard`), using fresh GitHub issues created after model training cutoffs (March 2026 split):

- **Resolved Rate (Best-of-1)**: **32.0% (16/50)** on uncurated fresh GitHub issues.
- **Attempted Resolution Rate**: **57.1% (16/28)** for issues completed within the 900s timeout budget.
- Full reproduction scripts and grading reports are documented in [`benchmarks/swe-rebench/README.md`](benchmarks/swe-rebench/README.md).

---

## Zero-Trust Sandboxed File Operations

The harness enforces a 5-layer defense-in-depth boundary so neither the model
nor any agent can damage files outside the workspace root:

```
[Agent request]
  1. Synchronous PathEscape normalizer  -> blocks ../../, C:\, /mnt/c, NUL, CON/PRN/AUX
  2. Symlink realpath containment       -> fs.realpathSync; blocks escaping links
  3. Workspace root overwrite guard     -> blocks root/parent deletion or overwrite
  4. Dangerous shell filter             -> blocks rm -rf /, format C:, mkfs, dd, fork bombs
  5. AST syntax gate + Evo rollback     -> node --check / py_compile before commit;
                                           byte-for-byte revert on test failure
  [Safe disk operation]
```

Verified by `tests/security.test.js` — **137 vectors** (123 attack vectors
blocked, 14 allow vectors) across Windows and WSL2.

---

## Testing & Verification

There is **no root `package.json`** — the only one is in `mcp-qwen/`. Always
use `--prefix mcp-qwen` (or run from inside it).

```bash
npm run test --prefix mcp-qwen        # 31 suites - fast offline gate
npm run test:all --prefix mcp-qwen    # 36 suites - full gate (authoritative)
TEST_OFFLINE=1 npm run test:all --prefix mcp-qwen   # GPU-less: live suites skip
```

| Command | Suites | Notes |
|---|---|---|
| `npm run test` | **31** | Fast fail-offline gate. |
| `npm run test:all` | **36** | Full superset; the CI pass/fail signal. |
| On-disk `.test.js` | **36** | Union of the two. |

The 4 *live* suites (`evo`, `mcp_client`, `fifo_queue`, `benchmark`) need a
running vLLM on `:18020` + a 24 GB GPU; they **skip honestly** when
`TEST_OFFLINE=1` or the engine is offline.

**CI** (`.github/workflows/ci.yml`) runs the gate on every push/PR across a
**Node 20 & 22 x ubuntu-latest & windows-latest** matrix (4 jobs, no
fail-fast), using `npm ci` for deterministic native-binary resolution.

All suites enforce the **Universal LF invariant** (`.gitattributes`:
`* text=auto eol=lf`); a CRLF leak trips `LineEndingMismatchError`.

---

## Repository Structure

```
Anser/
  README.md                 # This file
  AGENTS.md                 # Machine-readable operating contract (2026 AAIF)
  CONTRIBUTING.md           # Human contributor workflow
  SECURITY.md               # Private vulnerability reporting
  LICENSE                   # MIT (Anser Contributors)
  .github/
    workflows/ci.yml        # Cross-platform test gate
    ISSUE_TEMPLATE/         # Bug + feature request templates
  mcp-qwen/                 # The Anser MCP server + microkernel
    index.js                # Entry: 3 tools, lifecycle, isMain guard
    stream_proxy.js         # :18022 universal SSE proxy
    src/                    # config, platform, wsl_bridge, semaphore,
                            #   task_registry, server_lifecycle, tools
    src/harness/            # runner, core/, services/, evo/
    tests/                  # 36 suites
  scripts/                  # Launchers (Windows .bat + WSL .sh)
  benchmarks/               # SWE-rebench, wedge-repro, session telemetry
  docs/                     # Architecture specs + adversarial audits
  llama-cpp/                # Native Windows CUDA build of llama.cpp
```

---

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the full workflow (setup,
tests, Conventional Commits, PR checklist) and [`AGENTS.md`](AGENTS.md) for
the machine-readable contract. In short:

- **No GPU needed** to contribute — the 36-suite gate runs offline.
- **Conventional Commits**; one logical concern per PR.
- **Green CI + green gate** are the merge gate.
- **Security issues** are reported privately per [`SECURITY.md`](SECURITY.md),
  never as a public issue.

---

## License & Acknowledgments

Licensed under the [MIT License](LICENSE) — **Anser Contributors**.

- **Qwen Team (Alibaba Cloud)** for Qwen3.8-27B.
- **vLLM Project** for high-throughput LLM serving.
- **Huawei CSL** for [KVarN](https://github.com/huawei-csl/KVarN).
- **Inco AI** for the [DFlash2](https://inco.ai/blog/dflash2/) block drafter.
- **Herrington Darkholme & contributors** for [ast-grep](https://github.com/ast-grep/ast-grep).
