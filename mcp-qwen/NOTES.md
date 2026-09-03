# Delegation infrastructure — investigation history

Not auto-loaded into any session's context. Read this on demand when debugging
`mcp-qwen/index.js` or reconsidering a design decision below — it's the "why,"
not the "what to do now" (that's `D:\LLM_Ecosystem\CLAUDE.md` and
`~/.claude/CLAUDE.md`, kept short deliberately).

## Goose subprocess design (initial)

Chose `goose.exe` (block/goose) over the earlier `pi`-CLI design because Goose
is MCP-native (`--with-extension` attaches any stdio MCP server per task); `pi`
explicitly doesn't support MCP/sub-agents. Subprocess spawn pitfalls learned
from the `pi` attempt and avoided here: `stdio: ["ignore", "pipe", "pipe"]`
(unset stdin hangs some CLIs indefinitely), `goose.exe` is a real PE binary not
an npm `.cmd` shim (no EINVAL-on-batch-file issue), and timeout kills go through
`taskkill /PID <pid> /T /F` (a bare `child.kill()` doesn't cascade to child
processes on Windows, which can orphan a long-running verification command).

Claude Desktop has a hardcoded, non-configurable ~60s client-side MCP timeout
(confirmed empirically). Since real delegate calls take 30-150s+, this is
handled with an async taskId/poll pattern: `delegate_coding_task` races its
own work against `RACE_MS` (50s) and returns a `taskId` to poll via
`qwen_check_task` if not done by then, rather than blocking past what the
client can wait for.

## Bug: fabricated file path (2026-08-23, session 1)

A real run wrote to `C:\Users\hassan\goose\...` — not this machine's user, not
anywhere in the given `cwd`. Root cause, confirmed via Goose's own
`llm_request.*.jsonl` log (`%APPDATA%\Block\goose\data\logs\`): Goose's
`developer` extension resolves its working directory from the process-wide
`GOOSE_WORKING_DIR` env var, not `std::env::current_dir()`
([block/goose#6610](https://github.com/block/goose/issues/6610),
[#6909](https://github.com/block/goose/issues/6909)). The spawn set `cwd` on
the child process but never set that env var, so the model's turn-context
claimed the right directory while the extension's actual file-tool root
diverged — the model guessed a plausible path rather than surfacing the
contradiction. Fix: set `GOOSE_WORKING_DIR: cwd` in the spawn env, and restate
the absolute `cwd` as the first line of the task prompt as defense in depth.

## Bug: shell mismatch (2026-08-23, session 1, recurred on retry)

`'Get-Content' is not recognized...` (exit 255). Goose has no shell-selection
config on Windows and defaults to `cmd.exe`, while its own baked-in
developer-extension system prompt tells the model to use PowerShell-only
cmdlets ([block/goose#7837](https://github.com/block/goose/issues/7837), open,
no upstream workaround). Mitigated (not fixed — no config exists) by prepending
a one-line counter-instruction to the task prompt.

## Design: verify default flip (2026-08-23, after session 1)

Session 1: 8 delegate calls, all left at the then-default `verify:true`. Every
one either hit the 400s timeout mid self-check or burned the whole budget on a
build/test pass before reaching the edit — while the caller re-verified against
disk afterward regardless (standing policy). Flipped default to `verify:false`.

## Design: taskId/poll gaps closed (2026-08-23)

Two gaps found by live-testing the above fix:
- **Queue time misreported as hang.** `qwen_check_task`'s "elapsed" counted
  from task *creation*, not execution start. With several tasks queued behind
  each other on one GPU, "832s elapsed, still running" was mostly queue wait,
  and read as a hang to both the orchestrator and the user mid-session. Fixed:
  `execStartedAt`/`queuePositionAtEnqueue` tracked separately; status messages
  distinguish "queued" from "executing."
- **Cold boot had no taskId to poll.** `ensureMode`'s boot wait (up to 180s)
  was awaited *before* `startGooseTask` registered a taskId — a cold first
  call could blow through the client timeout with nothing to check (confirmed:
  a cold call returned a bare timeout; the edit had actually landed, only
  discovered minutes later via an unrelated follow-up call). Fixed: taskId
  registered synchronously before any `await`; boot now happens inside the
  queued task itself, tracked via a `booting` flag.

Also added `qwen_cancel_task` (taskkill-based, same tree-kill as the timeout
path) — session 1 had 8 abandoned Goose runs kept executing in the background
after the caller gave up and redid the work by hand, with nothing to stop a
late write from clobbering the hand-fix. No evidence it happened that night,
but nothing prevented it either.

Live-tested same day: cwd fix confirmed (no more fabricated paths),
`verify:false` completes well under budget, queue-position reporting accurate,
cancel-while-queued genuinely prevents execution (target file never created).

## Post-mortem: session 2 (2026-08-23, run entirely after the above fixes)

Fixes confirmed working (correct cwd, correct verify:false timing, correct
queue-position reporting, cancel-while-queued). Session still burned a large
fraction of its work redoing things by hand, for two *new* root causes:

1. **`verify:true` kept getting passed explicitly anyway** — all 8 real calls
   this session. Every one either hit the 400s timeout with an incomplete/
   zero-file result, or was lost to point 2. Combined with session 1: ~1
   confirmed clean success out of 16 self-verify attempts, and that one
   success was small enough it likely didn't need self-verify either. The
   caller's reasoning ("this needs an exact pattern followed, so let Qwen
   self-check") matched every failure, not just the risky-feeling ones. Fixed
   by rewriting the tool description to state this track record as a blunt
   fact rather than a neutral tradeoff.
2. **6 calls fired in a 4-minute window, then ~90 minutes of unrelated work
   (manual browser QA) with no follow-up.** Single-GPU serial queue + verify:
   true tasks tending to run the full 400s meant a 30-40min+ backlog; 2 of the
   6 tasks aged out of the then-30min retention window before being checked.
   Results (success or failure) were unrecoverable; the caller reimplemented
   both features by hand. Fixed: `TASK_RETENTION_MS` raised 30min → 3h, and
   every status message now reports the total unfinished-task count
   server-wide, not just the one being asked about.

**Unused capability, both sessions combined (18 delegate calls, 0 uses):**
`extensions` (per-task MCP attachment) never passed once. Every UI-facing
feature got verified visually by the caller doing its own browser-tool calls
by hand (131 in session 2 alone) instead of Qwen doing it via an attached
Playwright MCP server (`npx -y @playwright/mcp@latest`,
[goose-docs.ai/docs/mcp/playwright-mcp](https://goose-docs.ai/docs/mcp/playwright-mcp/)).
Tool description now names this pattern explicitly for UI-facing tasks.

**Token cost mechanism identified:** session 2 carried 570M cache-read tokens
across 1,009 assistant turns. `qwen_check_task` poll volume (129 polls that
session) is the real driver, not manual coding output — every poll is a
permanent context addition re-sent (as a cached read) on every subsequent
turn for the rest of the session. This is structural to the async poll
pattern, not a bug; it argues for fewer/wider-spaced polls and preferring
verify:false (shorter runs, fewer polls needed).

## Design: DELEGATE_TIMEOUT_MS = 400s — why, and why not raised further

400s was set before any production data existed — a generous-feeling multiple
of the expected 60-150s case, not a measured figure. Telemetry since:

- Plain `verify:false` tasks land in 40-60s — 400s is already a 7-10x margin.
  No change made here.
- `verify:true` tasks show a *qualitative* failure pattern: broad,
  unstructured exploration with zero files written well past 200-270s, not
  "nearly done but out of time." Raising this ceiling was considered and
  rejected — nothing in the evidence suggests more time converts these runs to
  successes, only that it would hold the GPU/queue longer before the same
  zero-output result. (This is a separate judgment from whether verify:true
  should be used at all — see the flip above. The point here is specifically
  that a bigger number wasn't the fix.)
- **Real bug found 2026-08-23**: the tool's own docs said a first-time
  npx-based extension download costs ~500s, but the flat 400s ceiling applied
  to every call regardless — meaning any extensions-attached call (e.g. the
  Playwright recommendation added the same day) was guaranteed to be killed
  before or during install. Fixed: `EXTENSION_TIMEOUT_BONUS_MS` (500s) added on
  top of the base 400s only when `extensions` is non-empty, computed once per
  task and threaded through the kill timer and all status messages via
  `entry.timeoutMs`.

## Bug: Goose stderr never captured (2026-08-23)

Root-caused the "no diagnostic info" problem from the Playwright extension
test above. `spawn(GOOSE_EXE, args, { stdio: ["ignore", "pipe", "pipe"] })`
pipes stderr as a file descriptor, but nothing ever attached a `.on("data")`
listener to `child.stderr` - every Goose-level error message (crash, extension
load failure) was captured by the OS pipe and then simply never read, which
in Node means it's silently discarded, not buffered for later. This matters
specifically because Goose's own documented error format for extension
failures is literally `"process quit before initialization: stderr = ..."` -
the actual cause was sitting in the one stream we weren't reading. Fixed:
`entry.stderr` accumulates stderr chunks (capped at 8000 chars), threaded into
`summarizeGooseRun` and surfaced in every status message when non-empty.

Also checked while diagnosing the Playwright failure, both ruled out as causes
on this box specifically:
- Known Windows bug ([block/goose#6816](https://github.com/block/goose/issues/6816)):
  `@` in package names gets backslash-escaped when extensions are added via
  Goose Desktop's UI, breaking npx path resolution. Fixed upstream via PR
  #7242. Scope unclear (Desktop UI config generation vs. CLI `--with-extension`
  directly) - not confirmed as our cause, but installed Goose is v1.47.0;
  worth checking if that predates the fix if the bug recurs after the stderr
  fix lands.
- Known "Node.js installer script not found" issue: happens when Node is
  installed outside the standard `C:\Program Files\nodejs\` path. Checked:
  `where node` on this box returns exactly that standard path (v25.8.0). Not
  the cause here.
- Confirmed our `--with-extension` syntax matches Goose's own documented
  format exactly (`[name:]ENV1=val1 command args...`) - not a syntax error on
  our side.

**Not yet resolved**: the actual root cause of the Playwright non-attachment.
Next real diagnostic step, pending a client restart to load the stderr-capture
fix: re-run the same test and read `entry.stderr` for the first time.

## Design: deep research harness for Qwen (2026-08-23)

Selected [free-search-mcp](https://github.com/sweetcornna/free-search-mcp)
(`uvx free-search-mcp`) after comparing options: DuckDuckGo MCP and the
official MCP reference `fetch` server (`uvx mcp-server-fetch`) each cover half
the problem (search XOR fetch) and need composing; Tavily/Brave/Exa need paid
API keys past a small free tier. free-search-mcp's `research()` tool does
search + fetch + brief generation in one call, no API key, multi-engine
(DuckDuckGo/Mojeek/Startpage) with a Playwright fallback, plus `read_doc()`
for PDF/DOCX/XLSX/PPTX/EPUB/CSV - broader than this orchestrator's own native
web tools in that one respect. `uv`/`uvx` confirmed already installed on this
box (v0.11.8). Small project (54 stars, 57 commits) but no red flags found in
its docs/architecture. Wired into `delegate_coding_task`'s `extensions` field
description and both CLAUDE.md files. **Not live-tested** - the Playwright
extension was also assumed-working before being recommended and turned out not
to be, so this should not be trusted either until confirmed the same way: a
real delegate call, checking the actual result text for registration.

## Design: verify removed entirely (2026-08-23)

`verify:true` was documented as opt-in with an explicit ~1-in-16 success-rate
warning in the tool description. Caller kept passing it anyway across both
real sessions (8/8 real calls in session 2, despite the warning already being
live). A written warning did not change behavior. Removed `verify` as a
parameter entirely - `delegate_coding_task` now always instructs Qwen not to
run build/typecheck/test commands. There is no code path left that can
reproduce the failure mode, regardless of what the caller intends.

## Bug: Playwright extension never attached (2026-08-23, live-tested)

Recommended `extensions: ['npx -y @playwright/mcp@latest']` for UI-facing
tasks (see the two entries above this one) without ever having tested it.
Live-tested directly: dispatched a task with that extension attached. Qwen's
own final report: *"I don't see a browser/playwright tool in my current
toolset... the available extensions (`summarize`, `chatrecall`,
`code_execution`) don't include one."* The extension did not register in
Goose's toolset - root cause not diagnosed (could be a silent npx failure, a
Goose `--with-extension` bug, or something else). Qwen worked around it
unprompted: launched real headless Chrome
(`C:\Program Files\Google\Chrome\Application\chrome.exe`) via Python's
`subprocess` module (cmd.exe mangles the space in `Program Files` if invoked
as a raw shell string) with `--headless --dump-dom <file:// url>`, and
confirmed the actual rendered DOM matched the edit (exit code 0, no errors).

Conclusion: `--with-extension` MCP attachment is **not proven reliable** on
this box for at least this one real package - stop recommending it as the
default UI-verification path. Direct shell-invoked headless Chrome **is**
proven reliable (this one live test) and needs no attachment step to fail.
Tool description now recommends the shell-Chrome pattern by name instead of
Playwright. `extensions` remains available and documented, just not assumed
to work without checking the actual result text - same "never trust a
delegated summary without checking" discipline as everything else.

## Design: HTTP status endpoint to escape turn-per-poll cost (2026-08-23)

User's framing: "you can implement a tool for yourself to remind you it's
done maybe? Could be more efficient than polling." Checked the actual
literature rather than just building something:

- MCP's own async-task standard, **SEP-1686 "Tasks"** (Final status, current
  spec) - not a draft, the accepted design. Its own Motivation section states
  the scoping explicitly: *"Concurrent and poll-able tool calls... for
  operations executing in the range of a few minutes, and some form of push
  notification system... for long analyses on the order of hours. This SEP
  supports the former."* Our tasks are minutes-scale - polling is what the
  spec authors deliberately designed for this tier, not an oversight. The
  spec's one notification (`notifications/tasks/created`) fires only at task
  *creation*, to resolve a race condition, not on completion - even the
  current standard has no push-to-done primitive. Separately, the broader
  webhook-vs-polling literature (Gemini API webhooks, agent-runtime writeups)
  does favor push - but for durable sleep/wake execution platforms, a
  different deployment model than an interactive Claude Code session driving
  MCP tools.

