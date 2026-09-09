# mcp-anser

Unified local Qwen3.8-27B Anser agent harness & MCP server. Exposes the
Qwen3.8-27B coworker (vLLM + DFlash2 + KVarN, 245K context) to two runtimes:
**Claude Code CLI** and **Google Antigravity IDE**.

- In-process Anser microkernel with reversible plugin mount/unmount
- Structural AST surgery via `@ast-grep/napi` (in-process) + CLI fallback
- 137-vector zero-trust containment (123 attack vectors blocked, 14 allow vectors)
- Closed-loop evolutionary optimization (`.evo/lineage.json`)
- Zero-turn OS-level wait (`curl` long-poll on `:18021` saving ~590M tokens)
- Engine wedge detection + auto-heal
- Full 33-suite test gate (`npm run test:all`) validated live with zero skips

## Quickstart

### Claude Code CLI

```bash
claude mcp add --scope user qwen-anser node <repo-root>/mcp-qwen/index.js
```

The server registers three tools: `qwen_coworker`, `qwen_task`, `qwen_server`.
On first dispatch the vLLM engine boots automatically (up to 180s) and the
stream proxy starts on `:18022`.

### Google Antigravity IDE

```bash
python update_schemas.py
```

This writes the three tool JSON schemas + `instructions.md` into
`~/.gemini/antigravity-ide/mcp/qwen38-local/` (both Windows and WSL copies)
and verifies the `mcp_config.json` entries. Re-run after any schema change in
`src/tools.js`.

## Module Map

| File | Purpose |
|------|---------|
| `index.js` | MCP server entry: registers 3 tools, lifecycle handlers, `isMain` guard |
| `src/config.js` | All constants + env-var parsing (ports, timeouts, budgets) |
| `src/platform.js` | Platform abstraction: WSL/Windows path translation, shell resolution, spawn-profile builder |
| `src/wsl_bridge.js` | WSL bridge: path translators, `canonicalizePath`, `killProcessTree` (anchored sweep + verify) |
| `src/semaphore.js` | Cross-process goose slot semaphore (disk-lease, O_EXCL claim, heartbeat, reclaim) |
| `src/task_registry.js` | Task registry + HTTP status server (`:18021`): long-poll wait, cancel, orphan detection |
| `src/server_lifecycle.js` | vLLM lifecycle: boot, wedge detection (stats silence + canary), auto-heal, stream-proxy ensure |
| `src/tools.js` | MCP tool registration: `qwen_coworker`, `qwen_task`, `qwen_server` |
| `src/goose_runner.js` | Task dispatch: watchdog, Evo lineage |
| `src/skills.js` | Skills library: frontmatter parsing, keyword matching, budget-capped injection |
| `src/evo_engine.js` | Evo lineage engine (git-commit-based, `getLineageContext`, `extractMetric`, `recordCandidate`) |
| `src/repetition_detector.js` | Stateful SSE repetition detector (tiered char limits, block-level pattern) |
| `src/harness/runner.js` | Anser runner: agent loop, continuation, empty-stream guard, reasoning ceiling |
| `src/harness/core/kernel.js` | Anser microkernel: Context, plugin mount/unmount, tool registry, EventBus |
| `src/harness/core/events.js` | EventBus (typed event emission) |
| `src/harness/services/sandbox_fs.js` | Sandboxed FS: `read_file`, `write_file`, `edit_file`, `list_dir`, `search_code` |
| `src/harness/services/shell_executor.js` | Shell executor: `bash` / `exec_command` (POSIX routing, WSL, dry-run) |
| `src/harness/services/shell_validator.js` | Pure in-memory shell security validator (zero-exec enclave) |
| `src/harness/services/ast_service.js` | AST service: `ast_search`, `ast_replace`, `ast_replace_batch` (napi + CLI) |
| `src/harness/services/provider_vllm.js` | vLLM SSE streaming client (reasoning accounting, idle watchdog, ceiling) |
| `src/harness/services/mcp_bridge.js` | MCP extension bridge: spawns remote MCP servers, registers `ext_<server>_<tool>` |
| `src/harness/services/event_logger.js` | Append-only JSONL session event logger |
| `src/harness/evo/evo_operator.js` | Evo operator: `evo_propose/evaluate/select/revert_candidate`, `evo_status` |
| `src/harness/evo/lineage_dag.js` | Lineage DAG (`.evo/lineage.json`): candidate tree, fitness tracking |
| `src/harness/evo/evaluator.js` | Closed-loop metric evaluator (fitness score, failure digest) |
| `src/harness/evo/trace_repair.js` | Traceback condenser (≤100-token failure digest) |
| `src/harness/evo/watchdog.js` | Evo watchdog: stagnation breaker, token-velocity decay |
| `stream_proxy.js` | Universal stream proxy (`:18022`): UTF-8 reassembly, SSE keep-alive, multimodal guard, repetition breaker |
| `update_schemas.py` | Antigravity schema generator (writes JSON + instructions.md) |

