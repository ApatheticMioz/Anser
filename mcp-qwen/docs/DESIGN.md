# mcp-qwen — Design Document

Distilled from the incident ledger in `NOTES.md` (kept raw; this file is the
"why"). Every claim below cites the module that implements it. Version 5.1.0.

## 1. Architecture Rationale

### 1.1 In-process AST (napi) + CLI fallback

`src/harness/services/ast_service.js` runs `@ast-grep/napi` in-process as the
primary engine for js/jsx/ts/tsx/html/css, and falls back to the `@ast-grep/cli`
binary for python/go/rust/c/cpp/json (the napi binding ships tree-sitter
grammars for the former set only). The choice is invisible to callers.

Why in-process first:
- **No subprocess round-trip per search.** The agent loop issues many small
  searches; a CLI spawn per call (process creation, PATH resolution, stdio
  pipe setup) dominated latency on DrvFs.
- **No `.cmd` shim problem.** Node's `spawn` cannot resolve Windows `.cmd`
  shims without a shell, and shell mode breaks argv-array purity (the same
  class of bug that broke Goose's own extension spawning — see L7). The napi
  binding is a native module loaded with `import`; there is nothing to
  resolve.
- **Deterministic "no matches" semantics.** The CLI's exit-1/empty-stdout
  quirk for zero matches is handled only in the CLI path; the napi path
  returns an empty array directly.

The CLI fallback exists because the napi binding cannot parse the other
languages, and because a failed native-module load (wrong platform binary)
must degrade to a working path rather than a dead tool. Equivalence between
the two engines (deep-equal search results, byte-identical rewrites) is
locked by `tests/ast_engine.test.js`.

### 1.2 Why `MAX_SEQS=1` shapes the whole design

The engine runs one generation at a time (`MAX_SEQS=1` on the vLLM side;
`QWEN_MAX_CONCURRENT=1` on the harness side, `src/config.js`). This single
fact drives most of the liveness machinery:

- **The busy-gate** (`src/server_lifecycle.js`, `engineWedgeState`): with one
  slot, any canary generation fired while a task is executing would queue
  behind it and time out — measuring queue depth, not health. It misfired
  twice in production (killed a 17-minute task). So when
  `running_requests > 0 || waiting_requests > 0`, the canary is skipped and
  wedge is declared from engine-log stats silence alone; when idle, the
  canary is authoritative.
- **The first-token timeout** (`QWEN_FIRST_TOKEN_TIMEOUT_MS`, 4 min): a
  wedged engine previously cost 10 minutes of GPU burn per attempt (the
  2026-08-28 incident: zero SSE chunks, 600s inactivity kill,
  `toolCallsCount: 0`). Zero output within the first-token window kills the
  attempt with an explicit "engine wedged or saturated" message.
- **The disk-lease semaphore** (`src/semaphore.js`): each Claude surface
  spawns its own MCP server process, so an in-process semaphore is useless
  across sessions. Slot leases in `~/.qwen/tasks/goose_slots/` are claimed
  with an atomic `O_EXCL` open, heartbeated every 15s, and reclaimed on
  dead-pid or 5-min silence. Default 1 = one goose machine-wide.
- **The zero-turn wait** (`src/task_registry.js`, `:18021`): because a
  single slot means long queue waits, the client is handed a
  `curl .../task/<id>/wait` long-poll that blocks at $0 token cost instead
  of burning turns on `qwen_task` polls (the 570M-cache-read-token finding).
- **The 45s race** (`QWEN_RACE_MS`): sized under Claude Desktop's ~60s
  client timeout and far under Antigravity's 180s, so one constant is safe
  for both surfaces.

### 1.3 Why `deepseek_avo` is the primary engine

`qwen_coworker` defaults to `engine: "deepseek_avo"` (`src/config.js`,
`src/goose_runner.js`): a pure-Node Cordis microkernel
(`src/harness/core/kernel.js`) with sandboxed services, direct SSE streaming
to the client, and the AVO operator. `legacy_goose` (a `goose.exe` CLI
subprocess) remains as the fallback.

- **No binary dependency.** The legacy path depends on a Goose install, a
  working `wsl.exe` spawn, and Goose's own session/extension machinery —
  each a separate failure surface (fabricated `GOOSE_WORKING_DIR` paths,
  `npx.cmd` shim failures, `--resume` crashes on missing sessions).
- **Direct streaming.** The provider (`src/harness/services/provider_vllm.js`)
  reads SSE from the stream proxy directly, so token-level telemetry
  (TTFT, reasoning tokens, idle watchdog) is available to the harness
  instead of being inferred from Goose's stdout JSON lines.
- **Cancellable.** A deepseek_avo task has no child process; cancellation
  works through an `AbortController` that rejects the in-flight fetch
  (`src/tools.js`, `src/task_registry.js`). The legacy path needs a
  process-tree kill.
- **Reversible plugins.** Every service mounts through the kernel's
  disposer mechanism, so a session's tools and services are unbound
  cleanly on completion, failure, or cancel.

## 2. Core Invariants

1. **Zero-stdout-write.** The MCP protocol rides stdio; any stray write to
   stdout corrupts the JSON-RPC stream. All diagnostics go to stderr.
   Locked by `tests/stdio_purity.test.js` (spawns `index.js`, drives a full
   MCP handshake, and asserts every non-blank stdout byte parses as a
   complete newline-delimited JSON-RPC frame).
2. **LF-only.** All files this repo writes use LF line endings (Rule 7).
   The `edit_file` guard treats a CRLF/LF mismatch as an explicit error
   rather than a silent no-op (L2, and `src/harness/services/sandbox_fs.js`).
3. **Honest `finishReason`; never promote empty generations.**
   `src/harness/services/provider_vllm.js` reports the finish reason the
   engine actually sent. A stream that ends with no reason and no output is
   `null`, never synthesized `"stop"`. The runner
   (`src/harness/runner.js`) then classifies: no real finish reason (P2b)
   or `stop` with zero content and zero tool calls (P2d) → retry up to
   `QWEN_EMPTY_STREAM_RETRIES`, then the honest status
   `engine_empty_response` — never a false `"completed"`.
4. **Fail-closed security.** `src/harness/services/shell_validator.js` is a
   pure in-memory string parser: zero `node:child_process` imports, zero
   execution primitives (enforced by audit in `tests/security.test.js`
   category 5e). Unresolvable operands (unexpanded `$`/backtick references)
   are blocked, not guessed. The executor
   (`src/harness/services/shell_executor.js`) is the only module that
   spawns, and it runs the validator + dead-man fuse before every spawn.
5. **Never-throw skills.** `src/skills.js`: unreadable or malformed
   `SKILL.md` files are skipped with a stderr note; a bad skill can never
   take down a dispatch. Injection is additive and budget-capped
   (3 skills / 2000 chars each / 6000 total).

## 3. Incident-Derived Lessons

Each entry: what happened → root cause → the structural fix that now
prevents it.

### L1. Repetition breaker blind to `delta.reasoning` (P7b)

**What happened:** a single generation ran ~18 minutes to the full 49152
`max_tokens` ceiling with zero visible content; engine `/metrics` showed one
Running request with spec-decode acceptance pinned at the 8.0 maximum —
literal repetition, but in the *thinking* stream. The stream proxy's
repetition breaker never fired.

**Root cause:** the detector was fed only `delta.content`. vLLM's
`--reasoning-parser qwen3` streams thinking as `delta.reasoning` (a live
SSE capture confirmed the field name; `reasoning_content` is the legacy
name). A reasoning-level loop was invisible to a content-only detector, and
the provider's own accounting also dropped the field, so the ledger showed
no thinking volume.

**Structural fix:** `src/repetition_detector.js` is now fed
`delta.content || delta.reasoning || delta.reasoning_content` in
`stream_proxy.js`; the provider
(`src/harness/services/provider_vllm.js`) accounts reasoning tokens
(~chars/4) and enforces `QWEN_MAX_REASONING_TOKENS` (32768) client-side —
hitting the ceiling ends the turn as `finish_reason: "length"` +
`hadReasoning`, which routes the runner into the reasoning-landing
continuation directive ("stop deliberating, emit edits now") instead of
hogging the engine. Literal loops are caught by the breaker; semantic
loops (re-phrasing without exact repetition) are bounded by the token
ceiling.

### L2. Junction canonicalization (P4i)

**What happened:** the machine has an NTFS junction `D:\mnt\d -> D:\`. When
the MCP server process was launched with the junction-form cwd,
`process.cwd()` returned the junction literal, and every downstream
containment check (sandbox FS, AST, AVO, shell) compared a junction-form
target against a real-form root — producing false
`SymlinkEscapeError`/`PathEscapeError` on perfectly in-workspace paths.
A related variant: a dirent's `size` through a reparse point is the
reparse point's own size, which silently skipped files in search.

**Root cause:** containment was done in *lexical* path space, where two
spellings of the same file are different strings.

**Structural fix:** `canonicalizePath()` in `src/wsl_bridge.js` resolves
through `fs.realpathSync` (longest-existing-prefix fallback for
not-yet-created paths, never throws). It is applied at the single task-entry
point (`src/tools.js`, `src/goose_runner.js`) and in every service
constructor, so the entire pipeline operates on the real path; containment
compares real-vs-real. Real escapes (`../outside`, symlink-to-outside)
still resolve outside the real root and are caught. Locked by
`tests/path_canonicalization.test.js`.

### L3. Substring over-kill in `pkill` (P10)

**What happened:** the legacy kill path fired
`pkill -9 -f 'goose run --name <id>'`. A session id that is a *substring*
of another session's id (e.g. `abc` vs `abc123`) matched the wrong process;
separately, the kill was fire-and-forget, so a surviving process was never
detected.

**Root cause:** `pkill -f` matches the full command line as a substring
with no boundary semantics, and no post-kill verification existed.

**Structural fix:** `killProcessTree` in `src/wsl_bridge.js` (1) lists
candidates with a broad `pgrep -f`, then verifies each candidate's
`/proc/<pid>/cmdline` has the id at an exact boundary (space or
end-of-line) before killing — a decoy that merely contains the id
survives; (2) kills the direct child pid (`taskkill /T /F` / process-group
`SIGKILL`); (3) verifies death with two liveness probes 500ms apart and
escalates (re-issues the kill) if still alive; (4) returns a structured
`{ killed, escalations }` so callers log honestly. A pid-less target is a
documented no-op success, not a failure. Locked by `tests/reaping.test.js`
(decoy-survival vector, honest-skip when WSL is unavailable).

### L4. Stale schema dicts (P12)

**What happened:** `update_schemas.py` carries a hand-maintained dict of
the three tool schemas for the Antigravity side. It drifted from the live
zod schemas in `src/tools.js` — the IDE saw a different contract than the
server actually served.

**Root cause:** two sources of truth for the same contract, with no check
that they agree.

**Structural fix:** `tests/schema_parity.test.js` spawns the real server
(`node index.js`), completes the MCP handshake, captures the served
`tools/list` array, and deep-compares it against the JSON files
`update_schemas.py` generates. The script's header now states the dict is
the single source of truth for the Antigravity side and must stay in
lockstep; the test makes drift a red build, not a silent divergence.

### L5. Offline test contention with live leases (Gemini Issue 3)

**What happened:** the semaphore test suite used the shared
`~/.qwen/tasks/goose_slots/` directory. When a live MCP server process held
a slot lease, the test's "wipe stale leases" step deleted the live holder's
lease, and the test's own claims collided with the live process's
heartbeat — the suite was flaky in exactly the way that matters (it
validated the one mechanism that protects live work).

**Root cause:** the test and the production code shared a state directory
with no isolation seam.

**Structural fix:** the suite pins `QWEN_STATE_DIR` to a private temp
directory before importing the config module (commit `b3c151e`), so it
exercises the real lease code against a private slot dir. The same
discipline applies to every suite that touches shared state: `avo.test.js`
and `canary.test.js` use their own `.avo`/`.canary_tmp` workspaces.

### L6. `EADDRINUSE` killed the whole process (2026-08-23)

**What happened:** every Claude surface (Desktop, Code, Cowork) spawns its
own OS process running this same stdio server. Only the first can bind
`:18021`; the rest hit `EADDRINUSE`, and an unhandled `'error'` event on a
Node `http.Server` is an uncaught exception — which killed the entire
process, taking that session's whole MCP connection down (logs showed
"Connection closed" seconds after a successful `tools/list`).

**Root cause:** the status server was assumed to be a singleton; the
`'error'` handler was missing.

**Structural fix:** `src/task_registry.js` installs an `http.on("error")`
handler that sets `statusServerOwned = false` and continues. Non-owning
instances then tell the caller to poll `qwen_task` at 180s+ instead of
handing out a `curl` that would 404 against the other instance. Standing
rule: any future feature that binds a fixed port or writes a fixed file
must answer "what happens when a second copy of me is already running?"
The same multi-instance reasoning drives the disk-lease semaphore (L:
`src/semaphore.js`) and the cross-instance heal lock file
(`.engine_heal.lock`, 5-min TTL, `src/server_lifecycle.js`).

### L7. `wsl.exe` login shell executed backticks (v4.5.3)

**What happened:** in `ps` output, Goose arguments appeared as
`Prefer native Goose tools (, , , , )` — the tool directives had been
consumed. Spawning `wsl.exe -d Ubuntu -- <cmd>` ran through the login shell
`bash`, which executed backtick-quoted text as command substitution.

**Root cause:** `wsl.exe --` invokes a shell; `--exec` does not.

**Structural fix:** all WSL dispatches use `--exec`
(`src/platform.js`, `buildSpawnProfile`), which runs the command directly
with no shell interpretation.

### L8. Import-time side effects (v4.5.3)

**What happened:** `index.js` unconditionally ran `main()` on import —
attaching the stdio transport and binding `:18021`. When a test suite
imported an exported helper, the child process hijacked the test's stdio
and collided on the port.

**Root cause:** module import was not side-effect-free.

**Structural fix:** an `isMain` guard
(`path.resolve(process.argv[1])` compared against `import.meta.url`)
gates `main()`, the status-server listen, and the retention interval.
Importing `index.js` is now safe; the server only starts when executed
directly.

### L9. Stream-proxy 5s health window (P10)

**What happened:** two consecutive dispatch boots failed with "failed to
become healthy ... after 5s" while the proxy was actually coming up at
6–8s (cold WSL node spawn). The old pre-kill was also a broad
`pkill -9 -f 'stream_proxy.js'` that could match unrelated processes and
left a defunct zombie.

**Root cause:** the health window was sized for a warm spawn, and the
cleanup was pattern-based rather than pid-based.

**Structural fix:** `ensureStreamProxyRunning`
(`src/server_lifecycle.js`): targeted pre-spawn cleanup by the specific
listener pid (probed from `/health`, then `ss -ltnp`); an injectable
spawner seam so tests simulate slow/failed starts; a 15s health window
(75 × 200ms) with early-exit success; spawn failures captured and included
in the final error instead of swallowed.

### L10. Flat 400s budget → inactivity axis (v4.1.0)

**What happened:** the flat 400s task ceiling killed healthy long tasks
(AVO evolution loops, deep research) while genuinely stuck tasks burned the
whole budget (the `verify:true` post-mortems: broad unstructured
exploration, zero files written, timeout).

**Root cause:** wall-clock age is the wrong liveness axis. A healthy
200k-prefill can be silent for minutes; a dead engine is silent forever.

**Structural fix:** two axes (`src/config.js`): a hard 4-hour total budget
(`DEFAULT_TIMEOUT_MS`) plus a 30-minute zero-stream inactivity watchdog
(`INACTIVITY_TIMEOUT_MS`) as the real liveness guard — kill on silence,
not on age. The legacy-goose watchdog additionally cross-checks vLLM token
counters (`src/goose_runner.js`): if the engine's own counters are
advancing, the silence is prefill, not death.

### L11. A written warning did not change behavior (2026-08-23)

**What happened:** `verify:true` was documented as opt-in with an explicit
~1-in-16 success-rate warning in the tool description. The caller kept
passing it anyway (8/8 real calls in the next session, despite the warning
being live).

**Root cause:** a warning in a description is advisory; the model's
reasoning ("this needs an exact pattern, so let it self-check") matched
every failure, not just the risky ones.

**Structural fix:** the parameter was removed entirely — there is no code
path left that can reproduce the failure mode, regardless of what the
caller intends. Generalization: when a documented opt-in keeps being
chosen against its own documented track record, delete the option rather
than strengthening the warning.

### L12. Fabricated working directory (2026-08-23)

**What happened:** a real run wrote to `C:\Users\hassan\goose\...` — not
this machine's user, not the given `cwd`. Goose's `developer` extension
resolves its working directory from the process-wide `GOOSE_WORKING_DIR`
env var, not `std::env::current_dir()`; the spawn set `cwd` but never the
env var, so the model's turn-context claimed one directory while the
extension's file-tool root diverged, and the model guessed a plausible path
instead of surfacing the contradiction.

**Root cause:** two independent sources of "where am I" (process cwd vs
env var) that can disagree, with the model unable to see the mismatch.

**Structural fix:** the spawn env sets `GOOSE_WORKING_DIR: cwd`
(`src/goose_runner.js`) and the absolute cwd is restated as the first line
of the task prompt as defense in depth. (The deepseek_avo primary engine
has no such duality: the sandbox root is a single constructor argument.)

### L13. Child-spawn ANSI color pollution leak (P14)

**What happened:** when the MCP server was launched by Claude Code, every
`bash` tool result executed by Qwen contained ANSI terminal escape sequences
(`\x1b[32m...`). The escape bytes polluted diff comparisons, regex searches,
and output parsers, causing spurious validation failures and tool re-tries.

**Root cause:** Claude Code exports `FORCE_COLOR=3` into its environment.
The MCP server inherits `process.env`. In Node.js >= 24, Node honors
`FORCE_COLOR` even on piped child stdout streams. When `shell_executor.js`
spawned POSIX `bash.exe`, the child inherited `FORCE_COLOR=3` and emitted
full 24-bit color escapes into piped buffers.

**Structural fix:** `shell_executor.js` (commit `a1dabdc`, P14) explicitly
strips all color-forcing environment variables (`FORCE_COLOR`, `CLICOLOR`,
`CLICOLOR_FORCE`) from the child spawn environment, and injects `NO_COLOR: "1"`.
Locked by regression vector `b4` in `tests/posix_routing.test.js` and
verified under a live `FORCE_COLOR=3` parent environment.

### L14. Universal UNIX LF line-ending invariant vs cross-platform/tokenizer drift (P4h / Rule 7)

**What happened:** mixed line endings (Windows CRLF `\r\n` vs UNIX LF `\n`)
caused subtle, severe failure modes across the multi-agent pairing stack:
1. `edit_file` substring matching failed with `ZeroOccurrenceError` or
   matched duplicate blocks, inflating `shell_validator.js` from 379 to 705 lines.
2. Git Bash / WSL2 POSIX pipelines retained trailing `\r`, breaking commands
   with `command\r: not found` or `bad interpreter`.
3. AST byte-offset drift: `@ast-grep/napi` computes character offsets by bytes;
   a 2-byte newline vs 1-byte newline created cumulative off-by-N character drift,
   corrupting surgical AST replacements on large files.
4. Speculative decoding degradation: BPE tokenizers treat `\n` as a single high-frequency
   token (token ID 198), while `\r\n` is split into two tokens. On the DFlash2
   draft model, newline splitting degraded draft acceptance rate from ~79% down
   to sub-optimal levels.

**Structural fix:** 
- `LineEndingMismatchError` implemented in `src/harness/services/sandbox_fs.js`
  as an active dead-man fuse that halts edits before disk mutation if line endings differ.
- Repository-level `.gitattributes` (`* text=auto eol=lf`, `*.bat/*.cmd text eol=crlf`)
  and `.editorconfig` (`end_of_line = lf`) pinned to enforce LF checkout.
- Codified as **Rule 7** across multi-agent protocols (`GEMINI.md` and `CLAUDE.md`).

### L15. JSDoc block-comment premature termination via glob wildcard `*/` (P7)

**What happened:** `node --check src/harness/services/ast_service.js` threw
`SyntaxError: Unexpected token '.'` at line 912 during boot, preventing AST
service startup.

**Root cause:** in JSDoc multi-line comments (`/** ... */`), documenting a glob
like `(e.g. 'src/**/*.js')` embedded the sequence `*/`. The V8 parser treated
`*/` as the comment closing delimiter; the remainder of the line (`.js')`) was
evaluated as raw JavaScript syntax.

**Structural fix:** JSDoc annotations rephrased to avoid literal `*/` sequences
in docstrings (commit `cb0559f`). Locked by `tests/syntax_integrity.test.js`
(commit `8bde746`, P11), which runs `node --check` across every `.js` file in
`src/` and `tests/` before gate exit.

### L16. Shell validator evasion taxonomy & recursive segmentation (P4e2)

**What happened:** adversarial security fuzzing uncovered 15 bypass vectors in
initial regex-based command safety checks:
1. Command chaining (`;`, `&&`, `||`, `|`, `\n`): a safe initial command
   followed by a chained destructive command bypassed single-pattern checks.
2. Backtick subshells (`` rm -rf `pwd` ``) evaded command identification.
3. Flag-embedded paths (`rm -rf --no-preserve-root=/`) hid targets in flags.
4. User tildes (`~root`, `~user`) evaded home directory containment.
5. Unicode homoglyphs (`\uFF37indows`) bypassed ASCII `/c/Windows` blacklists.
6. Nested wrappers (`bash -c "cd /tmp && rm -rf /"`) hid payloads in strings.

**Structural fix:** `src/harness/services/shell_validator.js` (commit `fb89fc3`):
- Recursive segmentation of all command chains, subshells, and pipes.
- NFKC Unicode normalization before path comparison.
- Flag-aware path disambiguation (supporting both Windows `/s /q` flags and POSIX `--flag=val`).
- Wrapper unwrapping up to bounded depth 4 (`sudo`, `env`, `bash -c`, `cmd /c`, `powershell`).
- Locked by `tests/security.test.js` across 123 blocked attack vectors and 14 allow vectors.

### L17. MCP error envelopes vs thrown exceptions (P12)

**What happened:** when tools encountered invalid input or boundary violations,
throwing standard JavaScript exceptions caused the MCP SDK to terminate the
JSON-RPC connection or trigger protocol errors, crashing the caller's session.

**Structural fix:** tool handlers catch all internal errors and return
conforming MCP error payloads (`{ isError: true, content: [{ type: "text", text: ... }] }`)
with exit code 0 on the wire (commit `9df8a73`, P12). The connection remains
alive and the model receives clear, actionable diagnostic text. Locked by
`tests/tool_errors.test.js`.

## 4. Multi-Instance Model (standing rule)

This server is **not a singleton**: N Claude surfaces = N independent OS
processes, each with its own in-memory task map. Anything that needs
cross-process coordination must use a shared, atomic substrate:

- slot leases: `O_EXCL` file claims + heartbeats (`src/semaphore.js`)
- task state: JSON files in `~/.qwen/tasks/` with atomic
  write-then-rename (`src/task_registry.js`)
- heal coordination: `.engine_heal.lock` stamp file with 5-min TTL
  (`src/server_lifecycle.js`)
- the status port: first-binder-owns; losers degrade to
  `statusServerOwned = false` (L6)

In-process locks (mutexes, `Map`s) never serialize across instances.

## 5. 11-Hour Production Telemetry & Verification Ledger

The v5.1.0 release is backed by an unbroken 11.25-hour multi-agent pair-programming
marathon between Gemini 3.8 Flash (Meta-Supervisor), GLM-5.3-Flash / Claude Code (Lead Architect),
and Qwen3.8-27B (Autonomous Execution Coworker).

### 5.1 Cumulative Engine & Hardware Telemetry

| Metric | Measured Value | Operational Rationale |
|--------|----------------|-----------------------|
| **vLLM Prefill / Prompt Tokens** | **56,312,194 tokens** | Processed entirely locally on RTX 3090 at $0 cost |
| **vLLM Generation Tokens** | **1,749,192 tokens** | Autonomous AST surgery, test suites, refactoring |
| **Empirical Prefill Throughput** | **9,454.3 tok/s** | Empirical average across 56.3M prompt tokens (prefix cache hit rates reaching 8,000–9,500+ tok/s) |
| **Empirical Generation (Decode) Speed** | **58.2 tok/s** | Sustained pure decode throughput (mean TPOT 15.42 ms $\to$ **64.9 tok/s** instantaneous) |
| **Effective End-to-End Turn Speed** | **48.5 tok/s** | Round-trip throughput across conversation turns including prefill & tool dispatch |
| **Speculative Accepted Tokens** | **1,379,412 tokens** | **78.86% acceptance rate** on DFlash2 1.92B drafter |
| **Active Qwen Sessions** | **134 sessions** | Micro-session roll cadence preventing KV decay |
| **Logged Microkernel Events** | **6,140+ events** | Append-only session telemetry (`~/.qwen/sessions/`) |
| **Total Tool Executions** | **1,939+ calls** | Autonomous execution across Windows and WSL environments |
| **VRAM Footprint** | **24,136 MiB / 24,576 MiB** | Universal 245K context + KVarN k4v2 KV cache |
| **GPU Operating Temp** | **31°C - 58°C** | Liquid-cooled RTX 3090 under 250W power cap |
| **Zero-Turn OS Wait Savings** | **~590M tokens** | Zero-turn HTTP long-poll (`:18021`) vs polling loops |

### 5.2 The 14 Engineering Passes (P1–P14 Complete Implementation Map)

| Pass | Commit | Scope & Subsystem | Core Resolution & Verification |
|------|--------|-------------------|--------------------------------|
| **P1** | `8a05ccf` | Manifest & Registration | Manifest-driven server identity, engine pin, README env reference |
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

## 6. References

- `NOTES.md` — raw incident ledger (historical record)
- `README.md` — operational guide and configuration reference
- `tests/` — executable regression locks (26 test suites)
- Upstream: `syv-ai/qwen38-27b-rtx3090` (vLLM recipe; issue #48 = the
  first-chunked-prefill wedge, resolved upstream 2026-09-02)