Given no protocol-level push exists to use, built the practical equivalent
using what the harness already has: a localhost-only HTTP endpoint
(`STATUS_PORT = 18021`, GET `/task/<taskId>`) that a Bash background loop
(`run_in_background:true`) can poll with real OS-level `sleep`, entirely
outside any LLM turn - the caller is notified once, on completion, instead of
manually calling `qwen_check_task` N times, each one a permanent addition to
conversation context (the actual mechanism behind the 570M-cache-read-token
finding earlier in this file). The endpoint is deliberately minimal: GET-only,
read-only, `{found, done, booting, executing, isError}` - no result text
(that still comes from `qwen_check_task`, once, after the wait resolves, to
avoid duplicating `summarizeGooseRun`'s formatting in two places), no way to
start or cancel work over HTTP, bound to `127.0.0.1` only.

**Real incident, same day, caught from the user's own pasted MCP logs**: this
first version had no `'error'` handler on the HTTP server. Each Claude surface
(Desktop, Code, Cowork - confirmed from the log, which names exactly these)
spawns its own separate OS process running this same stdio server; only the
first to start can bind `STATUS_PORT`. Every later one hit `EADDRINUSE`, and
an unhandled `'error'` event on a Node `http.Server` is an uncaught exception
- which killed the ENTIRE process, not just the listener, taking that
session's whole MCP connection down with it (log showed "Connection closed"
seconds after a successful `tools/list`, across multiple sessions). Fixed with
an `http.on("error", ...)` handler that logs and continues instead - verified
directly, not just reasoned about: manually occupied port 18021 with a dummy
listener, started `index.js` against it, confirmed via stderr the process
logged the conflict and stayed alive rather than throwing. A zombie process
from before the fix (still holding the port, already disconnected from its
own client) was killed manually to clear the port for the next real restart.

**Lesson for any future feature here**: this server is not a singleton -
multiple independent OS processes run the same code concurrently, one per
Claude surface, each with its own separate `pendingTasks` in memory. Any
future addition that binds a fixed port, writes a fixed file path, or assumes
single-instance state needs the same "what happens when a second copy of me
is already running" check this one initially skipped.

**Not yet live-tested end-to-end** (a real background curl loop against a real
in-flight task, now that the crash is fixed) - needs a restart to load.

## Rejected (for now): Goose's own subagent dispatch (2026-08-23)

User's prior experience running Qwen via TabbyAPI got parallel subagents
working sharing one KV cache pool, and asked whether Goose's built-in
`delegate`/`summon` subagent mechanism (`qwen-worker`, seen in the tool
listing during the harness audit) could do the same here. Checked the real
infrastructure first: this server's CTX=huge config does run
`--max-num-seqs 2` with `--enable-prefix-caching` genuinely on
(`~/qwen-serving/single-user/start_qwen.sh`) - the mechanism class is real
and present, inherited from upstream's own tuning, not something built for
this project specifically.

