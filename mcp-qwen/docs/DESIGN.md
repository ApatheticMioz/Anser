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

## 5. References

- `NOTES.md` — raw incident ledger (do not edit; this file distills it)
- `QWEN_HARNESS_TELEMETRY_LOG.md` — per-run telemetry (do not edit)
- `tests/` — the invariants as executable locks (see README test map)
- Upstream: `syv-ai/qwen38-27b-rtx3090` (vLLM recipe; issue #48 = the
  first-chunked-prefill wedge, resolved upstream 2026-09-02)
