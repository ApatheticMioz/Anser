# Anser

**The Universal 245K Agent Microkernel for Local-First Pair-Programming.**

[![CI](https://img.shields.io/badge/CI-Passing%20(Ubuntu%20%7C%20Windows)-success?logo=githubactions&logoColor=white)](#testing--verification)
[![Node](https://img.shields.io/badge/Node-22%20%7C%2024-3C873A?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)
[![Test Gate: 37/37](https://img.shields.io/badge/Test%20Gate-37%2F37%20Suites%20Green-success.svg)](#testing--verification)
[![Context](https://img.shields.io/badge/Context-245%2C760%20Tokens-purple.svg)](#model-serving--speculative-decoding)
[![Engine](https://img.shields.io/badge/Engine-vLLM%20%2B%20DFlash2%20%2B%20KVarN-green.svg)](#model-serving--speculative-decoding)
[![Security](https://img.shields.io/badge/Security-137%2F137%20Vectors%20Contained-success.svg)](#zero-trust-sandboxed-file-operations)

> **Anser** enables a high-reasoning cloud orchestrator (the *Lead Architect* — Claude Code or Google Antigravity) to drive a locally-served **Qwen3.8-27B** running on a single consumer 24 GB GPU (vLLM + DFlash2 + KVarN) at **$0 token cost**.
> 
> The cloud orchestrator designs, plans, and supervises. The local coworker ingests repository context, executes structural AST refactoring, runs test loops, and edits files. **Zero cloud token hoarding. Zero API bills. Your source code never leaves your machine.**

---

## Table of Contents

1. [The Paradigm: Cloud Brain + Local Hands](#the-paradigm-cloud-brain--local-hands)
2. [Case Study: The 453-Session Marathon ($2,000+ Saved on a Single GPU)](#case-study-the-453-session-marathon)
3. [System Architecture](#system-architecture)
4. [Core Capabilities](#core-capabilities)
5. [Quickstart (3 Steps)](#quickstart-3-steps)
6. [Model Serving, Speculative Decoding & Quantization](#model-serving--speculative-decoding)
7. [Zero-Trust Sandboxed File Operations](#zero-trust-sandboxed-file-operations)
8. [Testing & Verification](#testing--verification)
9. [Repository Structure](#repository-structure)
10. [Contributing](#contributing)
11. [License & Commercial Dual-Licensing](#license--commercial-dual-licensing)

---

## The Paradigm: Cloud Brain + Local Hands

### The Problem: Cloud Token Hoarding
The dominant architecture in modern AI agent development relies on **cloud token hoarding**:
1. **Compounding API Costs**: Pointing a frontier cloud model (Claude Sonnet 5, GPT-5) at a large repository repeatedly packs hundreds of thousands of context tokens into the prompt on every turn. A multi-turn refactoring or debugging session burns millions of tokens and easily racks up $50–$150 in API bills in an afternoon.
2. **IP Exfiltration & Privacy Leakage**: Proprietary corporate codebases, internal configuration files, and API secrets must travel over public networks into third-party cloud data centers.
3. **The Supervisor Polling Tax**: When an autonomous agent launches a long-running build or test suite, traditional orchestrators poll in an active LLM loop, squandering reasoning compute just waiting for a subprocess to exit.

### The Solution: Asymmetric Pair-Programming
Anser inverts this relationship with an asymmetric division of labor:
- **Lead Architect (Cloud Context)**: Frontier orchestrators (Gemini 3.8 Flash in Antigravity or Claude Code) focus strictly on high-level architecture, formal interface specification, multimodal vision review, and supervisory steering. The orchestrator never hoards repository trees into cloud context.
- **Autonomous Coworker (Local Anser @ $0)**: Qwen3.8-27B runs locally inside the in-process Anser microkernel, performing heavy AST queries, file editing, test execution, and codebase exploration at $0 token cost.
- **Zero-Turn Reactive Wait**: Extended tasks yield a durable OS-level wait hook (`curl -fsS http://127.0.0.1:18021/task/<id>/wait`). The cloud orchestrator blocks at **$0 token cost** and is reactively awakened by the OS kernel the instant the coworker concludes.

```
+-------------------------------------------------------------------+
|               LEAD ARCHITECT (Cloud Orchestrator)                 |
|            Gemini 3.8 Flash / Claude Code / Antigravity            |
|       - System Architecture     - Milestone Planning              |
|       - Interface Contracts     - Multimodal Vision Authority     |
+---------------------------------+---------------------------------+
                                  | MCP over stdio (3 tools)
                                  v
+-------------------------------------------------------------------+
|                     ANSER MICROKERNEL (:18021)                    |
|   - In-Process V8 Tool Runtime      - 5-Layer Zero-Trust Sandbox  |
|   - Structural AST Surgery (@ast)   - Invisible Syntax Gates      |
|   - Pre-Wired Web Research (Read)   - Cross-Process O_EXCL Leases |
+---------------------------------+---------------------------------+
                                  | SSE Stream / HTTP
                                  v
+-------------------------------------------------------------------+
|               LOCAL COWORKER (RTX 3090 / 4090 24GB)               |
|            Qwen3.8-27B W4A16 AutoRound @ Universal 245K           |
|            DFlash2 Speculative Decoding (4.59 tok/step)           |
|            KVarN Tiled KV Cache (68.2% Prefix Cache Hit)          |
|                                                                   |
|       >>> LIFETIME DELIVERED: 10M+ TOKENS @ $0 TOKEN COST <<<     |
+-------------------------------------------------------------------+
```

---

## Case Study: The 453-Session Marathon

Anser is battle-tested. The metrics below reflect **exact, ground-truth telemetry** captured across an intensive 3-week continuous development marathon on a single consumer workstation equipped with an **NVIDIA GeForce RTX 3090 (24 GB VRAM)**:

| Production Telemetry Axis | Measured Ground Truth | Operational Significance |
|---|---|---|
| **Completion Tokens Generated** | **10,372,422 tokens** (10.37M) | Production code, AST transforms, unified diffs |
| **Deliberative Reasoning Tokens** | **14,916,578 tokens** (14.92M) | Full test-time compute chain-of-thought (`xhigh`) |
| **Total Prompt Prefill Absorbed** | **962,266,455 tokens** (962.3M) | 268.1M exact measured + 694.1M estimated |
| **Total Model Turns** | **10,918 turns** | Multi-turn agentic pair-programming cycles |
| **Production Sessions Indexed** | **453 sessions** | Persistent multi-week development lifecycle |
| **Completed Complex Tasks** | **118 completed** (35 failed, 4 cancelled) | Real-world feature implementations & refactors |
| **Total Tool Invocations** | **13,749 calls** | `bash` (7,840), `read_file` (2,626), `edit_file` (1,646) |
| **Tool Execution Error Rate** | **1.87%** (257 errors / 13,749 calls) | 98.13% first-pass tool execution reliability |
| **Prefix Cache Hit Rate** | **68.2% sustained** | Sub-second prompt re-prefill via deterministic history |
| **Peak GPU KV Cache Usage** | **99.4% allocation** | VRAM pinned safely below OOM threshold |
| **DFlash2 Speculative Decoding** | **4.59 tokens/step** mean acceptance | Draft acceptance rate of 44.8% (up to 8.0 tok/step) |
| **Active Generation Speed** | **44.54 t/s avg** (Peak: **159.10 t/s**) | Instantaneous speculative decoding burst throughput |
| **Active Prompt Throughput** | **1,376.75 t/s avg** (Peak: **12,044 t/s**) | Fast context digestion via vLLM flash-attention |
| **Financial Savings vs Claude Sonnet 5** | **$2,028.25 USD** saved | At Sonnet 5 rates ($2.00/M prompt, $10.00/M completion) |
| **Financial Savings vs Baseline Rates** | **$3,042.39 USD** saved | At baseline rates ($3.00/M prompt, $15.00/M completion) |
| **Local Inference Token Cost** | **$0.00** | **A $1,000 GPU paid for itself in less than a month.** |

---

## System Architecture

Anser exposes three consolidated, stdio-pure MCP tools to the cloud orchestrator:

1. **`qwen_coworker`**: Primary hands-on coworker interface.
   - Accepts `prompt`, `cwd`, `session_id`, `reasoning_effort` (`xhigh` | `medium` | `low`), and optional MCP `extensions`.
   - Executes with Universal 245K context and high-reasoning test-time deliberation.
2. **`qwen_task`**: Background task management & telemetry.
   - Actions: `status`, `cancel`, `cancel_all`, `list`, `stats`.
   - `stats` returns real-time cumulative token usage, generation throughput, cache telemetry, and financial savings.
3. **`qwen_server`**: vLLM engine lifecycle supervisor.
   - Actions: `status`, `start`, `stop`.
   - Automatically handles cold boots, health canary checks, wedge detection, and self-healing.

---

## Core Capabilities

### 1. In-Process Runtime & Invisible Syntax Gates
- **In-Process Microkernel**: Core file tools (`read_file`, `write_file`, `edit_file`) run directly inside the Node.js process without CLI subprocess spawning overhead.
- **In-Memory Syntax Validation**: Modifications made via `edit_file` are parsed in-memory (TypeScript, Python, JSON, LaTeX, BibTeX) before touching disk. Syntax regressions and malformed patches are rejected immediately with line-level diagnostics, preventing corrupted files and broken states.

### 2. In-Process Web & Research Engine
Anser embeds native, dependency-free `web_search` and `web_fetch` services:
- **Mozilla Readability & Turndown**: Automatically strips HTML boilerplate, navigation menus, and banner clutter, converting web pages into token-dense markdown.
- **Autonomous Documentation Ingestion**: Qwen queries official documentation, verifies API contracts, and inspects library changelogs without third-party CLI dependencies.

### 3. Lean 8-Tool Action Space
Cognitive budget is finite. Anser prunes extraneous tool aliases, restricting the coworker's primary action space to 8 canonical, non-overlapping tools:
- `read_file`, `write_file`, `edit_file`, `apply_patch`, `list_dir`, `search_code`, `ast_search`, `bash`.
- (Evolutionary optimization tools mount conditionally only when automated verification commands are provided).

### 4. Cross-Platform Unified Telemetry Ledger
- Tracked across Windows (`C:\Users\<User>\.qwen\telemetry\stats.json`) and WSL (`~/.qwen/telemetry/stats.json`) via symlink parity.
- Writes are guarded by atomic rename (`stats.json.tmp.<pid>.<ts>` $\to$ `stats.json`), eliminating multi-instance corruption.

### 5. Zero-Turn Reactive Wait (`/task/<id>/wait`)
Long-running background tasks yield a durable OS wait command. The orchestrator executes:
```bash
curl.exe -fsS --retry 5 --retry-delay 2 http://127.0.0.1:18021/task/<id>/wait
```
The OS process blocks at **$0 token cost** and wakes the orchestrator the moment the coworker finishes.

---

## Quickstart (3 Steps)

You do **not** need a GPU to test, build, or contribute to Anser. The entire test gate runs offline.

### 1. Clone & Install
```bash
git clone https://github.com/ApatheticMioz/Anser.git
cd Anser/mcp-qwen
npm ci
```

### 2. Verify the 37-Suite Test Gate
```bash
# Run the fast offline test gate (34 offline suites + protocol sync)
npm run test

# Run the authoritative test gate (37 suites; GPU live suites skip honestly if offline)
npm run test:all
```

### 3. Register with Your Cloud Orchestrator

**For Claude Code:**
```bash
claude mcp add --scope user qwen-anser node <path-to-repo>/mcp-qwen/index.js
```

**For Google Antigravity IDE:**
```bash
python <path-to-repo>/mcp-qwen/update_schemas.py
```

*(Optional: To run the live local model, launch vLLM on port 18020 with the provided launchers. Anser auto-detects and boots the engine on first dispatch).*

---

## Model Serving & Speculative Decoding

The serving stack is optimized for consumer 24 GB GPUs (NVIDIA RTX 3090 / 4090):
- **Model**: Qwen3.8-27B (hybrid dense Gated-DeltaNet + attention, 65 layers, W4A16 AutoRound).
- **VRAM Optimization**: `--language-model-only` excludes the vision encoder, saving ~2.7 GB VRAM.
- **Speculative Block Drafter**: DFlash2 1.92B non-autoregressive drafter yielding 4.59 tokens/step mean acceptance.
- **KVarN Tiled KV Cache**: 4-bit keys / 2-bit values per 128-token tile, providing a 245,760-token ceiling within 24GB VRAM.

---

## Zero-Trust Sandboxed File Operations

Anser implements a **5-layer defense-in-depth boundary** ensuring neither the coworker nor external agents can escape the workspace root:

```
[Agent Tool Request]
        |
        v
  1. Synchronous PathEscape Normalizer  -> Blocks ../../, C:\, /mnt/c, NUL, CON, PRN
        |
  2. Symlink Realpath Containment       -> fs.realpathSync; blocks escaping symlinks
        |
  3. Workspace Root Overwrite Guard     -> Blocks root/parent directory deletion
        |
  4. Dangerous Shell Filter             -> Blocks rm -rf /, format C:, fork bombs, dd
        |
  5. AST In-Memory Syntax Gate          -> Validates syntax before disk commit;
                                           reverts byte-for-byte on error
        v
  [Safe Workspace Disk Mutation]
```

Verified by a **137-vector security suite** (`tests/security.test.js`: 123 attack vectors blocked, 14 legitimate allow vectors).

---

## Testing & Verification

Every pull request is validated across **Node 22 & 24 on Ubuntu and Windows**:

```bash
npm run test --prefix mcp-qwen          # 34 offline suites
npm run test:all --prefix mcp-qwen      # 37 suites total (full CI gate)
npm run test:telemetry --prefix mcp-qwen # Telemetry & pricing arithmetic verification
```

All files strictly enforce the Universal LF invariant (`* text=auto eol=lf`).

---

## Repository Structure

```
Anser/
  README.md                 # Production architecture, case study, and quickstart
  AGENTS.md                 # Machine-readable operating contract (2026 AAIF standard)
  CONTRIBUTING.md           # Contributor workflow and PR guidelines
  SECURITY.md               # Private vulnerability reporting policy
  LICENSE                   # GNU AGPLv3
  mcp-qwen/                 # Core Anser microkernel & MCP server
    index.js                # MCP server entry point (3 consolidated tools)
    stream_proxy.js         # :18022 universal SSE streaming proxy
    src/
      telemetry.js          # Cross-platform token & financial savings tracker
      anser_runner.js       # Background task coordinator & lifecycle hooks
      tools.js              # Zod schemas & MCP dispatch handlers
      harness/              # In-process Anser microkernel
        runner.js           # Multi-turn execution loop & watchdog guards
        core/               # Kernel plugin registry & event system
        services/           # Sandboxed FS, AST, Shell, Web research services
        evo/                # Evolutionary optimizer, lineage DAG & rollback
    tests/                  # 37 automated test suites
  benchmarks/               # Historical session telemetry & empirical dumps
```

---

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) and [`AGENTS.md`](AGENTS.md).
- **No GPU needed** to contribute — the offline test gate is 100% functional without hardware.
- Conventional Commits enforced (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`).
- Report security issues privately per [`SECURITY.md`](SECURITY.md).

---

## License & Commercial Dual-Licensing

Licensed under the **[GNU Affero General Public License v3 (AGPL-3.0)](LICENSE)** — **Anser Contributors**.

- **Open Source & Copyleft**: Anser is free and open-source software. You are free to inspect, run, modify, and redistribute it under the terms of the AGPLv3.
- **Enterprise & Dual-Licensing**: If you wish to embed Anser's microkernel or sandbox components into a proprietary commercial product or internal closed infrastructure without copyleft obligations, a commercial dual-license is available. Inquiries: [`ApatheticMioz@gmail.com`](mailto:ApatheticMioz@gmail.com).

### Acknowledgments
- **Qwen Team (Alibaba Cloud)** for Qwen3.8-27B.
- **vLLM Project** for high-throughput LLM serving.
- **Huawei CSL** for [KVarN](https://github.com/huawei-csl/KVarN).
- **Inco AI** for the [DFlash2](https://inco.ai/blog/dflash2/) block drafter.
- **Herrington Darkholme** for [ast-grep](https://github.com/ast-grep/ast-grep).
- **syv-ai** for [HyperQwen](https://github.com/syv-ai/HyperQwen) serving baselines.
