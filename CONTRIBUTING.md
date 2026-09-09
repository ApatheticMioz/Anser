# Contributing to Anser

Thank you for your interest in contributing to **Anser** — the Universal 245K
Agent Microkernel for Local LLMs. This guide gives you a frictionless path from
clone to merged pull request.

> **Machine-readable contract:** AI agents (Claude Code, Antigravity, Cursor,
> Codex) should read [`AGENTS.md`](AGENTS.md) first — it is the canonical
> operating contract. This file is the human workflow.

---

## 1. Local Environment Setup

### Prerequisites
- **Node.js 22+** (22 or 24 — the CI matrix runs both active LTS versions).
- **Git** (leave `core.autocrlf` at default; `.gitattributes` pins LF).
- **Optional, for the full live stack only:** a GPU with >= 24 GB VRAM, WSL2
  (or native Linux), CUDA 12.4+, and a vLLM serving of Qwen3.8-27B on `:18020`.
  **You do NOT need a GPU to contribute** — the entire test gate runs offline.

### Clone & install
```bash
git clone https://github.com/ApatheticMioz/Anser.git
cd Anser/mcp-qwen
npm ci        # deterministic; resolves the correct @ast-grep native binary
```
> There is **no root `package.json`** — the only one lives in `mcp-qwen/`.
> Always run `npm` from inside `mcp-qwen/` (or with `--prefix mcp-qwen`).

### Optional: full live stack (GPU + vLLM)
To run the 4 *live* suites (or to actually drive the model), stand up a vLLM
serving of Qwen3.8-27B on `:18020` per the [README](README.md) quickstart.
Everything else works without it.

---

## 2. Running Tests (No GPU Required)

The test gate is the single source of truth. Run it **before** opening a PR.

```bash
cd mcp-qwen

# Fast offline gate - 31 suites. Run this FIRST.
npm test

# Full gate - 36 suites (superset of `test`). The authoritative pass/fail.
npm run test:all

# GPU-less / CI: force the 4 live suites to skip honestly.
TEST_OFFLINE=1 npm run test:all
```

**Suite truth:** `npm test` = **31** suites; `npm run test:all` = **36**
suites; 36 `.test.js` files on disk. The 4 *live* suites (`evo`,
`mcp_client`, `fifo_queue`, `benchmark`) need a running vLLM on `:18020` + a
24 GB GPU; they **skip honestly** when `TEST_OFFLINE=1` or the engine is
offline. A skip is a pass, not a failure.

### Targeted / canary runs
Run a single suite in isolation (fast, deterministic — no network):
```bash
node tests/security.test.js     # 137-vector zero-trust containment
node tests/canary.test.js       # AST search/replace, syntax gate, trace condenser
node tests/evo.test.js          # closed-loop evaluation & snapshot rollback
node tests/semaphore.test.js    # cross-process lease exclusion
node tests/schema_parity.test.js# Antigravity JSON vs live zod schema drift lock
```

**Canary-first discipline:** when you change code, write or pick the *one*
test that exercises exactly that change, run it alone, then widen to the
module's related suites, and only then run the full gate. If a canary fails,
fix the code — never weaken the canary to make it pass.

### Cross-platform
The gate runs identically on **Windows 11** and **WSL2 / Linux**. Verify on
both when you touch path handling:
```bash
# From a Windows host, into WSL:
wsl -e bash -c "cd <repo>/mcp-qwen && npm test"
```

---

## 3. Architecture Overview

Anser is a **microkernel** with a small set of well-bounded services. New
capabilities slot into the existing layout rather than adding new top-level
pieces.

