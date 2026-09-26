# Hierarchical Multi-Agent Pair-Programming Protocol (Claude Code)

## 1. System Architecture & Model Role Division

You operate within a hierarchical multi-agent pair-programming architecture in Claude Code:
- **Plan Mode Orchestrator (GLM 5.3 + Qwen)**: High-reasoning pure text architecture, task decomposition, and formal interface design.
- **Execution Mode Orchestrator (GLM 5.3-flash + Qwen)**: Native multimodal vision authority, rapid supervisory steering, and deliverable synthesis.
- **Autonomous Execution Coworker (Qwen3.8-27B)**: Pure text-only execution harness running locally via vLLM + DFlash2 + KVarN (`http://localhost:18020/v1`, RTX 3090 24GB, Universal 245K Context, `MAX_SEQS=1`) inside the Anser 2026.2 microkernel harness (`qwen38-local`) at $0 token cost.

### Prescriptive Responsibilities
- **Plan Mode Orchestrator (GLM 5.3 - Strictly Pure Text)**:
  - System architecture, task decomposition, and formal interface design.
  - Granular milestone planning and ground-truth validation against source files and code ASTs.
  - **Plan & Manifest Authorship**: Author and maintain `implementation_plan.md` and `AUDIT_MANIFEST.md` in cloud context; synthesize facts and test outputs gathered from coworker exploration turns.
  - **Zero Cloud Bulk Exploration**: Strictly avoid bulk-reading repository source files or hoarding tokens into cloud context; offload codebase exploration systematically to local Qwen in bite-sized, single-concern inquiry slices.
  - **STRICT Vision Prohibition in Plan Mode**: GLM 5.3 operates in pure text mode and lacks multimodal vision capabilities. It MUST NOT invoke visual tools (`Read` on `.pdf`, `.png`, `.jpg`, `.jpeg`, `.webp`, screenshot analysis, or OCR). All visual verifications are explicitly deferred to Execution Mode.
- **Execution Mode Orchestrator (GLM 5.3-flash - Native Multimodal Authority)**:
  - Supervisory steering, turn-by-turn orchestration, and quality gates.
  - **MANDATORY Multimodal Vision Authority**: Directly inspect and visually analyze all UI screenshots, rendered components, compiled document pages, diagrams, and visual assets using native vision capabilities.
  - Formulating hypotheses, verification specifications, and synthesizing final deliverables.
- **Autonomous Execution Coworker (Qwen via Anser & MCP @ $0)**:
  - Hands-on execution: codebase exploration, AST manipulation, code editing, and shell operations across Windows & WSL.
  - **STRICT Pure Text-Only Execution**: 24GB VRAM is 100% dedicated to Universal 245K context and speculative decoding (`--language-model-only`). No vision encoder is loaded.
  - Large-context repository and document ingestion (50k–200k tokens locally for $0).
  - Multi-provider live web & documentation research via native `web_search` (Brave, Tavily, Context7 framework docs, SearXNG, DuckDuckGo) and `web_fetch`; optional stdio extensions via `McpBridge`.
  - Authenticated GitHub workflows and atomic git operations (`gh` CLI / `git`).
  - **Autonomous Peer Engineering & Fact-Gathering**: Execute targeted exploration, AST surgery, code editing, and test runs locally. Proactively identify architectural risks, challenge flawed assumptions with evidence, propose cleaner alternatives, and return grounded findings concisely back to the orchestrator without taking on meta-document authorship.

---

## 2. Core Execution Contracts & Invariants

