# AGENTS.md — Anser

> **The vendor-neutral "README for machines."** This file is the canonical,
> machine-readable operating contract for any AI agent (Claude Code, Google
> Antigravity, Cursor, Codex, or a human) that reads, edits, tests, or
> optimizes this repository. It is the 2026 AAIF (Agentic AI Foundation)
> standard: a single source of truth that every agent persona must honor.
>
> **Precedence:** `AGENTS.md` > `CLAUDE.md` / `GEMINI.md` (persona-specific
> overlays) > `CONTRIBUTING.md` (human workflow) > `README.md` (marketing).
> If two files disagree, `AGENTS.md` wins and the discrepancy is a bug to file.

---

## 0. What This Repository Is

**Anser** is a local-first, **$0-token-cost** agent microkernel that lets a
high-reasoning cloud orchestrator (the *Lead Architect*) drive a locally-served
**Qwen3.8-27B** (245K context, vLLM + DFlash2 + KVarN) to do code exploration,
structural AST surgery, testing, and file editing — all inside a zero-trust
sandbox.

```
Lead Architect (cloud: Claude / Gemini / Antigravity)
        |  MCP over stdio - 3 consolidated tools
        v
mcp-qwen/  (Node.js MCP server + Anser microkernel)
        |  in-process V8 tool calls (0.01 ms) + zero-turn HTTP wait (:18021)
        v
vLLM engine (WSL2 / Linux, :18020)  ->  Qwen3.8-27B @ 245K
```

The **only** `package.json` lives in `mcp-qwen/`. There is **no root
`package.json`** — every `npm` command must be run with `--prefix mcp-qwen`
(or from inside `mcp-qwen/`).

---

## 1. Agent Personas

Three roles share this repo. Each has a distinct mandate; an agent must know
which one it is before acting.

| Persona | Runtime | Mandate | Hard Limits |
|---|---|---|---|
| **Lead Architect** | Cloud (Claude Sonnet / Gemini Flash in Antigravity) | Architecture, task decomposition, plan & manifest authorship, supervisory steering, final synthesis. | **Never** bulk-read source into cloud context; **never** author code; offloads exploration to the Coworker in single-concern slices. |
| **Autonomous Execution Coworker** | Local Qwen3.8-27B via Anser (`qwen38-local` MCP) | Hands-on execution: explore, AST surgery, edit, test, shell. Returns raw ground-truth facts. | **Pure text only** (`--language-model-only`); **never** vision; **never** authors high-level plans/roadmaps; **never** escapes the sandbox root. |
| **Autonomous Optimizer (Evo)** | Local, inside the Coworker | Closed-loop mutation: propose -> evaluate -> select/revert against a fitness metric. | **Snapshot before mutating**; **revert on regression**; never edits files outside the candidate's snapshot list. |

> **Honest attribution:** No agent may claim "we" or coworker collaboration
> unless a `qwen_coworker` MCP call was genuinely dispatched and its output
> incorporated.

---

## 2. Setup & Build Commands

All commands are **relative** — never hardcode a drive letter or home path.
`<repo>` = the root of your checkout.

### 2.1 Prerequisites
- **Node.js >= 20** (20 or 22; the CI matrix runs both).
- **Git** (leave `core.autocrlf` at default — `.gitattributes` pins LF).
- **Optional, for the full live stack:** a GPU with >= 24 GB VRAM, WSL2 (or
  native Linux), CUDA 12.4+, and a vLLM serving of Qwen3.8-27B on `:18020`.
  **You do NOT need a GPU to run the test gate** (see section 5).

### 2.2 Install
```bash
cd <repo>/mcp-qwen
npm ci          # deterministic; REQUIRED for the platform-specific @ast-grep
                # native binaries (linux-x64-gnu / win32-x64-msvc)
```
> Use `npm ci`, not `npm install`, so the lockfile resolves the correct
> `@ast-grep/napi` + `@ast-grep/cli` native binary for the runner OS.

### 2.3 Run the MCP server
```bash
node <repo>/mcp-qwen/index.js
```
Registers three stdio tools: `qwen_coworker`, `qwen_task`, `qwen_server`.
On first dispatch the vLLM engine boots (up to 180 s) and the stream proxy
starts on `:18022`.

### 2.4 Register with a client
```bash
# Claude Code
claude mcp add --scope user qwen-anser node <repo>/mcp-qwen/index.js

# Antigravity IDE (generate schemas into the IDE's MCP dir)
python <repo>/mcp-qwen/update_schemas.py
```

