# Castor

**The Universal 245K Agent Microkernel & MCP Pair-Programming Harness.**

[![CI](https://img.shields.io/badge/CI-Passing%20(Ubuntu%20%7C%20Windows)-success?logo=githubactions&logoColor=white)](#testing--verification)
[![Node](https://img.shields.io/badge/Node-22%20%7C%2024-3C873A?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)
[![Test Gate: 66/66](https://img.shields.io/badge/Test%20Gate-66%2F66%20Suites%20Green-success.svg)](#testing--verification)
[![Context](https://img.shields.io/badge/Context-245%2C760%20Tokens-purple.svg)](#model-serving--speculative-decoding)
[![Engine](https://img.shields.io/badge/Engine-vLLM%20%2B%20DFlash2%20%2B%20KVarN-green.svg)](#model-serving--speculative-decoding)
[![Security](https://img.shields.io/badge/Security-137%20Containment%20Vectors-success.svg)](#zero-trust-sandboxed-file-operations)

> **Castor** is a model-agnostic serving harness and in-process agent microkernel exposed as a standard Model Context Protocol (MCP) server. It pairs high-reasoning cloud orchestrators (Google Antigravity, Gemini 3.8 Flash, Claude Code) with locally-served execution models (**Qwen3.8-27B**, Ollama, vLLM) across any repository.
> 
> **The Ultimate API Bill Cutter:** The cloud orchestrator handles high-level architecture, task decomposition, and supervisory steering. The local coworker ingests repository context, executes structural AST refactoring, runs test loops, and mutates code at **$0 token cost**. **Zero cloud token hoarding. 90%+ API cost reduction.**

---

## System Architecture

<p align="center">
  <img src="docs/assets/architecture.svg" alt="Castor Architecture &amp; MCP Delegation Workflow" width="100%" />
</p>

### The Asymmetric Division of Labor
- **Cloud Orchestrator (Lead Architect)**: Focuses strictly on architecture, formal interface specification, multimodal vision review, and supervisory steering. Never hoards raw codebase files into paid prompt context.
- **Local Coworker (Hands-on Execution @ $0)**: Ingests repositories, analyzes traces, performs AST surgery (`@ast-grep`), and verifies code locally inside the in-process Castor microkernel.
- **Zero-Turn Reactive Wait**: Long-running background dispatches yield an OS-level wait hook (`curl :18021/task/<id>/wait`). The cloud orchestrator blocks at **$0 token cost** and wakes reactively the moment the coworker completes.

---

## Benchmark & Economic Grounding

In continuous agentic coding, **80%+ of prompt tokens** are spent repeatedly ingesting repository context, compiler logs, and AST search results. Pumping those tokens through paid cloud frontier models costs $50–$250 in API bills every afternoon.

**Qwen3.8-27B** via Castor provides dense, high-reasoning execution on a single consumer **24 GB VRAM GPU** (RTX 3090 / 4090) with a **Universal 245K context window**.

| Evaluation Dimension | Qwen3.8-27B (via Castor) | Claude Sonnet 5 | Claude Opus 5.5 | GPT-6 Astra | GLM-5.3 |
|---|---|---|---|---|---|
| **Inference Location** | **100% Local (24GB GPU)** | Managed Cloud API | Managed Cloud API | Managed Cloud API | Managed Cloud API |
| **AA Coding Profile / Role** | Dense local execution & AST surgery | High-efficiency cloud standard | Deep reasoning & formal verification | Frontier coding leader | Cloud tool-calling champion |
| **API Cost: Prompt Prefill** | **$0.00 / million tokens** | $2.00 / million tokens | $4.00 / million tokens | $10.00 / million tokens | $1.40 / million tokens |
| **API Cost: Completion Output** | **$0.00 / million tokens** | $10.00 / million tokens | $20.00 / million tokens | $50.00 / million tokens | $4.40 / million tokens |
| **Context Window Ceiling** | **245,760 tokens** (Universal 245K) | 500,000 tokens | 1,000,000 tokens | 1,000,000 tokens | 200,000 tokens |
| **Tool Execution Latency** | In-process microkernel (0.01 ms) | Remote network API / MCP | Remote network API / MCP | Remote network API / MCP | Remote network API / MCP |
| **Cloud Token Hoarding** | **None** (Only synthesized slices) | Heavy (Full repos hoarded) | Heavy (Full repos hoarded) | Heavy (Full repos hoarded) | Heavy (Full repos hoarded) |

### Verified Lifetime Production Telemetry (1.31B+ Tokens Processed @ $0 Cost)

Across continuous software engineering, multi-turn pair-programming, and architectural refactoring on local consumer hardware (RTX 3090 24GB), Castor has recorded and empirically validated the following cumulative production telemetry (`~/.castor/telemetry/stats.json`):

| Production Telemetry Dimension | Verified Cumulative Metric | Operational Impact & Savings |
|---|---|---|
| **Cumulative Prompt / Ingest Volume** | **1,309,571,077 tokens (1.31 Billion)** | Absorbed full repository ASTs, git diffs & build traces locally at **$0 token cost** |
| **Cumulative Completion Output** | **22,045,497 tokens (22.05 Million)** | Delivered structural AST surgery, code generation, and test suites |
| **Test-Time Deliberation (Reasoning)** | **23,832,473 tokens (23.83 Million)** | Deep chain-of-thought and architectural planning at zero marginal API billing |
| **Total Conversational Turns** | **17,616 turns** across **453 sessions** | Persistent prefix cache reuse preventing speculative decoding decay |
| **Autonomous Tool Operations** | **23,965 sandboxed executions** | 11,809 bash, 5,173 read, 2,898 edit, 1,266 search, 1,161 write, 557 web research |
| **Prefix Cache Hit Rate** | **92.6%** (warm cache) | In-memory KV prefix reuse sustaining 8,000–15,000+ tok/s prefill speeds |
| **Speculative Drafter (DFlash2)** | **61.9% acceptance rate** | Mean draft acceptance of **5.33 tokens/step** (instantaneous decode $\approx$ 61.1 tok/s) |
| **Zero-Turn Reactive Wait Savings** | **~1.3B tokens eliminated** | Blocking long-poll (`:18021`) eradicated supervisor polling loops |
| **Net Financial Savings (Claude Sonnet 5)** | **$2,839.60 USD saved** | At $2.00/M prompt, $10.00/M completion ($0 local execution cost) |
| **Net Financial Savings (Frontier Tier)** | **$14,198.00+ USD saved** | vs Opus 5.5 / GPT-6 Astra ($10.00/M prompt, $50.00/M completion) |

---

## Consolidated MCP Interface

Castor exposes three stdio-pure MCP tools to any client:

1. **`qwen_coworker`**: Primary execution interface.
   - Accepts `prompt`, `cwd`, `session_id`, `reasoning_effort` (`xhigh` | `medium` | `low`), and optional MCP `extensions`.
   - Executes with Universal 245K context and test-time deliberation.
2. **`qwen_task`**: Background task management & telemetry.
   - Actions: `status`, `cancel`, `cancel_all`, `list`, `stats`, `extend_lease`.
   - Returns real-time cumulative token counts, generation throughput, cache hit rates, and financial savings.
3. **`qwen_server`**: Inference engine lifecycle supervisor.
   - Actions: `status`, `start`, `stop`.
   - Manages engine boot, health canaries, wedge detection, and auto-healing.

---

## Core Capabilities

- **In-Process Microkernel & AST Surgery**: File operations and structural AST replacements (`@ast-grep`) execute in-process in V8 (0.01 ms dispatch) without subprocess overhead.
- **In-Memory Syntax Gates**: Pre-validates modifications in-memory (TypeScript, JavaScript, Python, JSON, LaTeX, BibTeX) before committing to disk, preventing corrupted files.
- **Dual Multimodal Vision Authority**: Cloud orchestrators (Gemini 3.8 Flash) and local Qwen both support image inputs. Vision-tower CPU offload retains the complete 268K+ KV cache in GPU VRAM.
- **Multi-Provider Web Research**: Native, dependency-free `web_search` and `web_fetch` routing across Brave Search, Tavily, Context7, SearXNG, and DuckDuckGo.
- **Automated State Pruning (`castor clean`)**: Automatic retention policy over `~/.castor/` (14-day max age, 200-session count, 50MB ceiling, `.tmp_*` cleanup) with active session immunity and 24-hour startup throttling.
- **Cooperative Landing**: Dispatches reaching their turn budget conclude gracefully with mandatory deliverable synthesis under `completed_budget_exhausted` instead of arbitrary process kills.

---

## Zero-Trust Sandboxed File Operations

Castor implements a **5-layer defense-in-depth boundary** ensuring neither the coworker nor external agents can escape the workspace root:

<p align="center">
  <img src="docs/assets/security_sandbox.svg" alt="5-Layer Zero-Trust Sandbox Pipeline" width="100%" />
</p>

1. **PathEscape Normalizer**: Rejects directory traversal (`../../`), raw drive letters (`C:\`), and device namespaces (`NUL`, `CON`, `PRN`).
2. **Symlink Realpath Containment**: Resolves real canonical paths via `fs.realpathSync` to block symlink breakouts.
3. **Workspace Root Overwrite Guard**: Protects the workspace root and parent directories from deletion or replacement.
4. **Dangerous Shell Filter**: Neutralizes destructive commands (`rm -rf /`, `format`, fork bombs, `dd`).
5. **AST In-Memory Syntax Gate**: Validates syntactical integrity before disk commit; reverts byte-for-byte on parse errors.

*Verified by a 137-vector automated containment suite (`tests/security.test.js`: 123 attack vectors blocked, 14 allow vectors permitted).*

---

## Quickstart (1-Command Install)

### Automatic 1-Command Setup (Zero Clone)
No git clone or repository building required. Run via `npx` to automatically configure your environment and register the MCP server with both Google Antigravity and Claude Code:

```bash
# 1-Command Install: registers with Antigravity IDE and Claude Code automatically
npx -y mcp-castor install

# (Optional) Configure engine endpoint or model name
npx -y mcp-castor config set baseURL "http://localhost:18020/v1"
npx -y mcp-castor config set model "qwen3.8-27b"

# Prune stale session files anytime
npx -y mcp-castor clean
```

Or install globally:
```bash
npm install -g mcp-castor
castor install
```

---

### Development & Contributing from Source
If you are modifying Castor's microkernel or contributing upstream:

```bash
git clone https://github.com/ApatheticMioz/Castor.git
cd Castor/mcp-castor
npm ci
npm test             # Fast canary gate (~4s, 9 critical suites)
npm run test:all     # Authoritative offline test gate (66 suites)
node bin/castor.js install --dev
```

---

## Model Serving Stack

Optimized for consumer 24 GB GPUs (NVIDIA RTX 3090 / 4090):
- **Model**: Qwen3.8-27B (hybrid dense Gated-DeltaNet + attention, 65 layers, W4A16 AutoRound).
- **Vision Offloading**: `VISION=1` + `VLLM_VISION_CPU_OFFLOAD_GB=1` keeps the vision encoder in host RAM while preserving all 268,000+ KV tokens in VRAM.
- **Speculative Block Drafter**: DFlash2 1.92B non-autoregressive drafter yielding 5.33 tokens/step mean acceptance (61.9% draft acceptance rate).
- **KVarN Tiled KV Cache**: 4-bit keys / 2-bit values per 128-token tile, enabling a 245,760-token context ceiling.

---

## Repository Structure

```
Castor/
  README.md                 # Architecture, benchmarks, and quickstart
  AGENTS.md                 # Canonical machine-readable operating contract
  CONTRIBUTING.md           # Contributor workflow and PR guidelines
  SECURITY.md               # Private vulnerability reporting policy
  LICENSE                   # GNU AGPLv3
  docs/assets/              # Vector architecture and security SVG diagrams
  scripts/wsl/              # Serving launch & lifecycle scripts (vLLM, KVarN, DFlash2)
  mcp-castor/               # Core Castor microkernel & MCP server
    index.js                # MCP server entry point (3 consolidated tools)
    stream_proxy.js         # :18022 universal SSE streaming proxy
    bin/castor.js            # CLI management tool (init, config, clean, mcp)
    src/
      config.js             # Configuration, state directories & port defaults
      state_pruner.js       # Session retention & task log pruner
      server_lifecycle.js   # Serving engine boot, canary, & health checks
      wsl_bridge.js         # Cross-platform execution & process tree management
      telemetry.js          # Cross-platform token & financial savings tracker
      harness/              # In-process Castor microkernel
        runner.js           # Multi-turn execution loop & watchdog guards
        core/               # Kernel plugin registry & event system
        services/           # Sandboxed FS, AST, Shell, Web research services
        evo/                # Evolutionary optimizer, lineage DAG & rollback
    tests/                  # 66 automated test suites
```

---

## License & Commercial Dual-Licensing

Licensed under the **[GNU Affero General Public License v3 (AGPL-3.0)](LICENSE)** — **Castor Contributors**.

- **Open Source & Copyleft**: Free and open-source software under AGPLv3. Network use requires complete source distribution of modified versions.
- **Commercial Dual-Licensing**: Available for proprietary embedding without copyleft obligations. Inquiries: [`ApatheticMioz@gmail.com`](mailto:ApatheticMioz@gmail.com).

### Acknowledgments
- **Qwen Team (Alibaba Cloud)** for Qwen3.8-27B.
- **vLLM Project** for high-throughput LLM serving.
- **Huawei CSL** for [KVarN](https://github.com/huawei-csl/KVarN).
- **Inco AI** for the [DFlash2](https://inco.ai/blog/dflash2/) block drafter.
- **Herrington Darkholme** for [ast-grep](https://github.com/ast-grep/ast-grep).
- **syv-ai** for [HyperQwen](https://github.com/syv-ai/HyperQwen) serving baselines.