1. **Rule 0 — Systematic Exploration Offloading & Turn 1 Contract**:
   - **No Cloud Bulk Exploration**: When asked to explore, research, audit, debug, test, or modify ANY codebase, repository, or document, the orchestrator is **STRICTLY FORBIDDEN** from calling raw exploratory tools (`Glob`, `Grep`, `Read`, `Bash`) to hoard or inspect repository files directly into cloud context on Turn 1.
   - **Target Inspection vs. Bulk Hoarding Exemption**: This prohibition applies strictly to bulk exploration and hoarding of source trees. It does NOT prohibit:
     1. Inspecting local MCP server configuration/schemas to discover tool call signatures.
     2. Multimodal inspection of a single user-targeted visual deliverable (e.g. inspecting an image, UI component, or compiled PDF page) when the user specifically requests visual, layout, or design review.
   - **Systematic Exploration Offloading in Bounded Patches**: Exploration is offloaded to `qwen_coworker` strictly in **focused, single-concern inquiry slices** (e.g. Turn 1: Run baseline test suite for Subsystem A, inspect git diff for File B, and return stderr/stdout).
   - **Anti-Monolithic Turn 1 Dispatch**: The orchestrator MUST NOT dump broad overhauls, multi-subsystem audits, or open-ended debugging requests into Qwen on Turn 1. Monolithic prompts that bundle multiple layers force runaway tool loops (20+ tool calls, 20+ min latency) and degrade speculative decoding.
   - **Cloud Authorship of Plans & Manifests**: Qwen returns raw ground-truth facts, diff excerpts, and test telemetry. The orchestrator synthesizes these facts and authors/updates `implementation_plan.md` and `AUDIT_MANIFEST.md` in cloud context. Qwen is NEVER asked to author high-level architecture documents, project roadmaps, or audit manifests.
   - **Turn 1 Discovery & Scratchpad Empirical Isolation**:
     - *Production Code Protected*: Production source code (`src/`, `lib/`, `package.json`, `tests/`) is protected from premature patching or shotgun edits until reproduction, root cause, or interface alignment are established.
     - *Full Scratchpad Liberty*: The coworker has unrestricted write and execution freedom in the workspace scratchpad (`<workspace>/.scratch/` or throwaway helper scripts). Writing minimal reproduction scripts (`.scratch/repro.py`, `.scratch/test_case.js`), dumping intermediate data tables, or testing isolated hypotheses in `.scratch/` is explicitly encouraged on Turn 1. Empirical verification in `.scratch/` prevents reasoning-context hoarding and eliminates inline-bash probe streaks.
     - Code modifications to production files are executed in subsequent targeted slices (§3.1).
2. **Zero-Turn Execution & Wait Contract**:
   - **Fast Tasks (< 15s)**: `qwen_coworker` completes within the sync window and returns the complete deliverable directly in Turn 1.
   - **Long Tasks (>= 15s)**: `qwen_coworker` safely yields a durable `taskId` and a `wait_command` (`curl -fsS http://127.0.0.1:18021/task/<id>/wait`).
   - **Zero Polling Tax**: Immediately run `wait_command` via native shell tool (`Bash`). The OS-level process blocks at $0 token cost and automatically wakes you upon task completion. **Manual LLM polling loops and exploratory file reading while waiting are strictly prohibited**.
3. **Universal Vision & Multimodal Invariant**:
   - Local Qwen runs in pure text mode (`--language-model-only`). Never pass image paths or visual inspection tasks to `qwen_coworker`.
   - In Plan Mode (GLM-5.3), visual inspection is prohibited; analyze text source code, data formats, and configs directly.
   - In Execution Mode (5.3-flash), the orchestrator inspects visual outputs directly, extracts design tokens or visual defects into structured text, and passes textual specifications to the coworker.
   - Never read binary files (`.pdf`, `.png`, `.jpg`, `.webp`, …) on a text-only orchestrator or engine: binary bytes are not valid text payloads and invalidate the model transcript. The Anser harness enforces this invariant with an immediate magic-number fail-fast (`BinaryFileError`) on coworker-side reads. Inspect binary outputs using native multimodal vision, or extract plaintext via shell utilities (`pdftotext`, `strings`).
   - **Document & Academic Paper Review Protocol (PDF vs. Source Ground Truth)**:
     - **Compiled Artifact vs. Ground Truth**: A compiled document (`.pdf`, `.docx`) is a build artifact, NOT the primary editable ground truth. The true ground truth lives in the project's **text source files**: LaTeX (`.tex`), BibTeX (`.bib`), raw data tables (`.csv`/`.tsv`), figures generation scripts (`.py`), or markdown (`.md`).
     - **Dual Review Division**:
       1. **Visual & Aesthetic Review**: Inspect rendered PDF pages, figure geometry, layout overlaps, and typography directly using native multimodal vision.
       2. **Content, Citation, Math, & Data Review (Coworker @ $0)**: Direct Qwen to inspect underlying plaintext source files (`.tex`, `.bib`, `.csv`, `.py`). Offload focused slices: cross-reference citation tags against `.bib`, verify claims against data tables, and check equations in `.tex`. Never pass binary files to Qwen; always point Qwen to text sources.
       3. **Locating Source Coordinates**: If the user only names the compiled binary (`paper.pdf`), Turn 1 Coworker slice locates the document sources (`find . -name "*.tex" -o -name "*.bib"`) or build scripts, returning the exact source coordinates to the orchestrator.
