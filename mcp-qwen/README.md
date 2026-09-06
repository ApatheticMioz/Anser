# mcp-qwen v5.1.0

Unified local Qwen3.8-27B DeepSeek-AVO agent harness & MCP server. Exposes the
Qwen3.8-27B coworker (vLLM + DFlash2 + KVarN, 245K context) to two runtimes:
**Claude Code CLI** and **Google Antigravity IDE**.

- In-process Cordis microkernel with reversible plugin mount/unmount
- Structural AST surgery via `@ast-grep/napi` (in-process) + CLI fallback
- 90-vector zero-trust sandboxed filesystem
- Closed-loop evolutionary optimization (`.avo/lineage.json`)
- Zero-turn OS-level wait (`curl` long-poll on `:18021`)
- Engine wedge detection + auto-heal

## Quickstart

### Claude Code CLI

```bash
claude mcp add --scope user qwen-avo node D:/LLM_Ecosystem/mcp-qwen/index.js
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
| `src/config.js` | All constants + env-var parsing (ports, timeouts, budgets, engine selection) |
| `src/platform.js` | Platform abstraction: WSL/Windows path translation, shell resolution, spawn-profile builder |
| `src/wsl_bridge.js` | WSL bridge: path translators, `canonicalizePath`, `killProcessTree` (anchored sweep + verify) |
| `src/semaphore.js` | Cross-process goose slot semaphore (disk-lease, O_EXCL claim, heartbeat, reclaim) |
| `src/task_registry.js` | Task registry + HTTP status server (`:18021`): long-poll wait, cancel, orphan detection |
| `src/server_lifecycle.js` | vLLM lifecycle: boot, wedge detection (stats silence + canary), auto-heal, stream-proxy ensure |
| `src/tools.js` | MCP tool registration: `qwen_coworker`, `qwen_task`, `qwen_server` |
| `src/goose_runner.js` | Task dispatch: engine selection (deepseek_avo / legacy_goose), watchdog, AVO lineage |
| `src/skills.js` | Skills library: frontmatter parsing, keyword matching, budget-capped injection |
| `src/avo_engine.js` | AVO lineage engine (git-commit-based, `getLineageContext`, `extractMetric`, `recordCandidate`) |
| `src/repetition_detector.js` | Stateful SSE repetition detector (tiered char limits, block-level pattern) |
| `src/harness/runner.js` | DeepSeek AVO runner: Cordis agent loop, continuation, empty-stream guard, reasoning ceiling |
| `src/harness/core/kernel.js` | Cordis microkernel: Context, plugin mount/unmount, tool registry, EventBus |
| `src/harness/core/events.js` | EventBus (typed event emission) |
| `src/harness/services/sandbox_fs.js` | Sandboxed FS: `read_file`, `write_file`, `edit_file`, `list_dir`, `search_code` |
| `src/harness/services/shell_executor.js` | Shell executor: `bash` / `exec_command` (POSIX routing, WSL, dry-run) |
| `src/harness/services/shell_validator.js` | Pure in-memory shell security validator (zero-exec enclave) |
| `src/harness/services/ast_service.js` | AST service: `ast_search`, `ast_replace`, `ast_replace_batch` (napi + CLI) |
| `src/harness/services/provider_vllm.js` | vLLM SSE streaming client (reasoning accounting, idle watchdog, ceiling) |
| `src/harness/services/mcp_bridge.js` | MCP extension bridge: spawns remote MCP servers, registers `ext_<server>_<tool>` |
| `src/harness/services/event_logger.js` | Append-only JSONL session event logger |
| `src/harness/avo/avo_operator.js` | AVO operator: `avo_propose/evaluate/select/revert_candidate`, `avo_status` |
| `src/harness/avo/lineage_dag.js` | Lineage DAG (`.avo/lineage.json`): candidate tree, fitness tracking |
| `src/harness/avo/evaluator.js` | Closed-loop metric evaluator (fitness score, failure digest) |
| `src/harness/avo/trace_repair.js` | Traceback condenser (≤100-token failure digest) |
| `src/harness/avo/watchdog.js` | AVO watchdog: stagnation breaker, token-velocity decay |
| `stream_proxy.js` | Universal stream proxy (`:18022`): UTF-8 reassembly, SSE keep-alive, multimodal guard, repetition breaker |
| `update_schemas.py` | Antigravity schema generator (writes JSON + instructions.md) |

## Dual-Runtime Quickstart

### Claude Code (stdio MCP)

```bash
# Register (one-time)
claude mcp add --scope user qwen-avo node D:/LLM_Ecosystem/mcp-qwen/index.js

# In a Claude Code session, dispatch:
#   qwen_coworker(prompt="...", cwd="D:/LLM_Ecosystem/my-project", session_id="task1")
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
| `VLLM_PROXY_HOST` | `0.0.0.0` | Stream proxy bind address |
| `QWEN_ENGINE` | `deepseek_avo` | Execution engine: `deepseek_avo` (Cordis) or `legacy_goose` (CLI) |
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
| `QWEN_ENGINE_LOG` | `/tmp/mcp_launch_huge.log` | vLLM engine log path (for stats-line wedge detection) |
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
4. **Registration** — Each remote tool is registered on the Cordis Context as
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
and the cwd path string. A repo named `avo` triggers the `avo` skill.

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
| `avo-mutation-rollback` | rollback, revert, mutation, regression, snapshot, candidate |
| `canary-test-staging` | canary, smoke test, staging suite, test gate, narrow test, targeted test |
| `hypothesis-generation` | hypothesis, avo, fitness, benchmark, optimization, candidate, lineage |
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