Live-tested the actual subagent path: dispatched a task instructing Qwen to
delegate three trivial one-sentence summarization subtasks via `qwen-worker`,
async/parallel. Result: **failed outright on the first attempt** - the
subagent's default LLM config requested a model named `"haiku"`, not
inheriting this server's `GOOSE_MODEL=qwen3.8-27b` override (Goose's subagent
system has its own model-selection defaults, apparently assuming Claude-style
tiering). Qwen caught this itself and retried with an explicit override -
that retry then **never completed**, hitting the full 400s timeout with zero
of the three trivial subtasks finished.

Conclusion: the underlying capacity is real (2-way concurrency, real
prefix-cache sharing), but Goose's own subagent implementation is not
currently reliable enough to route real work through. Not recommended as of
this writing. If revisited: the model-override syntax needs to actually work
end-to-end, and a clean fast run needs to be confirmed before trusting it,
same bar as everything else in this file.

## Boot-log warnings cross-checked against upstream, MAX_SEQS raised 2->4 (2026-08-24)

User pasted a real vLLM boot log and asked for the WARNING/ERROR lines to be
explained, plus whether 2-way concurrency had actually been tested properly
(it hadn't - see previous entry's "not yet live-tested" note). Rather than
reason from first principles, read upstream's own `docs/gotchas.md` (31+
numbered points) and `README.md` in the actual WSL checkout before concluding
anything.

**Per-warning findings:**
- `Unknown vLLM environment variable detected: VLLM_DFLASH2_LOOKUP*` (x4) -
  these are this recipe's own patch env vars, not stock vLLM; the generic
  validator just doesn't know about them. Cosmetic.
- `[ERROR] min_frames/max_frames... not documented` (x2, once per process) -
  `transformers`' own docstring lint for the Qwen3-VL video processor,
  instantiated generically even though the very next line confirms
  `language_model_only`/text-only mode. Labeled ERROR but dead-code-path
  noise. Cosmetic.
- `mamba_ssm_dtype='float32' in config, but --mamba-ssm-cache-dtype='float16'
  was passed` - confirms an intentional override already made in
  `start_qwen.sh`, not a new problem.
- `Prefix caching in Mamba cache 'align' mode is... experimental` - not
  mentioned in upstream's own docs, but already substantively validated:
  upstream's own README documents extensive `PREFIX_CACHE=1 + CTX=huge`
  testing (4.7s vs 169s cache-hit benchmark, GSM8K accuracy checks). This is
  vLLM's generic caution label on a path this recipe has already stress-
  tested for the specific case we run. No action.
- `Add 3 padding layers, may waste at most 60.00% KV cache memory` - also
  unmentioned upstream, also already implicitly priced in: the realized pool
  (268,169 tokens) matches upstream's own benchmarked number for this exact
  config exactly (see below), so whatever padding occurs is already reflected
  in that final figure, not hidden loss on top of it. No action.
- `max_num_scheduled_tokens is set to 2034... may lead to suboptimal
  performance... decrease num_speculative_tokens or max_num_seqs` - directly
  tied to the concurrency question below.
- `flashinfer is unavailable; the DFlash2 selector uses torch.topk, at
  roughly half the speed` - checked whether flashinfer was even installed
  (`pip show flashinfer-python` -> yes, 0.6.16.post3, a real vLLM dependency,
  not missing) - so the failure is at runtime, not install. Checked
  `CUDA_HOME`: unset, and no `nvcc` found anywhere under `/usr/local` in this
  WSL venv - only PyTorch's bundled CUDA runtime is present, no full toolkit.
  Same root cause independently explains the earlier `deep_gemm... AssertionError:
  cuda_home is not None` warning - both packages need `nvcc` to JIT-compile
  custom kernels on first use and silently fall back without it. Confirmed
  via upstream's own README that FlashInfer is documented as the backend for
  `CTX=long` (fp8 KV, 150k context) specifically, not `CTX=huge` (our KVarN
  config) - so this gap only costs the DFlash2 selector step, not the main
  attention/decode path. Real, but narrow. **Not fixed**: installing a system
  CUDA toolkit (`nvcc`) is a multi-GB, system-level WSL change: flagged for
  the user to approve rather than done unprompted, unlike the in-repo config
  changes elsewhere in this file.

**Concurrency, tested properly this time:** upstream's README directly
addresses `MAX_SEQS` at `CTX=huge`: *"Fire 8 concurrent requests... the server
runs two, with the other six queued - because this mode sets MAX_SEQS=2. That
is a deliberate default for long-document sessions, not an engine limit...
MAX_SEQS=8 lifts it: peak 5 concurrent on the same 8-stream test, with the KV
pool unchanged at 268,169 tokens (a recurrent-state slot costs ~8 MiB)."` This
directly contradicts the prior entry's assumption that `--max-num-seqs 2` was
a hard ceiling worth matching exactly rather than a low default worth
raising.

Raised `MAX_SEQS` 2 -> 4 in `launchers/start_huge.sh` (a conservative middle
step versus upstream's own tested 8) and verified live on this box, not just
trusted from docs: rebooted, watched the boot log directly (confirmed the
process was alive and progressing via `ps`/`nvidia-smi` during a slower
cold-compile pass - the CUDA graph capture list grew from `[1,2,4,8,16]` to
`[1,2,4,8,16,24,32]`, so compilation cache invalidated and had to redo, ~37s),
and confirmed the final numbers: **KV cache size: 268,169 tokens - identical
to the MAX_SEQS=2 boot**, `max_num_scheduled_tokens` shifted from 2034 to
2020 (config genuinely took effect), no new errors, no CUDA/OOM issues,
`HTTP server started` reached cleanly. Matched `MAX_CONCURRENT_GOOSE` in
`mcp-qwen/index.js` (2 -> 4) to the new ceiling. Room to raise both further
toward upstream's tested 8 if 4 proves stable in real use - 4 was chosen as a
verified floor, not asserted as the optimum.

## Design: MCP-level concurrency raised to 2 (2026-08-23)

Given the subagent path above isn't ready, used the confirmed 2-slot engine
capacity a different way: `runQueued` was previously a strict FIFO chain
(exactly 1 Goose process at a time, always). Failure #1 in this file's first
section ("3 of 4 concurrent calls timed out") was the historical reason for
that - but re-read now with the actual `--max-num-seqs 2` figure in hand,
that failure is 4 requests against a 2-slot engine, not evidence that any
concurrency is unsafe. Replaced the FIFO chain with a small semaphore
(`MAX_CONCURRENT_GOOSE = 2`, `activeGooseCount`/`gooseWaitQueue`) allowing up
to 2 genuinely simultaneous Goose runs, a 3rd queuing until a slot frees -
matching the server's real ceiling exactly, not guessing at a new number.

One real race this introduces and had to design around: two concurrent calls
both needing a **mode switch** (huge<->fast) at the same moment would both
hit `ensureMode`'s `pkill` + relaunch sequence simultaneously and could
corrupt each other's boot. Mode switches are rare (`huge` is the default and
stays booted) but not impossible under real concurrency. Fixed by keeping the
boot/mode-check step (`ensureMode` + `getApiKey`) serialized through a
separate `bootMutex`, independent of the 2-way concurrency gate on the actual
Goose subprocess execution - cheap in the common case (a single fast HTTP
check when no switch is needed), and eliminates the race entirely rather than
accepting the risk.

**Not yet live-tested** - needs a restart to load, then two real concurrent
`delegate_coding_task` calls to confirm they actually overlap in wall-clock
time (not just that neither errors).

## Resolved: Playwright root cause found and fixed (2026-08-23, same day)

The stderr-capture fix (next entry, chronologically first) immediately
revealed the actual cause on the very next live test: `Warning: Failed to
start extension 'npx' (IO error: program not found), continuing without it`.
Goose's Rust process spawner cannot execute `npx` directly on Windows because
`npx` resolves to `npx.cmd` (an npm shim), not a real `.exe` - the identical
class of bug this project's own `startGooseTask` was specifically written to
avoid for *our* spawn of `goose.exe` (see "Goose subprocess design" above),
just occurring one level down, inside Goose's own spawning of the extension
process.

Fix confirmed live: `extensions: ['npx.cmd -y @playwright/mcp@latest']`
(bare `npx.cmd`, not `npx`) - Qwen reported real Playwright browser tools
available. Also tested `uvx free-search-mcp` (see deep-research entry below)
in the same session: registered successfully as extension `uvx` with
`search`/`research`/`fetch`/`fetch_batch`/`read_doc` tools, unaffected by the
npx bug since `uvx` is a real `.exe` (confirmed via `where uvx`), not a shim.