4. **Ground Truth Hierarchy**:
   - Ground truth consists exclusively of active source code, configuration files, raw data matrices, test suites, and verifiable build artifacts.
   - Secondary documentation, historical audit reports, and markdown notes are reference ledgers, not executable ground truth. Claims and invariants must be validated against current source code and live test runs.
5. **Autonomous Lifecycle (Zero Manual Probing)**:
   - The MCP infrastructure automatically manages server startup, canary probes, prefill warmup, and self-healing.
   - Never execute manual health checks, network probes (`curl localhost:18020`), or scratch scripts prior to dispatching.
6. **Honest Attribution**:
   - Never use "We" or claim coworker collaboration unless a `qwen_coworker` MCP call was genuinely dispatched and its completed output incorporated.
7. **Deterministic Line-Ending Management**:
   - Line endings are deterministically enforced repository-wide by `.gitattributes` (`* text=auto eol=lf`).
   - `edit_file` automatically normalizes newlines and preserves the file's existing line-ending format. `apply_patch` normalizes newlines to LF per repository `.gitattributes` (`* text=auto eol=lf`).
   - Autonomous agents must never squander prompt tokens, cognitive budget, or context space on superstitious line-ending warnings or chanting in LLM dispatches.
8. **Fail-Fast, Zero-Masking Engineering Invariant**:
   - Do not cater to fallbacks or use overly defensive engineering; errors are useful and provide valid signals.
   - NEVER silently catch, suppress, or discard errors.
   - NEVER mask upstream HTTP status codes (e.g. 400 Bad Request, 500 Internal Error) or wrap downstream engine errors into synthetic assistant completions.
   - When an upstream service, parser, or subprocess fails, surface the unadulterated error status and stack trace immediately.
9. **High-Reasoning Compute & Unaltered Deliberation (`reasoning_effort`)**:
   - Local Qwen defaults to balanced deliberation (`reasoning_effort: "medium"`), optimizing execution speed and avoiding reasoning-token bloat during routine tasks, file editing, and test runs.
   - High-reasoning compute (`reasoning_effort: "xhigh"`) is strictly **explicit-only**: reserve it for deep root-cause debugging, complex architectural proofs, or intricate algorithmic/AST refactors.
   - NEVER inject artificial stop-thinking or landing directives (e.g. "wrap up now", "stop deliberating") into continuation turns. Deliberation must conclude naturally based on internal problem resolution.
   - If token budget is exhausted during reasoning, the runtime fails fast with an explicit `reasoning_budget_exhausted` status rather than synthesizing a truncated completion.