## Dual-Runtime Quickstart

### Claude Code (stdio MCP)

```bash
# Register (one-time)
claude mcp add --scope user qwen-anser node <repo-root>/mcp-qwen/index.js

# In a Claude Code session, dispatch:
#   qwen_coworker(prompt="...", cwd="<repo-root>/my-project", session_id="task1")
#
# Long tasks yield a taskId + wait_command:
#   curl -s http://127.0.0.1:18021/task/<id>/wait
#
# Check status:
#   qwen_task(action="status", task_id="<id>")
#
# Engine lifecycle:
#   qwen_server(action="status")   # gauges, wedge state, canary
#   qwen_server(action="start")    # boot vLLM + stream proxy
#   qwen_server(action="stop")     # stop (refuses if tasks in flight)
```

### Antigravity IDE

```bash
# Generate schemas (one-time, re-run after schema changes)
python update_schemas.py

# Antigravity auto-discovers the MCP server from:
#   ~/.gemini/antigravity-ide/mcp/qwen38-local/
#   (both Windows C:\Users\... and WSL /home/... copies)
#
# Call via:
#   call_mcp_tool(serverName="qwen38-local", toolName="qwen_coworker", arguments={...})
```

## Environment Variables

All variables are read at process start (module-level) unless noted.

| Variable | Default | What it does |
|----------|---------|--------------|
| `VLLM_PORT` | `18020` | vLLM engine port |
| `STATUS_PORT` | `18021` | Task status HTTP server port (long-poll wait, cancel) |
| `STREAM_PROXY_PORT` | `18022` | Stream proxy port (used by `src/config.js` for the provider) |
| `VLLM_PROXY_PORT` | `18022` | Stream proxy listen port (used by `stream_proxy.js`) |
| `VLLM_PROXY_HOST` | `127.0.0.1` | Stream proxy bind address (loopback only; WSL2 forwards it to the Windows host) |
| `QWEN_STATE_DIR` | `~/.qwen` (or WSL-mapped Windows home) | Root for task JSON, slot leases, session logs, wedge counter |
| `QWEN_MAX_TOKENS` | `49152` | Per-turn output token budget |
| `QWEN_MAX_REASONING_TOKENS` | `32768` | Per-turn reasoning (thinking) token ceiling; hit → `finish_reason: "length"` |
| `QWEN_STREAM_IDLE_TIMEOUT_MS` | `900000` (15 min) | SSE stream idle watchdog (first-byte + inter-chunk) |
| `QWEN_REASONING_EFFORT` | *(unset)* | Passed to vLLM `chat_template_kwargs.reasoning_effort` |
| `QWEN_RACE_MS` | `45000` | Client-side race deadline before yielding `taskId` + `wait_command` |
| `QWEN_MIN_TIMEOUT_MS` | `600000` (10 min) | Floor for task timeout |
| `QWEN_INACTIVITY_TIMEOUT_MS` | `1800000` (30 min) | Goose subprocess inactivity watchdog |
| `QWEN_FIRST_TOKEN_TIMEOUT_MS` | `240000` (4 min) | Zero-output kill threshold after spawn |
| `QWEN_MAX_CONCURRENT` | `1` | Global goose slot count (cross-process, disk-lease) |
| `QWEN_MAX_TURNS` | *(null = unbounded)* | Max agent turns per dispatch |
| `QWEN_MAX_CONTINUATION_TURNS` | `8` | Max re-prompts after `finish_reason: "length"` |
| `QWEN_EMPTY_STREAM_RETRIES` | `2` | Retries for empty/zero-byte generations before honest failure |
| `QWEN_WEDGE_SILENCE_S` | `120` | Engine stats silence threshold (seconds) for wedge declaration |
| `QWEN_AUTO_HEAL` | `true` (disable with `0`) | Auto-reboot wedged engine |
| `QWEN_LOG_PATH` | `/tmp/mcp_launch_huge.log` | vLLM engine log path (for stats-line wedge detection) |
| `QWEN_WSL_DISTRO` | `Ubuntu` | WSL distro name |
| `QWEN_WSL_USER` | *(probed via `whoami`)* | WSL user |
| `QWEN_WSL_HOME` | `/home/<user>` | WSL home directory |
| `QWEN_WIN_HOME` | `os.homedir()` | Windows host home |
| `QWEN_WIN_HOME_WSL` | *(derived from `QWEN_WIN_HOME`)* | Windows home as seen from WSL (`/mnt/c/Users/...`) |
| `QWEN_GOOSE_BIN` | *(probed via `which`/`where`)* | Goose executable path |
| `QWEN_POSIX_SHELL` | *(probed: Git Bash, then PATH)* | POSIX shell for the `bash` tool |
| `QWEN_SHELL_MODE` | *(unset = POSIX)* | Set to `cmd` to force `cmd.exe` instead of bash |
| `QWEN_SHELL_DRY_RUN` | *(unset)* | Set to `1` to simulate shell commands (no spawn) |
| `QWEN_FORCE_WSL` | `true` on Windows (disable with `0`) | Force WSL execution for non-WSL cwds |
| `QWEN_STREAM_PROXY_PATH` | *(derived from `import.meta.url`)* | WSL-side path to `stream_proxy.js` |