One remaining Playwright-specific limitation, not a bug: it blocks `file://`
URLs by default (a real security restriction in the package itself) - use
headless Chrome for local file verification, Playwright for real sites.

Also confirmed while investigating: `gh` CLI is installed and already
authenticated (repo/workflow/gist/read:org scopes) - Qwen can do real GitHub
work directly via its `shell` tool with no extension needed at all, a
capability that existed the whole time and was never documented or used.

Also ran `goose update` (official self-update command, Sigstore-verified) -
already on latest stable (1.47.0), so the update path itself carried no risk
and ruled out "outdated Goose" as a contributing factor.

## Architecture validated against external research (2026-08-23)

Before treating the orchestrator/worker split as settled, checked it against
2026 multi-agent production literature rather than just internal telemetry.
Relevant finding: delegation quality has a floor on the *delegating* model -
one study found reliable task decomposition/delegation only on the strongest
models tested (~0.85), falling to "unusable" (~0.45) on fast/cheap tiers, and
a separate planner-executor study found larger planners measurably improve
smaller executors' output. This directly argues against ever "cheapening" the
orchestrator itself (e.g. routing Sonnet's own planning/decomposition/judging
through a lighter model) even while aggressively minimizing what work it
executes directly. Orchestrator-worker (one capable lead agent decomposes and
delegates to workers, assembles/judges results) is independently confirmed as
the standard production pattern for this shape of problem, not a bespoke
design here.

## Considered and rejected (so far): Claude Code CLI instead of Goose

Investigated spawning `claude -p --output-format stream-json
--dangerously-skip-permissions --mcp-config <file>` instead of `goose.exe`,
pointed at the local vLLM server via `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`
in that subprocess's own env (Sonnet stays the orchestrating session,
unaffected — same relationship Goose has today, just swapping the engine).