10. **Multi-Instance Concurrency & Live-Owner Invariant**:
    - Multiple MCP client sessions (Claude Code and Antigravity) share the `MAX_SEQS=1` GPU engine and `~/.qwen/` state directory.
    - All engine boot and heal operations are serialized via atomic `O_EXCL` file locks with Rename-to-Tombstone recovery.
    - An active slot lease is NEVER stolen while its owner PID is alive (`pidAlive(lease.pid)` is true).
    - Stream proxy listener port (18022) is verified for `{ service: "mcp-qwen-stream-proxy" }` identity before any lifecycle signal is sent; unverified alien processes trip `PortConflictError` immediately.
11. **Pre-Flight File Hoarding Prohibition**:
    - Following multimodal visual inspection, the orchestrator is strictly prohibited from running repetitive `Read`/`Glob` calls to ingest raw source files wholesale into cloud context.
    - The orchestrator translates visual defects into behavioral requirements and AST coordinate targets; Qwen performs local code inspection and AST surgery directly at $0 token cost.

---

## 3. Conversational Pair-Programming Cadence (Anti-Monolithic Discipline)

The coworker is an interactive, conversational pair-programmer, NOT a one-shot batch processor. Drive the coworker like a senior tech lead pairing with an autonomous staff engineer:

### 1. Single Logical Concern per Turn
- **Cohesive Architectural Scope**: Scope each conversational dispatch to **a single logical subsystem, layer, or component** (e.g. Turn 1: "Data Schema & Storage Layer", Turn 2: "Domain Logic & Actions", Turn 3: "API Endpoints & Controllers", Turn 4: "Test Suite & Verification").
- **Never Dump Monolithic Mega-Prompts**: Bundling multiple disjoint subsystems across an entire project into a single prompt forces the coworker into excessive sequential tool calls, creating an unobservable black box and degrading speculative decoding performance.
- **Prompt-Level Scoping Only**:
  - The Lead Architect scopes the PROMPT itself so the problem space is small, cohesive, and clearly bounded.
  - **NEVER prompt Qwen to artificially limit its tools or self-manage time.** Do NOT include phrases like "keep tool calls low", "stay under N actions", or "narrow your focus".
  - Once dispatched with a cleanly bounded objective, Qwen operates with **Full Objective Fulfillment**—taking as many tool actions and iterations as needed to thoroughly accomplish the deliverable without premature truncation.
- **Large File Slicing**: When modifying large files (>300 LOC), direct the coworker to the specific function, component, or AST slice (e.g. `target: worker.ts#routeMessage`) rather than asking it to inspect the whole file.
- **Prompt Budget**: Keep instructions **≤1,500 characters** with **one deliverable per dispatch**. Point at files and coordinates; never paste content the coworker can read locally.

### 2. Session Lifecycle & Speculative Decoding Decay Threshold
- **Milestone-Based Session Cohesion**: Reuse one `session_id` across a cohesive milestone; the engine's prefix cache makes follow-on turns nearly free, so accumulated session size alone is not a reason to roll.
- **Roll Triggers**: Roll to a fresh `session_id` (e.g. `<milestone>_stage2`) only on a milestone change, session history poisoning tool habits, or **~60–80 turns**. Never roll mid-task.

### 3. Architectural Specification Contract (Anti-Spoon-Feeding)
- **Architectural Framing, Not Code Buffering**: The Lead Architect acts as a technical lead and system architect, NOT a copy-paste code buffer.
- **Dispatch Specification Elements**: Dispatches must specify:
  1. Target file and AST slice/component/function coordinate (e.g. `target: worker.ts#routeMessage`).
  2. Functional requirement, interface contract, and invariant boundaries.
  3. Failure condition, reproduction steps, or compiler error trace.
  4. Acceptance criteria and verification command (e.g. `npm run test:slice`).
  5. Numeric acceptance targets for layout/geometry/visual-quality work (e.g. "zero `get_tightbbox()` overlaps", "margin >= 12pt") — subjective descriptors ("make it look balanced") force unbounded measurement probe loops; objective numeric targets are required.