### 2.5 Key environment variables (all in `mcp-qwen/src/config.js`)
| Variable | Default | Meaning |
|---|---|---|
| `QWEN_RACE_MS` | `45000` | Sync race window before yielding to the zero-turn long-poll wait. |
| `QWEN_MAX_CONCURRENT` | `1` | Cross-process execution slots (disk-lease semaphore). |
| `QWEN_STATE_DIR` | `~/.qwen` | Root for task JSON, slot leases, session logs, Evo lineage. |
| `VLLM_PORT` | `18020` | vLLM OpenAI-compatible API. |
| `STATUS_PORT` | `18021` | Zero-turn long-poll HTTP wait/status server. |
| `STREAM_PROXY_PORT` | `18022` | Universal SSE streaming proxy (loopback only). |
| `TEST_OFFLINE` | *(unset)* | Set to `1` to force live suites to skip (GPU-less runs). |

---

## 3. Code Style & AST Patterns

### 3.1 Language & formatting
- **JavaScript (ESM)**: `"type": "module"`. 2-space indent, LF line endings,
  final newline, UTF-8 (enforced by `.editorconfig` + `.gitattributes`).
- **Python**: 4-space indent. **Go**: tabs. **Rust**: 4-space.
- **Line endings are a hard invariant** (Rule 7): `* text=auto eol=lf` in
  `.gitattributes`. `*.bat` / `*.cmd` are the only CRLF files. A CRLF leak in
  a text file trips `LineEndingMismatchError` in the test gate — do not
  "fix" it by hand; let `edit_file` auto-normalize.

### 3.2 Structural AST surgery (preferred over regex)
Use the AST tools, not string matching, for any syntactic refactor:
- `ast_search` — find code by pattern with metavariables
  (`function $NAME($$$ARGS) { $$$BODY }`).
- `ast_replace` — AST-verified node replacement; **syntax-validated before
  disk commit** (invalid rewrites are auto-rejected, file stays pristine).
- `ast_replace_batch` — same pattern/rewrite across a directory/glob; each
  file is syntax-gated and committed independently.
- For large-scale or multi-file surgery, run the `ast-grep` CLI directly via
  `bash`.

### 3.3 Edit primitives (complementary, not competing)
- `edit_file` — exact-substring, uniqueness-guarded, per-region line-ending
  preservation. Use for small, unambiguous replacements.
- `apply_patch` — unified-diff, multi-line/structural, 2 MB cap
  (`PatchTooLargeError`), pre-validates every in-patch path. Use for
  multi-hunk or structural changes.