Architecturally plausible: vLLM documents native Anthropic Messages API
support ([docs.vllm.ai](https://docs.vllm.ai/en/latest/serving/integrations/claude_code/)),
and Claude Code's CLI fully supports headless subprocess use with the flags
above. **Not attempted** — two open questions cut against it: (1) unverified
against this box's actual vLLM launch flags (needs Anthropic-format tool-call
parsing, not just the OpenAI-format `qwen3_coder` parser already configured),
and (2) Claude Code's own system-prompt/tool-schema overhead is substantially
heavier than Goose's lean agent loop — at the same ~77 tok/s, a heavier
per-turn prompt means *less* of the 400s budget reaches actual work, which
cuts directly against the exact timeout problem being fought. Current
decision: keep hardening Goose (two consecutive rounds of real, narrow,
fixable bugs so far — not evidence of a dead end); treat a Claude-Code-as-
subprocess swap as a separate, isolated prototype to validate before ever
wiring it into production.

Also noted: [claude-code-router](https://github.com/musistudio/claude-code-router)
claims native per-subagent model routing (`<CCR-SUBAGENT-MODEL>` syntax) which
would be the more "native" version of this idea (Sonnet's own `Task` tool
dispatching straight to Qwen). Unverified whether tokens routed this way
bypass Anthropic billing entirely or still transit Anthropic's infra first —
that's the question that actually matters here and wasn't answered by its
docs. Not prototyped.

## Serving-stack corruption incident (KV quantization, unresolved)

A one-off garbled-output ("!" character burst) incident in real use. Ruled
out: KV quant precision (perplexity impact measured negligible, speculation is
exact by construction), the LOOKUP_ADAPTIVE prefix-cache bug (not reachable at
this box's draft-token count), vLLM upstream issue #43713 (lives in a parser
class this stack's `qwen3_coder` architecture doesn't use). Never reproduced
despite dedicated repro attempts. Not fully closed: one academic paper (arXiv
2606.09864) flags this box's exact KV quantization shape (4-bit K / 2-bit V)
as a plausible risk class for speculative decoding specifically, but live
PPL/GSM8K/needle-in-haystack numbers show no measurable effect — treated as a
low-probability tail event, not a known bug, unless it recurs. Mitigation
(not a fix — root cause lives in third-party binary inference code):
`detectCorruption()` in `mcp-qwen/index.js` flags a repeated non-benign
character (5+) or a 40-char block repeating 3+ times on every response;
`ask_qwen`/`ask_qwen_fast` auto-retry once (safe, no side effects);
`delegate_coding_task` cannot safely auto-retry (Goose may have already
written files) so it surfaces a loud warning instead.

## vLLM serving recipe knobs (tracks upstream syv-ai/qwen38-27b-rtx3090)

Two correctness-relevant defaults, both verified via `bench/quality_battery.py`
(PPL + 200-question GSM8K):
- `VLLM_DFLASH2_LOOKUP_ADAPTIVE=0`, set permanently in `launchers/start_huge.sh`.
  No-op at this box's `DFLASH_TOKENS=7` (the adaptive path only activates above
  7 drafts), kept to document intent if `DFLASH_TOKENS` is ever raised.
- `SPEC=dflash2 CTX=huge` runs `cudagraph_mode=FULL_AND_PIECEWISE` (upstream
  default as of `82bd62d`/`b356e31`). GSM8K 96.5% (FULL) vs 95.0% (PIECEWISE),
  matching upstream's own measurement. `SPEC=mtp CTX=huge` must stay on
  `PIECEWISE` — confirmed correctness bug under FULL (empty answer at one
  prompt-length residue in 128) that dflash2 doesn't share.

## Claude Desktop config file gotcha

Registration lives in `mcpServers` inside
`C:\Users\Apath\AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude_desktop_config.json`
— **not** `~/.mcp.json` or `~/.claude/settings.json`, and not the
normal-looking `AppData\Roaming\Claude\claude_desktop_config.json` either (this
MSIX-packaged install silently redirects writes to the `Packages\...\LocalCache`
path; editing the normal-looking path does nothing). Check the Developer tab in
Settings ("Local MCP servers" > "Edit Config") to confirm which file is live.

## Claude Code / Desktop MCP timeout research (2026-08-23)

Whether `MCP_TOOL_TIMEOUT` is actually configurable and honored, since the
async taskId/poll design is only worth keeping if it can't just be raised.
Docs describe it as configurable with a very long default (~28h) for
local/stdio servers like this one — on paper this server shouldn't need the
workaround. In practice, multiple open, unresolved `anthropics/claude-code`
issues report it isn't honored for Claude Code specifically, not just Desktop:
[#16837](https://github.com/anthropics/claude-code/issues/16837),
[#22058](https://github.com/anthropics/claude-code/issues/22058),
[#47076](https://github.com/anthropics/claude-code/issues/47076) (reopened 6+
times, closed stale each time). Decision: keep the taskId/poll pattern
regardless of transport or client — it doesn't depend on the timeout config
being honored, so can't be broken by this bug class. Do not trade it for an
env var on the strength of docs alone.

## FlashInfer relevance, CTX=long vs CTX=huge, and MAX_SEQS raised to 8 (2026-08-24)

Three linked questions from the user after the 2026-08-24 boot-warning
cross-check first landed (MAX_SEQS at 4, FlashInfer/CUDA toolkit flagged but
not installed): is FlashInfer actually irrelevant to our config, is `CTX=long`
maybe better than `CTX=huge`, and why stop MAX_SEQS at 4 — with explicit
authorization this time to install a system CUDA toolkit if warranted and to
keep testing MAX_SEQS further.

**FlashInfer.** Re-grepped the full repo (README, docs/*.md, every .py/.sh
that mentions it) rather than re-reasoning from memory. Two separate
FlashInfer usages exist in vLLM, and neither applies to us:
1. The fp8-KV attention backend, used only when `CTX=long` (150k, int8/fp8 KV)
   is selected — README, verbatim: "vLLM 0.27.1's FlashInfer backend (needed
   for fp8 KV, i.e. for 150k context) four drafts crash the engine...". Our
   default is `CTX=huge`, which uses KVarN (a Triton-kernel 4/2-bit KV cache)
   and never touches this backend regardless of whether FlashInfer is
   installed.
2. The optional FlashInfer top-k/top-p *sampler* — this is what the boot
   warning ("DFlash2 selector uses torch.topk... at roughly half the speed")
   is actually about. Checked whether it's even reachable: `grep -rn
   VLLM_USE_FLASHINFER_SAMPLER` shows it hardcoded to `0` in
   `single-user/start_qwen.sh` (and in every calibration/drafter script), with
   an inline comment explaining why — "flashinfer's sampling.cu does not build
   with older system nvcc (12.0)". So this repo already deliberately disables
   the exact FlashInfer path the warning refers to, on correctness/build
   grounds unrelated to whether CUDA_HOME is set. Separately, "the DFlash2
   selector" in the boot warning's own wording is misleading — DFlash2's real
   candidate selector is a named submodule of the drafter's own weights
   (`candidate_selector`, referenced in `drafter/quant_dflash2.py`), not a
   FlashInfer consumer at all. The warning is vLLM's stock generic message for
   a code path this recipe's own patches (small-topk-fast-softmax, documented
   in `docs/optimizations.md` point 6) already replace with a *deliberately
   chosen* `torch.topk`-based implementation — described there as a genuine
   optimization ("+4% at default sampling"), not a fallback being tolerated.
   **Conclusion: installing the CUDA toolkit would fix a warning that already
   doesn't describe an active code path for CTX=huge. Not installed** — this
   supersedes the earlier "flagged, not fixed" framing; it's now "investigated
   and confirmed unnecessary," not merely deferred.

**CTX=long vs CTX=huge.** Re-read the README's own single-stream and
speculator-depth tables directly rather than trusting an earlier summary.
`CTX=long` (114-139k effective, fp8 KV via FlashInfer, k=3 drafts — k=4
crashes the FlashInfer backend under concurrent finish/mid-generation,
"club-3090 reports the same n=4 eventually dies, n=3 stable" pattern) is
*slower* on single-stream decode than even `CTX=fast`: 96/102 tok/s vs
`CTX=fast`'s 121/120, vs `CTX=huge`'s DFlash2 path at 130/133 tok/s C1 (up to
259-381 tok/s reproducing context via lookup drafting, which `CTX=huge` alone
supports at 245k). `docs/long-context.md`'s own description of `CTX=long`:
"worth it only for context reproduction" — i.e. upstream's own docs already
scope it as a narrow-use-case config, not a general-purpose alternative to
`CTX=huge`. Given our actual use (single orchestrator session, general
coding/research delegation, not verbatim-document-reproduction workloads),
`CTX=huge` wins on both context size (245k vs 114-139k) and speed. **No
config change** — confirms the existing default was already correct, not a
lucky guess.

**MAX_SEQS raised 4 -> 8.** Read the README's own MAX_SEQS section in full
this time (previously only the summary sentence had been read): raising it
"grows the captured decode graphs, which is why the default stays low rather
than because it would cost you context" — i.e. the tradeoff is one-time boot
memory/time, not runtime throughput or context budget. Confirmed this is
orthogonal to the separate PIECEWISE-vs-FULL_AND_PIECEWISE correctness
question (also re-verified while in there — see below). Bumped
`launchers/start_huge.sh`'s `MAX_SEQS` to 8 (upstream's own fully-tested
ceiling — going further would be extrapolation, not verification, so 8 is
being treated as the practical top absent new evidence) and rebooted live.

Verified, not assumed: `GPU KV cache size: 268,169 tokens` — byte-for-byte the
same figure as the MAX_SEQS=2 and MAX_SEQS=4 boots. No new errors anywhere in
the boot log (grepped for error/fail/crash/illegal-memory-access, excluding
the four already-known cosmetic lines). Only observed change:
`max_cudagraph_capture_size` went 32 → 64 and `cudagraph_capture_sizes`
lengthened to `[1,2,4,8,16,24,32,40,48,56,64]`, adding ~15s of one-time
compile/capture time (torch.compile itself: 36.00s, unchanged in kind from the
MAX_SEQS=4 boot). Matched `MAX_CONCURRENT_GOOSE` in `mcp-qwen/index.js` to 8,
updated the tool-description text, and re-ran `node --check index.js` (OK).

**Process note, for future long-boot waits from this shell:** three separate
booby traps hit in a row while trying to background this reboot from the
Windows/Git-Bash side of the Bash tool, worth remembering:
1. `wsl -d Ubuntu -- bash -c "cmd &"` (job backgrounded *inside* the `bash -c`
   string) does not survive — the `wsl.exe` process exits as soon as the
   backgrounded job returns control, and WSL kills the child with it. `setsid`
   inside the same string did not fix this either.
2. Git Bash (MSYS) expands `~` in `wsl -d Ubuntu -- bash ~/foo.sh` *before*
   `wsl.exe` ever sees the argument, producing a garbled Windows-side path
   (`C:/Users/Apath/...`). Use the absolute WSL path instead.
3. Git Bash *also* auto-translates any argument that merely looks like a
   POSIX absolute path (`/home/apath/...`) into a Windows path by its own
   pathconv heuristic, even when it's meant for `wsl.exe` verbatim — turning
   `/home/apath/foo.sh` into `C:/Program Files/Git/home/apath/foo.sh`. Fix:
   prefix the call with `MSYS_NO_PATHCONV=1`.
The combination that actually worked: `MSYS_NO_PATHCONV=1 wsl -d Ubuntu --
bash /home/apath/qwen-serving/launchers/start_huge.sh` run via the Bash tool's
own `run_in_background:true` (letting the harness hold `wsl.exe` open, rather
than trying to background anything inside WSL itself). For polling a
long-running boot without spending a turn per check: watch the harness output
file directly for a *specific* marker string (`Application startup complete`
or `Uvicorn running`) — a broad `grep -qi error` against vLLM's own boot log
false-positives immediately on benign lines already present at cold boot
(`AssertionError` from the expected/known `deep_gemm`/`CUDA_HOME` import
failure, and the literal string `Traceback (most recent call last):` from
that same benign exception's own printed stack). Both false-positives were hit
live this session before landing on a marker specific enough to be reliable.

## WSL environment MCP gap & cross-environment sync (2026-08-25)

An audit of a live session where Gemini 3.7F in Antigravity IDE connected to a
remote WSL workspace (`/home/apath/Work/temp/final`) revealed that the model
never invoked `delegate_coding_task` despite starting the vLLM server.
Root-cause analysis showed:

1. **Remote-WSL Config Asymmetry**: Antigravity running via Remote-WSL resolves
   global customization roots from Linux paths (`/home/apath/.gemini/config/`),
   not the Windows host (`C:\Users\Apath\.gemini\config\`).
2. `/home/apath/.gemini/config/mcp_config.json` was 0 bytes, and
   `/home/apath/.gemini/GEMINI.md` did not exist. The remote agent context
   received 0 MCP tools and no delegation rules.
3. Path translation: Spawning Node on Windows from within WSL requires
   explicit paths (`/mnt/c/Program Files/nodejs/node.exe D:\LLM_Ecosystem\mcp-qwen\index.js`),
   as bare POSIX paths (`/mnt/d/...`) fail module resolution when passed to a Windows binary.

**Fix Applied & Verified**:
- Populated `/home/apath/.gemini/config/mcp_config.json` with the `node.exe` command
  and `D:\LLM_Ecosystem\mcp-qwen\index.js`.
- Created `/home/apath/.local/bin/node` wrapper executable in WSL.
- Mirrored `GEMINI.md` to `/home/apath/.gemini/GEMINI.md` and `CLAUDE.md` to
  `/home/apath/.claude/CLAUDE.md`.
- Live verified from WSL via `mcp_client_test.js`: all 6 tools registered,
  Goose subprocess executed, written files created and tested with 0 errors.

## SOTA Multi-Agent Hardening: Vision Role Division, Session Drift Fix, & Polling Invariants (2026-08-26)

An architectural audit of session traces (`8233615f-6a9b-4b4b-b4b0-649b77f6dc36`) evaluating `TreeMap-Disk-Visualizer` surfaced three systemic operational findings:

1. **Vision Tool Misalignment on Worker vs. Lead**:
   - **Context**: The worker model (Qwen 3.8-27B) is served via vLLM with `Universal 245K Context` and `--language-model-only` (dropping the 2.7 GB vision tower to dedicate all 24 GB VRAM to KV pool and DFlash2 speculative decoding).
   - **Problem**: Passing visual browser tools (`@playwright/mcp` with screenshot mode) to Qwen causes execution failures and hallucinations because the engine has no vision encoder.
   - **Fix**: Codified strict Prescriptive Role Division in `CLAUDE.md`, `GEMINI.md`, and `mcp-qwen/index.js`:
     - **Lead Architect**: Holds native vision capabilities for rendered UI inspection, screenshot audits, and multimodal QA (`browser_subagent`).
     - **Local Worker**: Pure text-only execution for AST/code manipulation, text DOM inspection, accessibility trees, API/curl endpoints, and 245K-context document ingestion via `uvx free-search-mcp` and `npx.cmd -y context7@latest`.

2. **Session Persistence Drift & `--resume` Crash**:
   - **Problem**: `mcp-qwen/index.js` tracked session existence using an in-memory `Set` (`knownSessions`). If the process restarted or session files were not saved by Goose, passing `--name <id> --resume` caused Goose to immediately crash with `Error: No session found with name '<id>'`.
   - **Fix**: Replaced in-memory tracking with dynamic disk-grounded session discovery (`sessionExistsOnDisk` querying `goose session list`), passing `--name <id>` for new sessions and `--name <id> --resume` only when verified on disk.

3. **Status Polling Storms & Turn Inflation**:
   - **Problem**: Lead agents executing 20s–30s polling loops on `qwen_task_status` burned ~150 conversational turns and accumulated massive cache-read tokens over 14 minutes.
   - **Fix**: Added explicit Mandatory Invariant across all master documents:
     - **Turn Conservation**: Highly prefer waiting on reactive system notifications. Polling intervals of **180+ seconds** are the minimum **IF AND ONLY IF NECESSARY**.

## v4.0.0 -> v4.1.0: Zero-Turn Long-Poll Wait, 3-Tool Consolidation, 1-Hour Budget (2026-08-26/27)

Closes the history gap left by the v3.5.0 -> v4.0.0 -> v4.1.0 commits
(`8c1648f`, `78afe41`, `2276965`, plus the 2026-08-27 audit pass), which
postdate the last entry above.

**Tool surface consolidated to 3.** The five-tool surface (ask_qwen /
ask_qwen_fast / delegate_coding_task / qwen_check_task / qwen_cancel_task)
collapsed into: `qwen_coworker` (the delegate path, plus session_id/cwd/
extensions and the AVO fields), `qwen_task` (status/cancel/list over one
in-memory task registry), `qwen_server` (vLLM lifecycle). Rationale: the
2026-08-23 post-mortems showed the caller drifting between overlapping
async-semantics tools mid-session; three tools with mutually exclusive jobs
don't. `update_schemas.py` regenerates the Antigravity-side JSON schemas
from the same definitions, and package.json now tracks the server version
(4.1.0).

**RACE_MS 50s -> 45s.** 50s was "under Claude Desktop's 60s" with a 10s
margin; 45s widens that to 15s on Desktop while staying far under
Antigravity's 180s, so one constant is now documented as safe for both
surfaces (index.js header).

**Zero-turn long-poll wait endpoint (the big one).** The 2026-08-23
read-only GET /task/<id> endpoint grew into the full zero-turn design:
GET /task/<id>/wait now holds the HTTP connection open until the task
finishes and streams the final summary as the response body - the caller's
`curl` (or `run_command`) simply sleeps at $0 token cost and wakes with the
answer, no LLM turns in between. This is what makes the 45s race actually
useful: the client gets a `taskId` + `wait_command` before its own deadline,
the long-poll carries it past the 1-hour budget, and completion is pushed,
not polled. Added: GET /tasks (all active), POST /task/<id>/cancel
(process-tree kill, same path as the watchdog), 3h retention. The
multi-instance caveat (one 18021 owner per set of Claude surfaces, noted in
the 2026-08-23 entry) is now handled instead of assumed: non-owning
instances set `statusServerOwned=false`, and their 45s-yield/status messages
tell the caller to poll qwen_task at 180s+ instead of handing out a curl
that would 404 against the other instance.

**400s fixed budget -> 1-hour budget + 10-minute inactivity watchdog.**
DEFAULT_TIMEOUT_MS 400s -> 3,600,000ms and the kill logic split into two
axes: a hard 1-hour total budget (AVO evolution loops and deep-research
runs legitimately need it) plus a 10-minute zero-stream-chunk inactivity
timeout as the real liveness guard (kill on silence, not on age). The old
flat 400s was the wrong axis - it killed healthy long tasks while letting
genuinely stuck ones burn the whole thing (the verify:true post-mortems).
The extensions bonus (+10min) and the per-task total are still threaded
through every status message.

**AVO lineage engine (avo_engine.js) + AVO fields on qwen_coworker.**
`hypothesis`/`test_command`/`metric_name`/`higher_is_better` drive
AvoLineageEngine: after the Goose run, the MCP server itself executes the
test command (powershell/bash, 5min cap), extracts the named metric from the
output, and records an immutable candidate in <cwd>/.avo/lineage.json with
git commit provenance (improvements move bestCommit; regressions stay in the
record for inspection - no auto-rollback, per the 2026-08-25 "no destructive
hard resets" decision). scripts/avo_runner.py is the standalone driver: one
round per invocation - reads the lineage, asks the local model (direct
/v1/chat/completions call) for the next hypothesis, writes a dispatch packet
to .avo/avq/ and prints the exact qwen_coworker call. It never writes
lineage.json itself - the engine owns that file.

**2026-08-27 audit (this pass).** The first cut of the AVO wiring (committed
in `2276965`) had a contract mismatch: index.js called `getLineageContext()`
/ `extractMetric()` which didn't exist on the engine (silently swallowed ->
AVO context never injected, candidates never recorded), and called
`recordCandidate` with the wrong keys and no `await` (would have recorded
garbage-FAILED entries). Fixed: the engine now provides `getLineageContext()`
(async alias of getLineageBrief) and `extractMetric()`, and `recordCandidate`
accepts both its native keys and the MCP server's caller keys; index.js
awaits both calls and captures the real test exit code. Also: POSIX spawn is
now `detached` so the process-group kill (-pid) in killProcessTree actually
works (Windows still uses taskkill /T /F); qwen_server status now reports the
server's actual advertised max_model_len instead of a hardcoded 245,760
(and distinguishes huge vs fast). The previously-uncommitted "Operational &
Tooling Directives" prompt block in index.js (prefer native read/edit/
write/patch/tree over shell; CRLF line-ending guidance for Windows
workspaces; powershell -NoProfile invocation guidance) was audited and kept
- it replaces the single-line shell-mismatch counter-instruction from the
2026-08-23 session-1 entry with a structured set of directives.

## Engine-core wedge incident; wedge detection + first-token timeout (2026-08-28, v4.2.0)

The ">10min MCP failure with GPU at 100%" incident, root-caused entirely from
on-disk traces: vLLM engine log (`/tmp/mcp_launch_huge.log` in WSL), goose
per-request logs (`%APPDATA%\Block\goose\data\logs\llm_request.*.jsonl` — **1 line
= request sent, zero chunks ever received; multi-line = streamed/healthy**), task
state (`~/.qwen/tasks/`), and the per-surface MCP client logs under
`claude-cli-nodejs\Cache\<project>\mcp-logs-qwen38-local\`.

**Timeline (local time):** vLLM booted 13:29. A heavy large-context goose session
ran 14:03–14:32 (240–370KB request logs ≈ 60–90k-token prompts, streaming
normally). One such request settled into `Running: 1 reqs` at 13.7 tok/s (vs the
77–133 spec) holding 39.9% of the KV pool (~107k tokens), decayed to 0.0 tok/s by
14:29:06, and stayed "Running" and silent for 20+ min. From 14:42 new requests
received zero response chunks. ~14:51 the engine stats loop itself went silent —
vLLM prints an `Engine 000: ... Running:` stats line every 10s *unconditionally*
(idle or busy), so a 4.5h gap in those lines is the engine core hung, while the
API process stayed up (port answered, requests accepted then never scheduled) and
the GPU sat at 100%/24.1GB generating nothing. Both audit dispatches (18:56:39,
19:07:33) hit this: goose sent a well-formed streaming request, received zero SSE
chunks, emitted zero stdout/stderr, and the 600s inactivity watchdog killed each
at exactly 601s with `toolCallsCount: 0` — the caller's DB-timeout retry theory
was wrong; no tool ever ran. ~19:21 the core spontaneously unwedged (a 69s "OK"
health check squeezed through at 5.5 tok/s), after which the orchestrating session
deliberately stopped vLLM via `qwen_server stop`.

**Root cause, status:** engine-core deadlock during DFlash2 speculative decode of
a ~100k-token context. Prime suspect `VLLM_DFLASH2_CHAIN=1` (enabled in eeb138c
at 2026-08-28 00:42; this was the first heavy long-context day under the flag) —
one day of correlation, not proof. User decision: **keep CHAIN enabled, add
detection instead**. The 4-bit-K/2-bit-V + speculative-decoding risk class
(arXiv 2606.09864, noted in the serving-stack entry above) remains the adjacent
suspect. Ruled out: the MCP server, goose, Claude Code timeouts, the prompts.

**Fixes (v4.2.0):**

1. **Engine wedge detection + auto-heal.** Port-answering was the only health
   signal and it passes while the core is dead. `engineWedgeState()` reads the
   last stats line from the engine log via WSL and declares a wedge at >120s of
   silence (`QWEN_WEDGE_SILENCE_S`); a busy engine still prints stats, so the
   signal is load-independent. `qwen_server status` now reports live gauges
   (running/waiting reqs, KV %, stats age) and auto-reboots on wedge
   (`QWEN_AUTO_HEAL=0` disables); `ensureServerRunning` runs the same gate before
   every dispatch, so `qwen_coworker` self-heals instead of hanging 600s. Heal is
   cross-instance-guarded with a stamp file (`~/.qwen/tasks/.engine_heal.lock`,
   5min TTL) because every Claude surface runs its own copy of this server —
   in-process locks do not serialize them.
2. **First-Token Timeout (120s, `QWEN_FIRST_TOKEN_TIMEOUT_MS`).** Distinct from
   the 600s mid-stream heartbeat: zero goose output within 120s of spawn → kill
   and fail with an explicit "engine wedged or saturated, no work performed"
   message. A wedged engine previously cost 10 min of GPU burn per attempt.
3. **No DFlash2/CHAIN change and no context cap** (user decisions): 245K context
   is the point of the stack; 100k-context ingestion stays allowed. Open perf
   question for a later upstream check: ~100k-ctx decode ran at 13 tok/s even
   before stalling.

**Queue semantics confirmed while in here** (answers a standing multi-session
question): `MAX_CONCURRENT_GOOSE=1` is per-MCP-server-process, and each Claude
session/surface spawns its own process — so N sessions run up to N concurrent
goose processes against the engine's MAX_SEQS=8; only same-session calls
FIFO-serialize. Queued tasks are **never** heartbeat-killed: `startedAt` is null
while queued (set only at dequeue) and the watchdog lives inside the spawned task,
so neither the 600s heartbeat nor the 1h budget ticks while queued. The one real
cross-session hazard is engine saturation (N × ~100k contexts > the 268k KV pool →
later requests wait at the engine for their first chunk) — previously that
silently became a 601s kill; it is now the 120s first-token kill, with the status
gauges to tell saturation (Running/Waiting high) from a wedge (stats silent).

MCP server processes pick this up only after the owning session restarts its MCP
connection — running sessions keep the old code until then.

## Global cross-process goose semaphore (2026-08-28, v4.3.0)

Direct follow-up to the queue-semantics note above: the per-process
`MAX_CONCURRENT_GOOSE=1` FIFO was useless across sessions — every Claude surface
spawns its own copy of this server, so N sessions = N processes = N concurrent
gooses against one GPU regardless of the limit (exactly the load shape that
afternoon). Replaced the in-process semaphore with a disk-lease semaphore every
instance shares:

- **Lease files**: `~/.qwen/goose_slots/slot_<i>.json`, claimed atomically with an
  O_EXCL (`wx`) open — one winner per slot, no coordinator process needed.
- **Heartbeat**: holders rewrite `hb` every 15s. Reclaim rules: pid dead +
  lease >90s stale, or pid alive but silent >5min (a wedged holder — its own task
  watchdog fires at 600s/120s long before the 5min mark, so a silent-live holder
  is abandoned by definition). Reclaim renames the file first (atomic) so racing
  reclaimers can't both win; holders detect theft (pid mismatch on heartbeat) and
  refuse to unlink a foreign lease on release.
- **Semantics preserved**: default 1 = the strict one-goose-at-a-time `fac3113`
  intended, now actually enforced machine-wide. Task entries stay `queued`
  (startedAt null, watchdog-exempt, no budget ticking) until they hold a slot —
  identical to the old per-process queue semantics, now global. Cancelled-while-
  queued tasks now abort slot acquisition instead of running anyway (a gap in the
  old `attempt()` path). `QWEN_MAX_CONCURRENT` raises the cap globally; keep it
  ≤ engine MAX_SEQS=8 or dispatches queue invisibly inside vLLM instead of here,
  where the first-token timeout would kill them.
- **Observability**: `qwen_task` queued messages now name the current slot holder
  (taskId) across all sessions — cross-session contention is finally visible to
  each orchestrator.
- **Rollout caveat**: leases only coordinate new-code instances; old-code
  processes (sessions started before the MCP restart) bypass them entirely.
  `test_global_semaphore.js` exercises in-process exclusion, hand-off, and
  cross-process exclusion against the shipped code (no vLLM/goose needed).
- **Why not strict global FIFO**: exact FIFO ordering across processes would need
  a sequencing protocol on top of the leases; slot-poll ordering is approximately
  fair and — with the default of 1 — ordering is all but irrelevant. Not built.



## 2026-08-29: Recurring engine wedge - diagnosis and remediation (SUPERSEDES the CHAIN theory)

Five wedges in ~36h, each minutes after boot and always mid-delegation (large-prompt
tasks). A live py-spy capture of the wedged EngineCore (see
`diagnostics/2026-08-29_kvarn_pyspy_dump.txt`) shows the core loop's MainThread
spinning at ~100% CPU inside a single `execute_model` step:

    _cached_multiquery_path  kvarn_attn.py:2496   (total_k = int(cu_k[-1].item()))
    forward                  kvarn_attn.py:2171

**Mechanism (corrected by full kernel read-through):** line 2496 is the *first D2H
sync of the eager continuation step* - it gates on everything previously enqueued.
`_kvarn_build_packed_kv_kernel` itself has **no loops** and cannot spin; the wedged
kernel is a loop-carrying one (`_kvarn_fused_decode_kernel` / `_kvarn_fused_decode_stage1`
/ `_kvarn_fused_verify_stage1` / FA varlen) bounded only by `seq_lens`/`vq_seqlen`/
`cu_k`, OR the CUDA context is dead from an unpropagated IMA (a known WSL2 failure
mode). Grid explosion and autotune-deadlock are ruled out (Python-int bounds;
autotuned kernels warmed pre-capture). One concrete latent defect found:
`triton_kvarn_decode.py` computes `tile_base` from the **raw** `block_id` instead of
the range-clamped `safe_bid` at four sites (257, 435, 584, 1124 pre-patch) - the only
unmasked far-OOB read in the hot path; on WSL2 the resulting IMA can wedge the context
instead of raising (same silent-fault class as upstream issue #34).

**Config deviation (D1) - FALSIFIED AS CAUSE by the A/B:** upstream's `kvarn-v2-runner.patch`
header, README, and gotcha 37 all say that with prefix caching on, the DFlash2 verify
step must NOT be a captured FULL CUDA graph (`cudagraph_mode=PIECEWISE` required). We
ran FULL - but the A/B (benchmarks/wedge-repro/RESULTS.md) shows PIECEWISE wedges
identically, as does fused-verify routing (`KVARN_FUSED_VERIFY_MAXQ=4096`), as does
the defensively-patched build. The graph-capture question stays a documentation
contradiction for the upstream issue, not our root cause. The A/B verdict: **the stall
is a first-large-chunked-prefill-after-boot event, config-independent** - always right
after the first-execution JIT pair (`_prepare_dflash_inputs_kernel`,
`_kvarn_build_packed_kv_kernel`), no Xid/MMU faults, CPU-side metadata sane, and
engines serve cleanly once the first stall passes (24 consecutive clean iterations
observed post-stall; early post-stall requests run 10-100x slower). Working theory for
upstream: a first-execution / Triton-JIT-on-first-real-shape interaction on WSL2.

**Phantom correction (D2):** `VLLM_DFLASH2_CHAIN` is read by NOTHING in our venv -
the n-gram-chains feature (upstream issue #38) lives in an external repo that was
never installed, so the earlier CHAIN=1 -> CHAIN=0 arc toggled nothing; every wedge
happened under an identical config. The feature is also documented greedy-only while
our delegated workloads run at temperature 1.0 (goose sends temperature: null). The
env line is removed from `start_huge.sh`.

**Trigger localization:** `_cached_multiquery_path`'s materialize route is only reached
for multi-query batches with `max_query_len > KVARN_FUSED_VERIFY_MAXQ (8)` - i.e.
**chunked-prefill continuations of large prompts** (max-num-batched-tokens 2048).
Small smoke-test requests never wedge; delegated repo-reading (10k+ token prefills)
hits it within minutes.

**Interim mitigation (in place):** the v4.5.0 canary-completion gate + auto-heal
detects the stall end-to-end in <=30s and reboots the engine; the in-flight task dies
with a clear watchdog message and can be re-dispatched. A machine-wide persisted wedge
counter is surfaced via `qwen_server status` for A/B-vs-production comparison.

**Remediation stack (final, after the patch was reverted):** (1) **boot warmup in
mcp-qwen (the production fix)** -
after any engine (re)start, `ensureEngineWarmed()` fires one synthetic ~24k-token
prompt (420s window, up to 3 attempts, riding out the stall via the existing
canary + auto-heal), tracked by the cumulative prefix-cache-queries counter which
resets on engine restart; dispatches refuse an engine whose warmup failed
outright. `QWEN_BOOT_WARMUP=0` disables. (2) ~~defensive kernel patch~~
**REVERTED - it aggravated the stall**: with `tile_base` sourcing the
range-clamped `safe_bid` (4 triton sites) plus the Python-side guards, EVERY
fresh boot's first big request hung the GPU deterministically (4/4 boots across
two arms), while the pristine kernel only rarely wedges and completed the same
workload cleanly on the first try. Most plausible mechanism: the edited kernel
compiles to a different variant whose first real-shape launch hangs the stream
on this WSL2/Triton stack. Lesson: on this stack, ANY change to Triton kernel
source creates a new compiled variant that must be soak-tested before serving.
`~/qwen-serving` is back to pristine upstream (2ae239f). (3) upstream issue
first, PR after maintainer reply (user decision);
`benchmarks/wedge-repro/ISSUE_DRAFT.md` is the draft - its "remaining suspicion"
section carries extra weight now, since the pristine-kernel rare wedge and our
aggravated variant share the same first-JIT-launch signature.

## 2026-08-29: Issue #48 filed, dispatch `--exec` fix, and test isolation (v4.5.3)

1. **Upstream issue #48 filed & attachments published**:
   - Issue: [syv-ai/qwen38-27b-rtx3090#48](https://github.com/syv-ai/qwen38-27b-rtx3090/issues/48)
   - Cross-link: [syv-ai/qwen38-27b-rtx3090#25 (Comment #5462775920)](https://github.com/syv-ai/qwen38-27b-rtx3090/issues/25#issuecomment-5462775920)
   - Attachments Gist: [Gist 532337dcf4b66a66729d8ae68df9d435](https://gist.github.com/ApatheticMioz/532337dcf4b66a66729d8ae68df9d435) attached in [Comment #5462825503](https://github.com/syv-ai/qwen38-27b-rtx3090/issues/48#issuecomment-5462825503), containing `repro.py`, `wedge_pyspy_enginecore.txt`, `wedge_001_104300_englog.txt`, `wedge_001_152027_englog.txt`, and `iterations_unpatched.jsonl`.

2. **Dispatch `--exec` spawn fix**:
   - In `ps` inspection of Goose processes, arguments appeared as `Prefer native Goose tools (, , , , )`. Spawning `wsl.exe -d Ubuntu -- <cmd>` ran through login shell bash, executing backtick-quoted tool directives as command substitutions.
   - Fixed by switching `wsl.exe` spawn to `--exec /home/apath/.local/bin/goose` and updating `sessionExistsOnDisk` to use `--exec`.

3. **ESM Import & Test Harness Isolation (`isMain`)**:
   - `index.js` unconditionally ran `main()`, attached `StdioServerTransport`, and started `statusHttpServer.listen(18021)` upon module import.
   - When test suites (`test_global_semaphore.js`) imported exported semaphore helpers, child processes collided on port 18021 and hijacked stdio.
   - Guarded `main()`, `statusHttpServer.listen()`, and `cleanOldTasks` interval with `isMain` (`path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)`). `test_global_semaphore.js` now passes in ~8s without watchdogs.

4. **Upstream Commit Reference State**:
   - `~/qwen-serving`: Local `2ae239f` (pristine base), upstream `origin/main` is `69ba4d0` (112 commits ahead; PR #38 n-gram chains `c954724`, Docker distribution, etc.).
   - `d:\LLM_Ecosystem\llama-cpp`: Build 10566, commit `bb4caa754`.

## 2026-09-03: Issue #48 resolved upstream, synced to HEAD (8d832f8), and full venv rebuild

1. **Issue #48 Root Cause & Resolution**:
   - Issue: [syv-ai/qwen38-27b-rtx3090#48](https://github.com/syv-ai/qwen38-27b-rtx3090/issues/48) closed 2026-09-02 by @mhenrichsen.
   - Mechanism: Triton kernel JIT compilations inside the first real chunked-prefill request stalled the CUDA stream under WSL2 during host-device synchronization (`cu_k[-1].item()`).
   - Root Causes Identified:
     a. `_prepare_dflash_inputs_kernel`: Capture dummy passes only exercised small `BLOCK_SIZE` values; request 1 was the first time `BLOCK_SIZE=256` was evaluated. Fixed in `05d1a0e` (`patches/dflash2-prewarm.patch`).
     b. `_kvarn_build_packed_kv_kernel`: Warmup used a 1920-column block table (divisible by 16) vs serving runner's 1921 columns (1 column slack, not divisible by 16). Triton specialized on divisibility-by-16 for `stride_bt_b`. Fixed in `201d237` (`do_not_specialize` on `stride_bt_b` + construction-time `NUM_BLOCKS_LOOKUP` upper bound).
     c. Rejection Sampler Trio (`_compute_local_logits_stats_kernel`, `_rejection_kernel`, `_resample_kernel`): Dummy sampler runs had `num_draft_tokens == 0`. Fixed in `201d237` (`patches/spec-sampler-prewarm.patch`).
   - Verified 0 in-request JIT compiles across RTX 3090 and 4090 boxes.

2. **Upstream Git Sync (`69ba4d0` -> `8d832f8`)**:
   - Pulled 104 commits from upstream `origin/main` to local `~/qwen-serving`.
   - Key improvements incorporated:
     - PR #57 / PR #67: Sized int4 3D scratch buffers in query tokens and allocated them *inside* the memory budget (`patches/spec-decode-scratch-within-budget.patch`).
     - PR #65 / PR #59: Fixed launchers to use bash arrays (`ASYNC_ARGS`, `TOOL_ARGS`, `METRICS_ARGS`) to eliminate `set -e` failure modes.
     - `verify.sh`: Added `superseded_by()` logic for evolving patches (`5259fc7`).
     - WSL2 CPU Offload: Device-VA translation fix for OffloadingConnector (`patches/offload-wsl2-devptr.patch`).
     - Mamba Prefix Caching: Opt-in state snapshot retention fix (`patches/mamba-align-checkpoint-order.patch`).

3. **Rebuild Execution via `uv`**:
   - Replaced `vllm==0.27.1` cleanly with `uv` in 173ms.
   - Installed `flashinfer-cubin==0.6.13` via `uv` to enable full CUBIN selector acceleration.
   - Sequentially applied all 28 patches (`patches/*.patch`) with zero rejections.
   - Installed KVarN backend and runner patches (`bash kvarn/install.sh`).
   - `bash verify.sh --no-server` passed with **0 failures**.

4. **Optimal Knobs for Max Sustained Throughput & Max Context in the Same Config**:
   - **Context**: `CTX=huge` delivers the maximum **245,760 tokens** context window (268,169 token KV pool) on the single RTX 3090 24GB.
   - **Decode Throughput**: `SPEC=dflash2` provides 7-draft speculative decoding (~125–137 tok/s decode; ~60–63 tok/s at 72k depth; up to 382 tok/s on copy/edits).
   - **Prefill Throughput**: `INT8_ACT=int8` enables W4A8 Marlin tensor cores for all linears, boosting prefill speed by **+27% to +30%** (1,845 tok/s @ 1k, 1,423 tok/s @ 51k), with decode speed unchanged.
   - **Multi-turn Efficiency**: `PREFIX_CACHE=1` enables instant (~1–5s) follow-up turns on 100k prompts.
   - **Verify Stability**: `VLLM_DFLASH2_LOOKUP_ADAPTIVE=0` pins verify block length for stable prefix caching (+26% faster).
   - **Agent Concurrency**: `MAX_SEQS=8` preserves all 8 concurrent agent worker slots matching `MAX_CONCURRENT_GOOSE=8`.
   - **Metrics**: `REQ_METRICS=1` surfaces per-request latency & usage metrics.
   - Added these configurations to `/mnt/d/LLM_Ecosystem/scripts/wsl/start_huge.sh`.