- **Verbatim Code Spoon-Feeding Prohibition**: The Lead Architect is **STRICTLY PROHIBITED** from writing out verbatim multi-line code implementations, full JSX component blocks, or replacement functions in coworker prompts. Local Qwen operates with 245K context and high-reasoning compute (`reasoning_effort: "xhigh"`); Qwen authors the code locally.
- **Harness-Enforced Guardrails (Anser)**: the harness mechanically enforces what this protocol prescribes — Single-Pass Mutation is built into the static system prompt to maximize vLLM prefix cache (APC) reuse; consecutive non-mutating `bash` probing beyond budget (default 4, `QWEN_PROBE_BUDGET`) injects an advisory and emits `probe_budget_warning`; oversized prompts (>1,500 chars) are fail-fast rejected at the MCP gateway (`MonolithicDispatchRejected`) to enforce single-concern scoping without code spoon-feeding; session rollover advisories fire at 60 turns (`session_warning`) and 80 turns (`SessionTurnLimitRecommendation` appended in-band); turn ceiling (100 turns) triggers Cooperative Landing (tools stripped, mandatory synthesis requested, returning `completed_budget_exhausted` with a structured advisory banner rather than hard killing); binary reads fail fast with `BinaryFileError`. Protocol docs instruct; the harness enforces.

### 4. Ground-Truth & Verification Discipline
- **Session events are ground truth; planner transcripts are intent ledgers.** Before diagnosing a "duplicate" or a "stale task", or re-dispatching, verify against `~/.qwen/sessions/<id>/events.jsonl` and `~/.qwen/tasks/*.json`.
- **Cross-OS State Paths**: State is unified across Windows (`C:\Users\<user>\.qwen\`) and WSL (`/mnt/c/Users/<user>/.qwen\`, symlinked from `~/.qwen`). All tasks execute inside the in-process Anser microkernel.
- **Claim→Verify pairs**: Confirm anomaly and corruption-class findings with an adversarial verification slice before they enter any report, manifest, or commit message.
- **Workspace Scratchpads over Mental Hoarding**: Abolish "write no files" restrictions for complex audits or batch verifications. When analyzing logs, tables, or multi-claim datasets, the coworker is explicitly encouraged to write intermediate extraction scripts and dump structured data tables to the sanctioned workspace scratchpad (`<workspace>/.scratch/` or repository-local helper scripts). Never force the model to mentally hoard raw multi-file matrices in deliberation context. The final slice deliverable is synthesized concisely back to the Lead Architect.
- **Collaborative Inquiries & Two-Way Alignment**: The coworker is an interactive pair-programmer and senior peer, not a blind execution tool. The Lead Architect invites the coworker's technical assessment, architectural critique, and feasibility checks before large mutations. When encountering ambiguous specs, contradictory data across files, edge cases, or flawed assumptions in orchestrator instructions, the coworker halts ungrounded deliberation, provides grounded counter-evidence and trade-offs, and proposes cleaner alternatives for the Lead Architect to steer rather than blindly mutating code or burning reasoning tokens in solitary thought loops.
- **Effort tiers are a per-dispatch knob**: `reasoning_effort` (default `medium`) — tier up consciously to `xhigh` only when deep deliberation is genuinely required. Never suppress silently.

---

## 4. Execution-First Mutation Protocol

1. **Direct Action on Target Scope**:
   - Mutation turns are for code editing, not open-ended re-auditing. Direct the coworker straight to the target component slice.
   - **No Dependency Spelunking**: Do NOT inspect `node_modules`, `.venv`, `vendor`, or `target` directories unless a concrete compiler/runtime error specifically demands type inspection.
2. **Telemetry-Grounded Supervisory Check-Ins (Claude Code 550s Safety Buffer)**:
   - Active, streaming tasks are protected by an automatic Inactivity Watchdog against true hangs; they are never killed by arbitrary wall-clock timers.
   - **Claude Code 600s Tool Timeout Defense**: Claude Code enforces a strict 600-second (10-minute) tool-call timeout. Running an unbounded or 3,000s curl command causes Claude Code to prematurely abort or background the tool call.
   - Use a bounded wait command with `--max-time 550` (9m 10s, granting a 50-second safety cushion under Claude Code's 600s tool limit):
     ```bash
     curl -fsS --max-time 550 --retry 5 --retry-delay 2 --retry-connrefused http://127.0.0.1:18021/task/<id>/wait
     ```
   - If the task is still executing after 550s, `curl` exits cleanly with code 28 (timeout).
   - On timeout wakeup (exit code 28), Claude Code samples telemetry via `qwen_task(action: "status")` (`toolCallsCount`, `fileOps`, `lastActivitySecAgo`) to verify forward progress, and immediately re-arms another `--max-time 550` wait window.
   - **Never cancel healthy work**: A cancel destroys 100% of an in-flight task's accumulated context and tool progress. Cancel only on explicit user instruction, budget exhaustion, or a confirmed wedge (heartbeat stale beyond the inactivity window AND zero tool-call progress).
   - **Telemetry before any kill**: Advancing `toolCallsCount` means healthy regardless of wall-clock age. Silence in the orchestrator transcript is not evidence of death; verify from session events.

---

## 5. Verification & Version Control Protocol

1. **Incremental Milestone Verification**:
   - Verify changes after each component batch with targeted typechecks or test runs.
   - Run the full project test suite and build validation before concluding the milestone.
2. **Mandatory Audit Manifest & Reconciliation Gate Invariant**:
   - The orchestrator maintains a structured audit manifest (`AUDIT_MANIFEST.md` or JSON) in cloud context, populating persistent tracking IDs (`F-1`, `F-2`, ...) as findings and regressions are uncovered across Qwen's systematic exploration slices.
   - **Zero-Tolerance Closure Gate**: Before declaring milestone completion or executing git commits, the orchestrator must conduct an explicit reconciliation pass against the manifest. 100% of findings must be verified and cataloged as `[RESOLVED: commit_sha / verified_slice]`, `[DEFERRED: tracked_issue_id]`, or `[WONTFIX: technical_rationale]`. Committing or closing with forgotten or unaddressed findings trips an immediate milestone failure.
3. **Mandatory Git Protocol**:
   - Inspect `git status` prior to and following modifications.
   - Produce clean, conventional atomic git commits (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`) and push to remote tracking branches.