```
Lead Architect (cloud: Claude / Gemini / Antigravity)
        |  MCP over stdio - 3 consolidated tools
        v
mcp-qwen/  (Node.js MCP server + Anser microkernel)
  index.js            # entry: registers qwen_coworker / qwen_task / qwen_server
  src/config.js       # ALL constants + env parsing (single source of truth)
  src/platform.js     # WSL/Windows path translation, spawn profiles
  src/wsl_bridge.js   # path canonicalization, process-tree kill
  src/semaphore.js    # cross-process O_EXCL disk-lease (MAX_CONCURRENT=1)
  src/task_registry.js# :18021 zero-turn long-poll wait, cancel, orphans
  src/server_lifecycle.js # vLLM boot, wedge detection, auto-heal
  src/tools.js        # zod schemas + dispatch
  src/harness/
    runner.js         # agent loop, continuation, empty-stream guard
    core/             # microkernel: kernel.js, events.js
    services/         # sandbox_fs, shell_executor, ast_service,
                      #   provider_vllm, mcp_bridge, event_logger
    evo/              # evo_operator, lineage_dag, evaluator,
                      #   trace_repair, watchdog
  stream_proxy.js     # :18022 universal SSE streaming proxy
  tests/              # 36 suites
        |
        v
vLLM engine (WSL2 / Linux, :18020)  ->  Qwen3.8-27B @ 245K
```

**The four pillars:**
- **Microkernel (`mcp-qwen`)** — in-process V8 tool execution (0.01 ms),
  structural AST surgery via `@ast-grep/napi`, bounded traceback condenser.
- **Harness services** — the zero-trust sandboxed filesystem, shell executor,
  and provider client under `src/harness/services/`.
- **Stream proxy** — `:18022` universal SSE proxy (UTF-8 reassembly,
  keep-alive, repetition breaker).
- **Guards** — the 5-layer zero-trust containment boundary, the cross-process
  semaphore, and the vLLM wedge detector + auto-heal.

**Where new code goes:** new tools are in-process microkernel plugins under
`src/harness/services/` — never external CLI subprocesses. New constants go in
`src/config.js`. New filesystem/shell capabilities ship with boundary tests in
`tests/security.test.js`.

---

## 4. Commit & Pull-Request Lifecycle

### Conventional Commits
We use [Conventional Commits](https://www.conventionalcommits.org/):
- `feat:` a new feature or capability.
- `fix:` a bug fix.
- `refactor:` restructuring without behavioral change.
- `test:` adding or updating test suites.
- `docs:` documentation updates and audit logs.
- `perf:` performance optimizations (latency, VRAM, throughput).
- `ci:` / `chore:` / `build:` for infrastructure, housekeeping, and packaging.

Example: `feat(harness): harden search, edit, patch guards and establish protocol sync gate`.

### PR checklist
Before requesting review, confirm:
- [ ] `npm run test:all --prefix mcp-qwen` is green (or `TEST_OFFLINE=1` for
      GPU-less runs) — **zero skipped canaries you introduced**.
- [ ] CI (`.github/workflows/ci.yml`) is green across the Node 20/22 x
      ubuntu/windows matrix.
- [ ] No hardcoded drive letters, home dirs, or usernames in any file
      (paths are relative or env-driven).
- [ ] No secrets, credentials, or machine-identity paths committed.
- [ ] New filesystem/shell capability has a matching test in
      `tests/security.test.js`.
- [ ] `CLAUDE.md` and `GEMINI.md` shared invariants remain byte-identical
      (locked by `tests/protocol_sync.test.js`).
- [ ] Line endings are LF (`.gitattributes` enforces; `*.bat`/`*.cmd` are the
      only CRLF files).
- [ ] Commit messages follow Conventional Commits.

### Review
- One logical concern per PR. Large changes should be split.
- A security-critical change (sandbox, semaphore, wedge detector) requires a
  security review before merge.
- The 36-suite gate + green CI are the merge gate; a red gate blocks merge.

---

## 5. Reporting Vulnerabilities

**Do not open a public issue for a security vulnerability.** Report it
privately per [`SECURITY.md`](SECURITY.md), which lists the supported
versions, the private reporting channel, and our response SLA. The 137-vector
containment suite (`tests/security.test.js`) is the regression net for the
zero-trust boundary.
