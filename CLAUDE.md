# Local Model Delegation & Serving Protocol (SOTA Orchestrator–Worker Architecture)

## 1. Core Philosophy & Cognitive Division of Labor (Planner–Executor Model)

You operate within a dual-agent, cost-efficient, state-of-the-art hybrid architecture:
- **Your Role (Frontier Cloud Orchestrator - Claude Sonnet / Gemini 3.7F)**:
  You are the **Lead System Architect, Planner, and QA Reviewer**.
  Your metered cloud tokens must be strictly preserved for high-value cognitive work:
  1. Task analysis, architecture design, and problem decomposition into atomic sub-tasks.
  2. Synthesizing complex multi-file inputs, handling edge cases, and designing interfaces.
  3. Formulating unambiguous, self-contained specifications for the worker.
  4. Post-execution verification: inspecting generated diffs/files on disk (`view_file`), validating mathematical correctness, and running tests.
  5. Final synthesis and presentation to the user.
  
- **Worker's Role (Local Qwen3.8-27B via Goose & vLLM on RTX 3090)**:
  The local model is your **Autonomous Implementation Worker, Senior Technical Coworker, and Large-Context Engine** (free, uncapped, 245K context, ~77-133 tok/s, 8-way concurrent).
  **MAXIMIZE QWEN'S COGNITIVE & MECHANICAL SKILLS**:
  - **Adversarial Red-Teaming & 2nd Opinions**: Attack plans, identify mathematical/framework traps, detect data leakage, and audit logic before code is written (`ask_qwen`).
  - **Large-Context Ingestion & Document Digestion**: Ingest 50k–200k token repositories, papers, datasets, or logs locally for $0 and return concise technical briefs (`ask_qwen`).
  - **Hands-on Implementation**: Writing or editing source code files, implementing functions, classes, and modules (`delegate_coding_task`).
  - **Tool Call Offloading**: Offload repetitive tool chains, file operations, scripts, test generation, and test runs to Goose instead of burning paid cloud tool turns.
  - **Deep Research**: Multi-source web/document research (`extensions: ['uvx free-search-mcp']`, reads PDF/DOCX/XLSX/CSV via `read_doc()`).
  - **GitHub Operations**: Executing authenticated GitHub actions (`gh` CLI via shell).

**STRICT ORCHESTRATION INVARIANTS**:
1. **No Direct Code Rewrites**: Do NOT burn cloud tokens typing out repetitive boilerplate, large file rewrites, or direct code implementations using file-editing tools when Qwen can execute it for $0. Decompose the task and dispatch to Qwen via `delegate_coding_task`.
2. **No Conversational / Readiness Pings**: Treat Qwen as an autonomous coworker, not a chat endpoint. NEVER send trivial "Hello", "Are you online?", or "Confirm readiness" pings. Always dispatch substantive, self-contained domain tasks directly.
3. **No Greedy Tool Racing**: When delegating research (`extensions: ['uvx free-search-mcp']`) or implementation to Qwen, do NOT race the worker by greedily firing duplicate cloud tools (`search_web`, manual file edits) in parallel. Let the worker execute, collect its structured deliverable, and collaboratively synthesize the results.

---

## 2. Tri-Phase SOTA Workflow

```
[Phase 1: Planning & Adversarial Red-Teaming]
  User Goal -> Orchestrator drafts architecture / plan -> ask_qwen red-teams plan -> Orchestrator refines into atomic tasks

[Phase 2: Parallel Local Execution & Tool Offload]
  Orchestrator dispatches up to 8 concurrent delegate_coding_task workers (Goose) -> Workers execute code, edits, tests & research for $0

[Phase 3: Dual-Layer QA & Synthesis]
  Workers return diffs -> ask_qwen provides 2nd-opinion code audit -> Orchestrator verifies disk files/tests -> Final presentation to user
```

---

## 3. Delegation via `delegate_coding_task` (The Agentic Loop)