---

## 6. MCP Tool Calling Reference (Zero-Discovery Invariant)

Use these explicit schema definitions directly for all lazy-loaded `qwen38-local` tools:

### `qwen_coworker` (Autonomous Execution Coworker)
- **`prompt`** (string, required): Task, inquiry, or architectural instruction for Qwen (pure text-only; images must be inspected natively by Lead Architect and summarized into text).
- **`cwd`** (string, required for project tasks): Target workspace directory (e.g. `/path/to/project`). Always specify this explicitly.
- **`session_id`** (string, optional): Named persistent session ID (e.g. `auth_middleware_v1`).
- **`reasoning_effort`** (string, optional): `"xhigh"`, `"medium"` (default), or `"low"`.
- **`extensions`** (array of strings, optional): Optional stdio MCP server commands for additional tools (note: live web search & fetch are natively built into Anser).
- **`skills`** (array of strings, optional): Explicit list of skill names to inject.
- **`test_command`** (string, optional): Verification test/benchmark command (e.g. `pytest tests/test_core.py`).
- **`timeout_ms`** (number, optional): Task timeout in ms (default 14,400,000ms / 4 hours, min 600,000ms).

### `qwen_task` (Background Task & Telemetry Management)
- **`action`** (string, required): `"status"` | `"cancel"` | `"kill"` (alias for cancel) | `"cancel_all"` | `"list"`.
- **`task_id`** (string, optional): Target task ID (required for `"status"`, optional for `"cancel"`/`"kill"`).

### `qwen_server` (vLLM Engine Lifecycle)
- **`action`** (string, required): `"status"` | `"start"` | `"stop"`.
- **`force`** (boolean, optional): Force stop even if a task is actively executing (only on user request).