4. **Shell validator** (`src/harness/services/shell_validator.js`):
   pure in-memory, zero-execution enclave.
   - **Pattern-level blocks**: `mkfs`, `fdisk`, `parted`, `format X:`,
     `dd of=/dev/...`, fork bomb.
   - **Chain/delimiter splitting**: `;`, `&&`, `||`, `|`, newlines — every
     segment is analyzed, not just the first.
   - **Wrapper unwrapping**: `sudo`, `doas`, `env`, `nice`, `nohup`,
     `xargs`, `bash -c`, `cmd /c`, `powershell -Command` (bounded depth 4).
   - **Unexpanded-reference rejection**: `$VAR`, `${VAR}`, `$(cmd)`,
     backticks in destructive operands → `CommandSecurityError`.
   - **Tilde expansion**: `~`, `~/`, `~user` resolved via platform resolvers.
   - **Homoglyph defense**: NFKC normalization folds fullwidth/compatibility
     forms to ASCII before protected-root comparison.
   - **Protected roots**: `/`, `/root`, `/home`, `/home/<user>`, all
     `/mnt/a-z`, `/mnt/c/windows`, `/mnt/c/users`, `/mnt/c/program files`,
     WSL home, Windows home (as `/mnt/c/Users/...`), raw device names.
   - **Flag disambiguation**: Windows `/s /q /f` etc. recognized as flags,
     not path operands. `--name=value` flag values treated as operands.

5. **Dead-man fuse** (`assertDeadManFuse`): a final pre-spawn barrier that
   re-checks pattern-level blocks and a synthetic canary token.

**`edit_file` guards** (`src/harness/services/sandbox_fs.js`):
- **Zero-occurrence**: target not found → explicit error, no write.
- **`AmbiguousTargetError`**: >1 occurrence without `replace_all` → refusal
  with count, no write.
- **`LineEndingMismatchError`**: exact match fails but CRLF-normalized match
  succeeds → explicit line-ending mismatch error, no write (file bytes
  unchanged).

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
error. `qwen_task(action="cancel_all")` kills all goose processes
machine-wide (anchored sweep + `taskkill /F /IM goose.exe`), cancels all
in-memory and disk tasks, and clears slot leases.

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

`npm test` runs 23 suites (all must exit 0):

| # | Suite | Purpose |
|---|-------|---------|
| 1 | `security.test.js` | 90-vector sandbox containment (path, symlink, null-byte, device, shell, AST, AVO) |
| 2 | `canary.test.js` | Fast canary pilot: AST search/rewrite, syntax gate, traceback condenser, AVO eval |
| 3 | `ast_engine.test.js` | napi-vs-CLI equivalence (search + replace, byte-identical) |
| 4 | `ast_batch.test.js` | Batch replace (directory/glob target, dry_run preview) |
| 5 | `edit_file_guard.test.js` | edit_file guards: zero-occurrence, AmbiguousTargetError, LineEndingMismatchError |
| 6 | `avo.test.js` | Full AVO system (kernel, sandbox, AST, shell, AVO, live vLLM) |
| 7 | `semaphore.test.js` | Cross-process goose slot semaphore (lease files, no vLLM) |
| 8 | `runner_continuation.test.js` | Continuation-on-cutoff: length, empty-generation, reasoning-landing |
| 9 | `wedge_guard.test.js` | Busy-gate + heal backstop (fully offline) |
| 10 | `platform.test.js` | Platform abstraction: WSL/Windows, spawn profiles, resolvers |
| 11 | `posix_routing.test.js` | POSIX shell routing: bash resolution, QWEN_POSIX_SHELL, QWEN_SHELL_MODE |
| 12 | `path_canonicalization.test.js` | Path canonicalization: junction/symlink end-to-end |
| 13 | `syntax_gates.test.js` | Universal syntax gates: all languages, honest degradation |
| 14 | `syntax_integrity.test.js` | Syntax-integrity scan: `node --check` on every `.js` in `src/` + `tests/` |
| 15 | `provider_reasoning.test.js` | Provider reasoning-token accounting (offline SSE) |
| 16 | `mcp_bridge.test.js` | MCP extension bridge (offline, echo fixture) |
| 17 | `skills.test.js` | Skills library: frontmatter, matching, budgets, injection |
| 18 | `reaping.test.js` | Process-reaping: kill certainty, proxy lifecycle, cancel-path bridge disposal |
| 19 | `mcp_client.test.js` | MCP client integration (live engine; honest-skip offline) |
| 20 | `fifo_queue.test.js` | FIFO queue semantics (live engine; honest-skip offline) |
| 21 | `stdio_purity.test.js` | Zero-stdout-write invariant lock |
| 22 | `tool_errors.test.js` | MCP-conformant tool-error envelopes (isError, no thrown exceptions) |
| 23 | `schema_parity.test.js` | Schema drift lock: live-served zod schemas vs `update_schemas.py` JSON |

**Live-engine suites** (honest-skip when vLLM is down): `avo.test.js`
(Test 6), `benchmark.test.js`, `fifo_queue.test.js`, `mcp_client.test.js`.
These use `tests/helpers/engine_probe.js` (`isEngineAvailable` /
`requireEngineOrSkip`) to probe `/v1/models` with a 3s timeout; if the
engine is down they print `[SKIP]` and exit 0.

`npm run test:all` adds three more: `stream_proxy.test.js` (repetition
tiering, UTF-8 reassembly, real proxy regression), `utf8_proxy.test.js`
(multi-byte UTF-8 split across chunks), `benchmark.test.js` (head-to-head
AVO vs Goose).

## Version

**5.1.0** (tracked in `package.json`). This is a documentation-only pass;
no version bump.