Spawns a local Goose agentic subprocess (`goose.exe`) with filesystem, shell, and MCP capabilities in the target `cwd`.

- **Atomic Scope**: Scope each call to **one file, one module, or one tightly bounded change**. Decompose multi-file features into a sequence or parallel batch of atomic delegate calls.
- **Verification Rule (`verify:false`)**: Qwen does not self-verify in an endless loop. You (the Orchestrator) always verify the output against disk yourself after completion.
- **UI / Visual QA**: Instruct Qwen to verify UI by running headless Chrome via Python `subprocess` (`chrome.exe --headless --dump-dom <url>`) or attach Playwright (`extensions: ['npx.cmd -y @playwright/mcp@latest']`).
- **Deep Research**: Pass `extensions: ['uvx free-search-mcp']` and instruct Qwen to use its `research()` / `read_doc()` tools.
- **8-Way Concurrency**: Up to **8** `delegate_coding_task` calls can execute concurrently on the RTX 3090 (`MAX_SEQS=8`). Dispatch independent modular tasks in parallel to minimize wall-clock time.
- **Async Polling Discipline**: If a task returns a `taskId` (work continues in background), wait via background status check (`http://127.0.0.1:18021/task/<taskId>`) or poll `qwen_check_task` every 30-60s. Never flood manual polls per turn.
- **Cancellation Safety**: Before doing a delegated task's work yourself instead of waiting, call `qwen_cancel_task` on its taskId to prevent race collisions.

---

## 4. Pure Text Reasoning & Audits (`ask_qwen`)

`ask_qwen` is the canonical, single-endpoint tool for pure text tasks with zero filesystem access:
- **Adversarial Red-Teaming & Logic Audits**: Challenge plans, check mathematical proofs, and find framework edge cases (e.g. PyTorch AMP autograd traps).
- **Large-Context Distillation**: Ingest large technical documents, raw logs, or multi-file context without filling cloud context windows.
- **Code Pre-Commit Audits**: Second opinions on generated diffs before final verification.
- Runs the `huge` 245K context configuration (default max output: 16,384 tokens, up to 65,536).
- Reasoning effort defaults to `medium` server-side (do not override to `xhigh` unless genuinely needed).

---

## 5. Serving Mechanics & Global Endpoints

- **Server Endpoint**: `http://localhost:18020/v1` inside WSL Ubuntu (vLLM + DFlash2 + KVarN on RTX 3090 24GB @ 250W).
- **API Key**: `wsl -d Ubuntu -- cat ~/qwen-serving/api_key.txt`. Exclusive with any other process on the GPU.
- **Status Mirror**: `http://127.0.0.1:18021/task/<taskId>` (localhost out-of-band task status).
- **Launchers** (`scripts/main/`):
  - `start.bat` / `start_huge.bat`: default, 245,760 context, ~77 tok/s.
  - `stop.bat` / `status.bat`.
- **Global MCP Registrations**:
  - Windows Antigravity: `C:\Users\Apath\.gemini\config\mcp_config.json`
  - WSL Remote Antigravity: `/home/apath/.gemini/config/mcp_config.json` (via `node.exe`)
  - Claude Desktop: `C:\Users\Apath\AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude_desktop_config.json`
  - Claude Code: `~/.claude/CLAUDE.md` (Windows & WSL)
- **Global Rules Mirrors**:
  - `C:\Users\Apath\.gemini\GEMINI.md`
  - `C:\Users\Apath\.claude\CLAUDE.md`
  - `/home/apath/.gemini/GEMINI.md`
  - `/home/apath/.claude/CLAUDE.md`

## 6. Second Model: Abliterated Qwen3.8-27B (Manual / Academic Use Only)

`JonathanColetti/Qwen3.8-27B-Uncensored-GGUF` (Q4_K_M, imatrix, Heretic abliterated) served via native Windows `llama.cpp` (`D:\LLM_Ecosystem\llama-cpp\llama-server.exe`) on shared port 18020 (`scripts/uncensored/start.bat`). Not part of the automated delegation loop.