- **Never** introduce a third fuzzy-matcher (Aider-style) — it was
  deliberately rejected (Issue #8).

### 3.4 Module layout (where new code goes)
```
mcp-qwen/
  index.js                 # MCP entry: 3 tools, lifecycle, isMain guard
  stream_proxy.js          # :18022 SSE proxy
  src/
    config.js              # ALL constants + env parsing (single source)
    platform.js            # WSL/Windows path translation, spawn profiles
    wsl_bridge.js          # path canonicalization, killProcessTree
    semaphore.js           # cross-process O_EXCL disk-lease
    task_registry.js       # :18021 long-poll wait, cancel, orphans
    server_lifecycle.js    # vLLM boot, wedge detection, auto-heal
    tools.js               # zod schemas + dispatch
    harness/
      runner.js            # agent loop, continuation, empty-stream guard
      core/                # microkernel: kernel.js, events.js
      services/            # sandbox_fs, shell_executor, ast_service,
                           #   provider_vllm, mcp_bridge, event_logger
      evo/                 # evo_operator, lineage_dag, evaluator,
                           #   trace_repair, watchdog
  tests/                   # 36 suites (see section 5)
```
**New tools** are in-process microkernel plugins under `src/harness/services/`
— never external CLI subprocesses (in-process = sub-millisecond).

---

## 4. Invariant Boundaries

### 4.1 ALWAYS
- **ALWAYS** run the test gate before committing (section 5).
- **ALWAYS** snapshot files (`evo_propose_candidate`) **before** any
  mutation; the snapshot is the rollback anchor.
- **ALWAYS** keep every path **relative** or env-driven (`QWEN_STATE_DIR`,
  `import.meta.url`). Never hardcode a drive letter, home dir, or username.
- **ALWAYS** write new filesystem/shell capabilities with matching boundary
  tests in `tests/security.test.js`.
- **ALWAYS** surface the unadulterated error (Rule 8: fail-fast, zero-masking).
- **ALWAYS** keep `CLAUDE.md` and `GEMINI.md` shared invariants
  byte-identical (locked by `tests/protocol_sync.test.js`).

### 4.2 ASK FIRST
- **ASK** before adding a new dependency (especially native/optional ones —
  they must be added to `optionalDependencies` with per-OS variants).
- **ASK** before changing any constant in `src/config.js` (ports, timeouts,
  budgets) — these are the contract with the orchestrator.
- **ASK** before touching the 5-layer sandbox, the semaphore, or the wedge
  detector (security-critical; needs a security review).
- **ASK** before adding a new MCP tool or changing a tool's zod schema
  (requires re-running `update_schemas.py` + the `schema_parity` gate).
- **ASK** before committing anything under `.evo/`, `.avo/`, or `*.log`
  (runtime scratch; gitignored; force-adding leaks machine paths).

### 4.3 NEVER
- **NEVER** let a file or shell operation escape the workspace root. The
  5-layer defense (PathEscape -> Symlink Realpath -> Root-Overwrite Guard ->
  Dangerous-Shell Filter -> AST Syntax Gate + Evo Rollback) is non-negotiable.
- **NEVER** route vision/image tasks to the local Qwen (`--language-model-only`).
- **NEVER** silently catch, suppress, or mask errors or upstream HTTP status
  codes (Rule 8).
- **NEVER** hand-edit line endings or "fix" CRLF by re-typing a file — use
  `edit_file` / `apply_patch`, which normalize deterministically.
- **NEVER** edit a file that is not in the active Evo candidate's snapshot
  list (those changes are not covered by rollback).
- **NEVER** weaken, skip, or delete a failing test to "unblock" the build.
  Fix the code, or file the defect — never the canary.
- **NEVER** commit secrets, credentials, or machine-identity paths
  (see `SECURITY.md`; the repo was scrubbed of these in `d2ed325`).

---

## 5. Verification Procedures

### 5.1 The test gate (the single source of truth)
There is **no root `package.json`** — always use `--prefix mcp-qwen`.

```bash
# Fast offline gate - 31 suites, no GPU needed. Run this FIRST.
npm run test --prefix mcp-qwen

# Full gate - 36 suites (superset of `test`). The authoritative pass/fail.
npm run test:all --prefix mcp-qwen

# GPU-less / CI: force the 4 live suites to skip honestly.
TEST_OFFLINE=1 npm run test:all --prefix mcp-qwen
```

**Suite truth (verified):**
| Command | Suites | Notes |
|---|---|---|
| `npm run test` | **31** | Fast fail-offline gate. |
| `npm run test:all` | **36** | Full superset; the CI pass/fail signal. |
| On-disk `.test.js` | **36** | Union of the two. |

**Live suites** (`evo`, `mcp_client`, `fifo_queue`, `benchmark`) need a
running vLLM on `:18020` + a 24 GB GPU. They **skip honestly** when
`TEST_OFFLINE=1` or the engine is offline — a skip is a pass, not a failure.

### 5.2 Canary-first staging (do not run the full chain first)
1. Identify or write **one** targeted test that exercises exactly the code you
   changed (a *canary*).
2. Run just that file: `node mcp-qwen/tests/<canary>.test.js`.
3. If green, run the next-narrower group (the module's related suites).
4. Only then run the full gate (`npm run test:all --prefix mcp-qwen`).
5. If a canary fails, **fix the code** — never weaken the canary.

### 5.3 Evo closed-loop (for optimizations/refactors)
1. `evo_propose_candidate` — snapshot target files **first** (rollback anchor).
2. Apply the mutation.
3. `evo_evaluate_candidate` — run the verification command, read the fitness
   score + compact failure digest.
4. **Select** (`evo_select_candidate`) if fitness improved and tests pass;
   **revert** (`evo_revert_candidate`) on regression or a real bug.
5. Confirm the revert restored the original bytes before continuing.

### 5.4 CI
`.github/workflows/ci.yml` runs the gate on every push/PR across a
**Node 20 & 22 x ubuntu-latest & windows-latest** matrix (4 jobs, no
fail-fast). It uses `npm ci` in `mcp-qwen/` and runs both `test` (31) and
`test:all` (36). A green CI is required before a PR is mergeable.

---

## 6. Security & Reporting

- The sandbox is a **zero-trust, 5-layer** defense-in-depth boundary
  (see `README.md` section 4 and `docs/audits/PATCHWORK_ADVERSARIAL_AUDIT_2026-09-05.md`).
- **Never** open a public issue for a security vulnerability. Report
  privately per [`SECURITY.md`](SECURITY.md).
- The 137-vector containment suite (`tests/security.test.js`: 123 attack
  vectors blocked, 14 allow vectors) is the regression net for the boundary.

---

## 7. Ground-Truth Hierarchy

1. **Active source code**, `package.json`, `tests/`, and build artifacts =
   ground truth.
2. `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `CONTRIBUTING.md` = operating
   contracts (verify against code before relying on them).
3. `docs/audits/*`, `README.md` benchmark tables, `NOTES.md` = **historical
   claim ledgers, NOT ground truth.** Never anchor a decision on a secondary
   claim without verifying the underlying code.

*Last verified against `main` @ `4e997f5` (CI + security policy + test
portability). Re-verify counts with `node -e` against `package.json` if the
gate changes.*