## Extensions Guide (P8 Bridge)

The `qwen_coworker` tool accepts an optional `extensions` array. Each entry is
a string (e.g. `"npx -y @upstash/context7-mcp"`) or a structured object
(`{ command, args, name? }`).

**How it works:**

1. **Normalization** — `normalizeExtensionSpec()` in `src/harness/services/mcp_bridge.js`
   tokenizes the string into an argv array (no shell), derives a server name
   from the last non-flag token, and sanitizes it to `[a-z0-9_]`.
2. **Spawn** — Each extension is spawned as a piped stdio child via
   `buildSpawnProfile()` (WSL or Windows mode). On Windows, bare package
   runners (`npx`, `uvx`) are resolved to absolute paths via `where.exe`
   first (Node's `spawn` cannot resolve `.cmd` shims without a shell).
3. **Handshake** — JSON-RPC over stdio: `initialize` →
   `notifications/initialized` → `tools/list`. Per-step timeout: 60s.
4. **Registration** — Each remote tool is registered on the Anser Context as
   `ext_<server>_<tool>` (e.g. `ext_context7_mcp_get_library_docs`).
   Per-server tool cap: 64.
5. **Lifecycle** — The bridge is booted **before** the agent loop (so tools
   are visible on the first turn) and disposed in the runner's `finally`
   block (process-tree kill + tool unregistration). A module-level
   `LIVE_BRIDGES` registry ensures `disposeAllBridges()` in `index.js`
   reaps any surviving children on process shutdown.

**Never throws:** bad specs or failed handshakes are logged to stderr and
skipped; they cannot take down the dispatch.

## Skills Guide (P9)

Skills are reusable workflow recipes at `skills/<name>/SKILL.md`.

**Frontmatter format:**

```markdown
---
name: my-skill
description: One-line summary
keywords: [keyword1, keyword2, keyword3]
---
<workflow body in markdown>
```

**Matching:** `matchSkills({ prompt, cwd })` in `src/skills.js` performs a
case-insensitive substring match of each keyword against both the prompt text
and the cwd path string. A repo named `evo` triggers the `evo` skill.

**Budgets** (enforced in `matchSkills`):
- `MAX_SKILLS = 3` — at most 3 skills injected per dispatch
- `MAX_BODY_CHARS = 2000` — per-skill body truncation
- `MAX_TOTAL_CHARS = 6000` — total injected budget

**Injection:** `injectSkills(prompt, cwd)` appends a delimited block
(`--- Matching skills (auto-injected from skills/) ---`) to the prompt only
when matches exist. Never throws; malformed skills are skipped with a stderr
note.

**Shipped skills (4):**

| Skill | Keywords |
|-------|----------|
| `evo-mutation-rollback` | rollback, revert, mutation, regression, snapshot, candidate |
| `canary-test-staging` | canary, smoke test, staging suite, test gate, narrow test, targeted test |
| `hypothesis-generation` | hypothesis, evo, fitness, benchmark, optimization, candidate, lineage |
| `traceback-condensing` | traceback, stack trace, error digest, trace_repair, assertion failure, pytest, failed test |

## Security Model

Five-layer containment, all fail-closed:

1. **Path/symlink containment** (`src/harness/services/sandbox_fs.js`,
   `src/harness/services/ast_service.js`): every path is canonicalized
   through `fs.realpathSync` (resolves NTFS junctions + POSIX symlinks),
   then compared against the canonical root. `PathEscapeError` on `..`
   traversal; `SymlinkEscapeError` when a symlink inside the workspace
   resolves outside.

2. **Null-byte rejection** (`NullByteError`): any `\0` in a path is
   rejected before normalization.

3. **Device-name rejection** (`DeviceNameError`): Windows reserved names
   (`CON`, `PRN`, `AUX`, `NUL`, `COM1-9`, `LPT1-9`) are blocked.

4. **Shell validator & isolation** (`src/harness/services/shell_validator.js`,
   `src/harness/services/shell_executor.js`):
   pure in-memory, zero-execution enclave protecting against 15 evasion classes:
   - **Pattern-level blocks**: `mkfs`, `fdisk`, `parted`, `format X:`,
     `dd of=/dev/...`, fork bomb.
   - **Chain/delimiter splitting**: `;`, `&&`, `||`, `|`, newlines — every
     segment is recursively segmented and analyzed, not just the first.
   - **Wrapper unwrapping**: `sudo`, `doas`, `env`, `nice`, `nohup`,
     `xargs`, `bash -c`, `cmd /c`, `powershell -Command` (bounded depth 4).
   - **Unexpanded-reference rejection**: `$VAR`, `${VAR}`, `$(cmd)`,
     backticks in destructive operands → `CommandSecurityError`.
   - **Tilde expansion**: `~`, `~/`, `~user`, `~root` resolved via platform resolvers.
   - **Homoglyph defense**: NFKC normalization folds fullwidth/compatibility
     forms to ASCII before protected-root comparison (`\uFF37indows` -> `Windows`).
   - **Protected roots**: `/`, `/root`, `/home`, `/home/<user>`, all
     `/mnt/a-z`, `/mnt/c/windows`, `/mnt/c/users`, `/mnt/c/program files`,
     WSL home, Windows home (as `/mnt/c/Users/...`), raw device names.
   - **Flag disambiguation**: Windows `/s /q /f` recognized as flags,
     not path operands. `--name=value` flag values treated as operands.
   - **ANSI color isolation** (P14, vector `b4`): `shell_executor.js` strips
     color-forcing environment variables (`FORCE_COLOR`, `CLICOLOR`, `CLICOLOR_FORCE`)
     and injects `NO_COLOR=1` into child processes, preventing terminal escapes from
     polluting piped output under Claude Code. WSL-bound commands are additionally
     sanitized inside the bash payload (P15), since Windows-side env does not cross
     into WSL without `WSLENV`.

5. **Dead-man fuse** (`assertDeadManFuse`): a final pre-spawn barrier that
   re-checks pattern-level blocks and a synthetic canary token.

**`edit_file` guards & Rule 7** (`src/harness/services/sandbox_fs.js`):
- **Zero-occurrence**: target not found → explicit error, no write.
- **`AmbiguousTargetError`**: >1 occurrence without `replace_all` → refusal
  with count, no write (prevents code block duplication).
- **`LineEndingMismatchError` & Universal UNIX LF Invariant (Rule 7)**:
  exact match fails but CRLF-normalized match succeeds → explicit error, no write.
  All files across this workspace strictly use UNIX LF (`\n`). BPE tokenizers
  split `\r\n` into multiple tokens, degrading DFlash2 speculative decoding;
  `LineEndingMismatchError` halts mutations before disk contamination occurs.

**Syntax gates + rollback-on-invalid** (`src/harness/services/ast_service.js`):
every AST rewrite is written to disk, then validated by a language-specific
checker (TypeScript `transpileModule`, `node --check`, `python -c
"import ast; ast.parse(...)"`, `gofmt`, `rustfmt`, JSON parse). If the
checker reports invalid syntax, the file is **rolled back to its pre-rewrite
content**. When no checker is available, the gate degrades honestly
(`checked: false`) and logs a stderr note — it never reports an unchecked
rewrite as valid.

## Troubleshooting

### Engine wedge auto-heal + busy-gate

The engine runs `MAX_SEQS=1` (one generation at a time). While a task is
executing, a canary probe would queue behind the active generation and time
out — measuring queue depth, not health. The **busy-gate** in
`src/server_lifecycle.js` (`engineWedgeState`) reads `/metrics` gauges first:
when `running_requests > 0` or `waiting_requests > 0`, the canary is
**skipped** (`canary.skipped = "engine_busy"`) and wedge is declared from
stats-line silence alone (`>120s` without a new `Engine 000: ... Running:`
line in the engine log). When idle, the canary is authoritative.

On wedge detection, `healWedgedEngine` auto-reboots the engine (stop +
start), guarded by a cross-instance lock file (`.engine_heal.lock`, 5-min
TTL) and a **heal gatekeeper** that refuses to reboot while live work is in
flight (`hasLiveWork()` in `src/task_registry.js`).

### Orphaned tasks + `qwen_task cancel_all`

If the MCP server process dies, its tasks become orphans. On the next
`readTaskFromDisk`, `isTaskOrphaned` checks the owner PID liveness and
heartbeat age; orphans are marked `FAILED` with a `WORKER_PROCESS_TERMINATED`
error. `qwen_task(action="cancel_all")` kills each task's goose child via an
anchored per-session sweep (pgrep → `/proc` cmdline boundary verify → kill),
cancels all in-memory and disk tasks, and clears slot leases. (The old
machine-wide `taskkill /F /IM goose.exe` was removed in P15 — it killed other
instances' live goose children; the anchored sweep only matches a session id
at an exact `--name <id>` boundary.)

### Stream-proxy lifecycle

`ensureStreamProxyRunning` in `src/server_lifecycle.js`:
1. Probes `/health` (2 quick attempts).
2. **Targeted pre-spawn cleanup**: kills the current listener on the port by
   its specific PID (probed from `/health` or `ss -ltnp`), never a broad
   `pkill -f`.
3. Spawns the proxy (injected spawner for tests; real spawner uses
   `setsid` in WSL or detached `node` on Linux).
4. **15s health window** (75 × 200ms polls) with early-exit success.

### Reasoning loops

Three layers of defense:
- **Stream-proxy repetition breaker** (`src/repetition_detector.js`):
  detects literal character/phrase repetition in SSE deltas (both
  `delta.content` and `delta.reasoning`/`delta.reasoning_content`) and
  truncates the stream with a guard message.
- **Reasoning token ceiling** (`src/harness/services/provider_vllm.js`):
  when estimated reasoning tokens exceed `QWEN_MAX_REASONING_TOKENS`
  (default 32768), the stream is ended locally with `finish_reason: "length"`
  + `hadReasoning: true`, routing the runner into the reasoning-cutoff
  continuation directive ("stop deliberating, emit edits now").
- **Idle watchdog** (`src/goose_runner.js`): the legacy-goose path monitors
  vLLM token counters; if no tokens advance for the inactivity threshold,
  the subprocess is killed.

### Kill certainty

`killProcessTree` in `src/wsl_bridge.js`:
1. **Anchored session-id sweep**: `pgrep -f` lists candidates, then each
   candidate's `/proc/<pid>/cmdline` is verified to have the session ID at
   an exact boundary (space or end-of-line). A decoy that merely *contains*
   the ID as a substring is never killed.
2. **Direct child kill**: `taskkill /T /F` (Windows) or `SIGKILL` to the
   process group (Linux).
3. **Post-kill verification**: two liveness probes 500ms apart. If still
   alive, the kill is re-issued (escalation).
4. Returns `{ killed, escalations }` — a pid-less target is a no-op success
   (`killed: false, escalations: 0`), not a failure.

## Test Suite

`npm test` runs 28 suites (25 offline + 3 live/skip). `npm run test:all` runs all 33 suites (all must exit 0):

| # | Suite | Command | Type | Purpose |
|---|-------|---------|------|---------|
| 1 | `security.test.js` | `npm run test:security` | Offline | 137-vector containment (123 attack vectors blocked, 14 allow vectors; path, symlink, null-byte, device, shell chains/homoglyphs) |
| 2 | `canary.test.js` | `npm run test:canary` | Offline | Fast canary pilot: AST search/rewrite, syntax gate, traceback condenser, Evo eval |
| 3 | `ast_engine.test.js` | `npm test` | Offline | napi-vs-CLI equivalence (search + replace, byte-identical) |
| 4 | `ast_batch.test.js` | `npm run test:batch` | Offline | Batch replace (directory/glob target, dry_run preview) |
| 5 | `edit_file_guard.test.js` | `npm test` | Offline | edit_file guards: zero-occurrence, AmbiguousTargetError, LineEndingMismatchError |
| 6 | `evo.test.js` | `npm run test:evo` | Live / Skip | Full Evo system (kernel, sandbox, AST, shell, Evo, live vLLM; honest-skip offline) |
| 7 | `semaphore.test.js` | `npm run test:semaphore` | Offline | Cross-process goose slot semaphore (lease files in private temp dir) |
| 8 | `runner_continuation.test.js` | `npm run test:continuation` | Offline | Continuation-on-cutoff: length, empty-generation, reasoning-landing |
| 9 | `wedge_guard.test.js` | `npm run test:wedge` | Offline | Busy-gate + heal backstop (fully offline) |
| 10 | `platform.test.js` | `npm test` | Offline | Platform abstraction: WSL/Windows, spawn profiles, resolvers |
| 11 | `posix_routing.test.js` | `npm test` | Offline | POSIX shell routing: Git Bash resolution, array argv, QWEN_POSIX_SHELL |
| 12 | `path_canonicalization.test.js` | `npm run test:canonical` | Offline | Path canonicalization: NTFS junction (`D:\mnt\d`), symlink containment |
| 13 | `syntax_gates.test.js` | `npm run test:syntax` | Offline | Universal syntax gates: all languages checked or honestly degraded |
| 14 | `syntax_integrity.test.js` | `npm run test:syntax_integrity` | Offline | Syntax-integrity scan: `node --check` on every `.js` file in `src/` + `tests/` |
| 15 | `provider_reasoning.test.js` | `npm run test:reasoning` | Offline | Provider reasoning-token accounting & ceiling (offline SSE) |
| 16 | `mcp_bridge.test.js` | `npm run test:bridge` | Offline | MCP extension bridge (offline echo fixture, tool registration) |
| 17 | `skills.test.js` | `npm run test:skills` | Offline | Skills library: frontmatter, matching, budgets, injection |
| 18 | `reaping.test.js` | `npm run test:reaping` | Offline | Process-reaping: kill certainty, anchored sweep, decoy survival, proxy lifecycle |
| 19 | `mcp_client.test.js` | `npm test` | Live / Skip | MCP client integration (live engine; honest-skip offline) |
| 20 | `fifo_queue.test.js` | `npm test` | Live / Skip | FIFO queue semantics (live engine; honest-skip offline) |
| 21 | `stdio_purity.test.js` | `npm run test:stdio` | Offline | Zero-stdout-write invariant lock (stdio JSON-RPC purity) |
| 22 | `tool_errors.test.js` | `npm run test:tool_errors` | Offline | MCP-conformant tool-error envelopes (isError, no thrown exceptions) |
| 23 | `schema_parity.test.js` | `npm run test:schema_parity` | Offline | Schema drift lock: live-served zod schemas vs `update_schemas.py` JSON |
| 24 | `stream_proxy.test.js` | `npm run test:proxy` | Live / Mock | SSE stream proxy: repetition tiering, UTF-8 reassembly, real proxy regression |
| 25 | `utf8_proxy.test.js` | `npm run test:proxy` | Live / Mock | Multi-byte UTF-8 split across chunks reassembly verification |
| 26 | `benchmark.test.js` | `npm run test:benchmark` | Live / Skip | Head-to-head Evo vs legacy-Goose microkernel benchmark |
| 27 | `goose_runner_mapping.test.js` | `npm test` | Offline | status→isError mapping: `completed`/`completed_ceiling` = success, fail-closed on unknown/null |
| 28 | `lifecycle_locks.test.js` | `npm run test:all` | Offline | Exclusive lock acquire/reject/stale-recovery, PID-ownership release, atomic wedge counter |
| 29 | `signal_hardening.test.js` | `npm run test:all` | Offline | vLLM headroom clamping, `ContextExhaustedError`, `readTaskFromDisk` transientLock/ENOENT |
| 30 | `honesty_drift.test.js` | `npm test` | Offline | `listModels` honest error, corrupt-task quarantine, dead-constant culling |
| 31 | `lineage_integrity.test.js` | `npm test` | Offline | Per-workspace DAG singleton, version gate, honest legacy status mapping |
| 32 | `status_lifecycle.test.js` | `npm test` | Offline | Status-server keeper re-election, elapsed fix, cancel slot release, honest `stopServer` |
| 33 | `shell_hardening.test.js` | `npm test` | Offline | Shell-injection hardening (session-id charset, pgrep escape), credential honesty |

**Live-engine test gating**: Suites 6, 19, 20, and 26 use `tests/helpers/engine_probe.js` (`isEngineAvailable` / `requireEngineOrSkip`) to probe `/v1/models` with a 3s timeout. When vLLM is running, all 33 suites execute live; when offline, those four print `[SKIP]` and exit 0 (the remaining 29 run offline or against a mock upstream). Under active engine operation, `npm run test:all` runs all 33 suites with **zero skips and zero failures**.

## 11-Hour Production Verification & Telemetry Ledger

v5.1.0 was validated through an unbroken 11.25-hour multi-agent pair-programming session between Gemini 3.8 Flash (Meta-Supervisor in Antigravity), GLM-5.3-Flash / Claude Code (Lead Architect), and local Qwen3.8-27B (Execution Coworker).

### Empirical Engine & Hardware Telemetry

| Metric | Measured Value | Operational Rationale |
|--------|----------------|-----------------------|
| **vLLM Prefill / Prompt Tokens** | **56,312,194 tokens** | Ingested locally on RTX 3090 at $0 token cost |
| **vLLM Generation Tokens** | **1,749,192 tokens** | Codebase exploration, test runs, structural AST surgery |
| **Empirical Prefill Throughput** | **9,454.3 tok/s** | Average across 56.3M prompt tokens (prefix-cache hit rates reaching 8,000–9,500+ tok/s) |
| **Empirical Generation (Decode) Speed** | **58.2 tok/s** | Sustained pure decode throughput (mean TPOT 15.42 ms $\to$ **64.9 tok/s** instantaneous) |
| **Effective End-to-End Turn Speed** | **48.5 tok/s** | Round-trip throughput across conversation turns including prefill & tool handling |
| **Speculative Accepted Tokens** | **1,379,412 tokens** | **78.86% acceptance rate** via DFlash2 1.92B drafter |
| **Active Qwen Sessions** | **134 sessions** | Micro-session roll cadence preventing KV cache decay |
| **Logged Microkernel Events** | **6,140+ events** | Append-only session telemetry (`~/.qwen/sessions/`) |
| **Total Tool Executions** | **1,939+ calls** | Autonomous execution across Windows and WSL environments |
| **VRAM Footprint** | **24,136 MiB / 24,576 MiB** | Universal 245K context + KVarN k4v2 KV cache |
| **GPU Operating Temp** | **31°C - 58°C** | Steady thermal curve under 250W power limit |
| **Zero-Turn Wait Savings** | **~590M tokens** | Zero-turn HTTP long-poll (`:18021`) eliminated polling tax |

### 13-Hour Autonomous Production Marathon Telemetry (v5.2.0 End-to-End Overhaul — Sept 7, 2026)

In an unbroken 13.1-hour autonomous pairing session driving the full 6-phase frontend UI overhaul of an enterprise web application across Claude Code (GLM-5.3 / GLM-5.3-Flash) and local Qwen3.8-27B (Anser Coworker on RTX 3090), the stack delivered the following production metrics:

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

### The 14 Engineering Passes (P1–P14 Complete Implementation Map)

| Pass | Commit | Scope & Subsystem | Core Resolution & Verification |
|------|--------|-------------------|--------------------------------|
| **P1** | `8a05ccf` | Manifest & Registration Hygiene | Manifest-driven server identity, engine pin, README env reference |
| **P2** | `d241ff3`<br>`27727a7`<br>`bbc17c8`<br>`bb0f6d8` | Engine Liveness & Stream Resilience | Reasoning token accounting (`QWEN_MAX_REASONING_TOKENS=32768`), empty-stream retries, busy-gate wedge detection (`running_requests > 0`), cross-instance heal lock |
| **P3** | `fc55827` | Platform Abstraction | Single platform resolver (`src/platform.js`) + spawn-profile builder for Windows DrvFs and WSL2 |
| **P4** | `dcbfbe7`<br>`fb89fc3`<br>`3248c1f`<br>`5208f0c`<br>`86c1fbf`<br>`dc06624` | Shell Safety, POSIX Routing & Path Canonicalization | Path-aware protected roots, 15 shell evasion vectors closed (123 attack vectors blocked in `security.test.js`), `LineEndingMismatchError`, POSIX bash routing via Git Bash, universal LF `.gitattributes`, junction canonicalization via `realpathSync` |
| **P5** | `954443e` | In-Process AST Surgery | `@ast-grep/napi` native module integration with CLI fallback, byte-identical equivalence verified in `ast_engine.test.js` |
| **P6** | `a9d5174` | Universal Syntax Gates | Pre-commit syntax validation for JS, TS, Python, Go, Rust, JSON with rollback-on-invalid-syntax |
| **P7** | `cb0559f`<br>`5a68cdf` | AST Surface & Stream Hardening | `ast_replace_batch` tool, dry-run safety preview, repetition breaker extended to `delta.reasoning` (closing reasoning loop death class) |
| **P8** | `d94d4d8` | Generic MCP Extension Bridge | Dynamic stdio MCP extension spawning, argument tokenization, `ext_<server>_<tool>` registration, verified live with `@upstash/context7-mcp` |
| **P9** | `3e52bce` | Packaged Skills Library | Reusable workflow recipes (`skills/<name>/SKILL.md`), keyword matching against prompt and cwd, budget capping (3 skills / 2000 chars / 6000 total) |
| **P10** | `88efb97`<br>`b3c151e` | Process-Reaping Hardening | Anchored session-id sweep (`/proc/<pid>/cmdline`), decoy survival, double liveness probe with escalation, 15s stream proxy health window, test state dir isolation |
| **P11** | `8bde746` | Offline Test Resilience & Stdio Purity | Syntax integrity scan (`node --check` across all files), honest engine-down skips, stdio zero-stdout-write lock frame verification |
| **P12** | `9df8a73` | Dual-Runtime Parity Audit | MCP-conformant tool-error envelopes (`isError: true`), schema drift lock test (`tests/schema_parity.test.js`) asserting Antigravity JSON vs live zod schemas |
| **P13** | `6f217dd` | Architecture Documentation | Comprehensive production README rewrite and `docs/DESIGN.md` incident-wisdom distillation |
| **P14** | `a1dabdc` | Final E2E Verification & Release | Stripping color-forcing env vars (`FORCE_COLOR`, `CLICOLOR`) and setting `NO_COLOR=1` in `shell_executor.js` (vector `b4`), tag `v5.1.0`, full 26/26 test suites green |

## Version

**5.2.0** (tracked in `package.json` and git tag `v5.2.0` — the only current-version literal; the MCP server serves it from there). 5.1.0 consolidated all 14 engineering passes and complete 26-suite verification; 5.1.1 stabilized multi-instance lifecycle (anchored cancel sweeps, loopback proxy bind, retention invariant); 5.2.0 completes the Anser/Evo brand rename (engine core, evo subsystem, `.evo` data dir) and retires the legacy engine selection.

