# Anser

**The Universal 245K Agent Microkernel for Local-First Pair-Programming.**

[![CI](https://img.shields.io/badge/CI-Passing%20(Ubuntu%20%7C%20Windows)-success?logo=githubactions&logoColor=white)](#testing--verification)
[![Node](https://img.shields.io/badge/Node-22%20%7C%2024-3C873A?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)
[![Test Gate: 58/58](https://img.shields.io/badge/Test%20Gate-58%2F58%20Suites%20Green-success.svg)](#testing--verification)
[![Context](https://img.shields.io/badge/Context-245%2C760%20Tokens-purple.svg)](#model-serving--speculative-decoding)
[![Engine](https://img.shields.io/badge/Engine-vLLM%20%2B%20DFlash2%20%2B%20KVarN-green.svg)](#model-serving--speculative-decoding)
[![Security](https://img.shields.io/badge/Security-137%2F137%20Vectors%20Contained-success.svg)](#zero-trust-sandboxed-file-operations)

> **Anser** enables a high-reasoning cloud orchestrator (the *Lead Architect* — Claude Code or Google Antigravity) to drive a locally-served **Qwen3.8-27B** running on a single consumer 24 GB GPU (vLLM + DFlash2 + KVarN) at **$0 token cost**.
> 
> The cloud orchestrator designs, plans, and supervises. The local coworker ingests repository context, executes structural AST refactoring, runs test loops, and edits files. **Zero cloud token hoarding. Zero API bills. Your source code never leaves your machine.**

---

## Table of Contents

1. [The Paradigm: Cloud Brain + Local Hands](#the-paradigm-cloud-brain--local-hands)
2. [Benchmark & Economic Grounding](#benchmark--economic-grounding)
3. [Case Study: The 453-Session Marathon ($2,000+ Saved on a Single GPU)](#case-study-the-453-session-marathon)
4. [System Architecture](#system-architecture)
5. [Core Capabilities](#core-capabilities)
6. [Quickstart (3 Steps)](#quickstart-3-steps)
7. [Model Serving, Speculative Decoding & Quantization](#model-serving--speculative-decoding)
8. [Zero-Trust Sandboxed File Operations](#zero-trust-sandboxed-file-operations)
9. [Testing & Verification](#testing--verification)
10. [Repository Structure](#repository-structure)
11. [Contributing](#contributing)
12. [License & Commercial Dual-Licensing](#license--commercial-dual-licensing)

---

## The Paradigm: Cloud Brain + Local Hands

### The Problem: Cloud Token Hoarding
The dominant architecture in modern AI agent development relies on **cloud token hoarding**:
1. **Compounding API Costs**: Pointing frontier cloud models (Claude Opus 5.5, GPT-6 Astra, Claude Fable 5.1, Claude Sonnet 5) at large repositories repeatedly packs hundreds of thousands of context tokens into the prompt on every turn. A multi-turn refactoring or debugging session burns millions of tokens and easily racks up $50–$250 in API bills in an afternoon.
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

## Benchmark & Economic Grounding

### The Agentic Sweet Spot: Dense 27B on Consumer Silicon
In contemporary agentic coding evaluations (including the **Artificial Analysis (AA) Coding Index**, **Terminal-Bench**, and **LiveCodeBench**), closed-source frontier flagships—led by **Claude Fable 5.1** (AA Index #1), **GPT-6 Astra** (AA Index #2), and **Claude Opus 5.5** (AA Index #3)—define the frontier for high-level ambiguous system architecture, multimodal design, and formal verification. In the cloud workhorse tier, models like **Claude Sonnet 5** and **GLM-5.3** provide high-velocity execution.

However, in continuous agentic pair-programming—where 80%+ of prompt tokens are spent iteratively ingesting repository context, checking compiler logs, running AST searches, and applying patches—routing every single turn to paid cloud APIs is economically unsustainable.

**Qwen3.8-27B** represents the optimal sweet spot for local execution:
- **Consumer Hardware Footprint**: A dense 27B parameter architecture that fits completely within a single consumer **24 GB VRAM GPU** (NVIDIA RTX 3090 / 4090) using W4A16 AutoRound quantization.
- **Universal 245K Context**: Ingests entire repositories, test traces, and multi-turn message history with KVarN tiled KV caching.
- **Asymmetric Division of Labor**: The Lead Architect (Claude Code / Gemini 3.8 Flash in Antigravity) handles top-level system architecture and code review, while Qwen3.8-27B executes hands-on AST surgery and test verification locally at **$0 token cost**.

### Benchmark & Pricing Matrix

| Evaluation Dimension | Qwen3.8-27B (via Anser) | Claude Sonnet 5 | Claude Opus 5.5 | GPT-6 Astra / Claude Fable 5.1 | GLM-5.3 |
|---|---|---|---|---|---|
| **Inference Location** | **100% Local (RTX 3090/4090 24GB)** | Managed Cloud API | Managed Cloud API | Managed Cloud API | Managed Cloud API |
| **AA Coding Profile / Role** | Dense local execution & AST surgery | High-efficiency cloud standard | Deep reasoning & formal verification | Frontier coding leader (AA Index #1/#2) | Cloud value & tool-calling champion |
| **API Cost: Prompt Prefill** | **$0.00 / million tokens** | $2.00 / million tokens | $4.00 / million tokens | $10.00 / million tokens | $1.40 / million tokens |
| **API Cost: Completion Output** | **$0.00 / million tokens** | $10.00 / million tokens | $20.00 / million tokens | $50.00 / million tokens | $4.40 / million tokens |
| **Context Window Ceiling** | **245,760 tokens** (Universal 245K) | 500,000 tokens | 1,000,000 tokens | 1,000,000–1,050,000 tokens | 200,000 tokens |
| **Tool Execution Model** | In-process microkernel (Node.js heap) | Remote network API / MCP | Remote network API / MCP | Remote network API / MCP | Remote network API / MCP |
| **Cost of 453-Session Marathon**<br>*(962.3M prompt + 10.4M comp)* | **$0.00** | **$2,028.25 USD** | **$4,056.52 USD** | **$10,141.28 USD** | **$1,392.81 USD** |
| **Data Privacy & Exfiltration** | **Zero bytes leave your machine** | Third-party data centers | Third-party data centers | Third-party data centers | Third-party data centers |

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
| **Financial Savings vs Claude Opus 5.5** | **$4,056.52 USD** saved | At Opus 5.5 rates ($4.00/M prompt, $20.00/M completion) |
| **Financial Savings vs GPT-6 Astra / Claude Fable 5.1** | **$10,141.28 USD** saved | At frontier flagship rates ($10.00/M prompt, $50.00/M completion) |
| **Financial Savings vs GLM-5.3** | **$1,392.81 USD** saved | At cloud value rates ($1.40/M prompt, $4.40/M completion) |
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

### 2. Multi-Provider Web & Framework Documentation Engine
Anser embeds native, dependency-free `web_search` and `web_fetch` services:
- **Intelligent Provider Routing**: Automatically routes queries across **Brave Search**, **Tavily**, **Context7** (targeted framework and library documentation), **SearXNG**, and **DuckDuckGo** with leaky-bucket rate limiting and global config support (`~/.qwen/config.json`).
- **Mozilla Readability & Turndown**: Automatically strips HTML boilerplate, navigation menus, and banner clutter, converting live web pages and documentation into token-dense markdown.

### 3. Cooperative Landing & Turn Ceiling Preservation
No more arbitrary process kills:
- **Zero-Progress-Loss Landing**: When a long-running dispatch reaches its turn budget ceiling (turn 100), tool calling is gracefully disabled and the model is prompted for mandatory deliverable synthesis.
- **Honest Status Taxonomy**: Completed deliverables are preserved and returned under `completed_budget_exhausted` with a structured `[!WARNING]` caution banner and proactive Turn 80 `[!NOTE]` advisories for context-depth management.

### 4. Collaborative Socratic Pair-Programming Dynamic
- **Staff Engineer Peer Dynamic**: Local Qwen is not an unthinking code executor; it pairs with the Lead Architect as a Senior Staff Engineer.
- **Constructive Pushback**: When dispatches contain flawed assumptions, violate repository invariants, or propose suboptimal patterns, Qwen is explicitly empowered to ground its critique in exact file lines, explain trade-offs, and propose cleaner architectural alternatives before mutating code.

### 5. KV Cache Prefix Stability & Lean Action Space
- **Automatic Prefix Caching (APC) Affinity**: All operational directives and single-pass mutation rules are anchored in the static system prompt, avoiding dynamic prompt churn and maximizing vLLM prefix cache hit rates (~8,000–9,500 tok/s prefill).
- **Lean 8-Tool Action Space**: Restricts the coworker's primary action space to 8 canonical, non-overlapping tools (`read_file`, `write_file`, `edit_file`, `apply_patch`, `list_dir`, `search_code`, `ast_search`, `bash`), eliminating tool hallucination and cognitive bloat.

### 6. Zero-Turn Reactive Wait (`/task/<id>/wait`)
Long-running background tasks yield a durable OS wait command. The orchestrator executes:
```bash
curl.exe -fsS --retry 5 --retry-delay 2 http://127.0.0.1:18021/task/<id>/wait
```
The OS process blocks at **$0 token cost** and wakes the orchestrator the moment the coworker finishes.

### 7. Cross-Platform Unified Telemetry Ledger
- Tracked across Windows (`C:\Users\<User>\.qwen\telemetry\stats.json`) and WSL (`~/.qwen/telemetry/stats.json`) via symlink parity.
- Writes are guarded by atomic rename (`stats.json.tmp.<pid>.<ts>` $\to$ `stats.json`), eliminating multi-instance corruption.

---

## Quickstart (3 Steps)

You do **not** need a GPU to test, build, or contribute to Anser. The entire test gate runs offline.

### 1. Clone & Install
```bash
git clone https://github.com/ApatheticMioz/Anser.git
cd Anser/mcp-qwen
npm ci
```

### 2. Verify the 58-Suite Test Gate
```bash
# Run the fast offline test gate (54 offline suites + protocol sync)
npm run test

# Run the authoritative test gate (58 suites; GPU live suites skip honestly if offline)
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
npm run test --prefix mcp-qwen          # 54 offline suites
npm run test:all --prefix mcp-qwen      # 58 suites total (full CI gate)
npm run test:telemetry --prefix mcp-qwen # Telemetry & pricing arithmetic verification
```

All files strictly enforce the Universal LF invariant (`* text=auto eol=lf`).

---

## Repository Structure

```
Anser/
  README.md                 # Production architecture, case study, and quickstart
  CHANGELOG.md              # Project release history & generational changelog
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
    tests/                  # 58 automated test suites
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
