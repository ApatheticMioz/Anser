# Qwen3.8-27B local serving

Serves on `http://localhost:18020/v1` inside WSL Ubuntu (vLLM+DFlash2+KVarN). API
key: `wsl -d Ubuntu -- cat ~/qwen-serving/api_key.txt`. Exclusive with any other
process on the same GPU - nothing else may run on it, including the uncensored
server below (they deliberately share port 18020 - only one is ever up).

General delegation policy (when to hand work to this model vs handle it
yourself) lives in `~/.claude/CLAUDE.md`, not here. Investigation history and
rejected-design rationale for everything in this file lives in
`mcp-qwen/NOTES.md` - read it before reversing any decision below, not before
routine use.

## Configs

Windows-side launchers live in `scripts/`, one subfolder per server family
(reorganized 2026-08-24 - was a flat `scripts/*_qwen.bat` layout, moved to
`scripts/main/` once a second model was added, so alphabetical sort groups by
model instead of interleaving by verb):
- `scripts/main/start.bat` / `scripts/main/start_huge.bat` - default. 245,760
  ctx, ~77 tok/s.
- `scripts/main/start_fast.bat` - 57,344 ctx, ~107-130 tok/s. Only for a
  confirmed latency-critical loop; switching between configs costs ~45-90s.
- `scripts/main/stop.bat`.
- `scripts/status.bat` - unified, checks both this server and the uncensored
  one below (whichever is actually running on the shared port 18020).
- Reasoning effort defaults to `medium` server-side. Do not override to `xhigh`
  without a specific reason - it burns the token budget on reasoning and can
  get cut off mid-answer.

## Second model: abliterated Qwen3.8-27B (manual/academic use, not MCP-wired)

A separate, user-facing-only model added 2026-08-23 -
`JonathanColetti/Qwen3.8-27B-Uncensored-GGUF` (Q4_K_M, imatrix-calibrated,
Heretic abliteration), vision-capable. **Not part of the delegation
architecture** - `mcp-qwen`/Goose's automated path always targets the main
model above; this one is for direct/manual use only (`goose session` by hand,
or raw HTTP).

- Served via **llama.cpp** (`D:\LLM_Ecosystem\llama-cpp\`, native Windows CUDA
  build), not vLLM - confirmed live 2026-08-23 that vLLM's `vllm-gguf-plugin`
  (the only vLLM path to GGUF) has no tensor-name mapping for this model's
  `qwen3_5` GGUF architecture tag (`RuntimeError: Unknown gguf model_type:
  qwen3_5`), and it's the latest available plugin version - not a config fix.
  llama.cpp is GGUF's native engine, so it just works. Runs OUTSIDE WSL
  entirely because llama.cpp only ships prebuilt CUDA binaries for Windows,
  not Linux (Linux users are expected to build from source, which needs a
  CUDA toolkit this box deliberately doesn't have - see the FlashInfer
  writeup below for why).
- Model weights live in WSL at `~/qwen-uncensored/model/` (downloaded via
  `scripts/uncensored/download_model.sh`), read by the Windows-native
  `llama-server.exe` over the `\\wsl.localhost\Ubuntu\...` UNC path -
  works, just slow to load (~2.5 min for 16.8GB over the network
  filesystem vs local disk).
- `scripts/uncensored/start.bat` (reasoning on) / `start_noreason.bat`
  (reasoning off, `-rea off`) / `stop.bat`. Deliberately same port (18020)
  and `--alias qwen3.8-27b` as the main server, so Goose's env vars never
  need to change between them.
- **Single-line command, deliberately** - an earlier multi-line `^`
  continuation version broke mid-session (cmd.exe's continuation parsing
  failed partway through the flag list, so `--alias qwen3.8-27b` got
  interpreted as a separate command: `'qwen3.8-27b' is not recognized...`,
  killing an already-running server after ~4 hours of successful serving).
  Don't reintroduce multi-line continuation in these two scripts.
- KV cache: Q8_0 (K) / Q4_0 (V), `-fa on` (flash attention required for
  sub-Q8 V-cache quantization in llama.cpp). Context capped at 16,384 -
  deliberately modest, not the model's full 262k, per explicit ask (manual/
  occasional use, not a delegation workload).

## MCP registration

`qwen38-local` (`ask_qwen`, `ask_qwen_fast`, `qwen_status`,
`delegate_coding_task`, `qwen_check_task`, `qwen_cancel_task`) is registered
globally across both Windows and WSL environments. Server implementation:
`mcp-qwen/index.js`.

- **Windows Antigravity IDE**: Registered at `C:\Users\Apath\.gemini\config\mcp_config.json`
  and rules at `C:\Users\Apath\.gemini\GEMINI.md`.
- **WSL Remote Antigravity IDE**: Registered at `/home/apath/.gemini/config/mcp_config.json`
  (using `/mnt/c/Program Files/nodejs/node.exe D:\LLM_Ecosystem\mcp-qwen\index.js`),
  rules at `/home/apath/.gemini/GEMINI.md`, and wrapper at `/home/apath/.local/bin/node`.
- **Claude Code**: Registered at `~/.claude/CLAUDE.md` (both on Windows and at `/home/apath/.claude/CLAUDE.md`).
- **Claude Desktop**: Config lives at
  `C:\Users\Apath\AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude_desktop_config.json`
  (not `~/.mcp.json` or standard AppData roaming; confirm via Settings > Developer > "Local MCP servers" > "Edit Config").

`delegate_coding_task` spawns `goose.exe` (`C:\Users\Apath\.local\bin\goose.exe`)
as a subprocess per call - it is not a text relay, it runs a real agentic loop
with file/edit/shell tools and (optionally, via `extensions`) any stdio MCP
server. `mcp-qwen/index.js` is a persistent stdio process - editing it requires
a client restart (Claude Desktop or Claude Code) before changes take effect.

**Known limits, current state (see `mcp-qwen/NOTES.md` for how these were found):**
- Goose has no Windows shell-selection config (`cmd.exe` only); its own system
  prompt still nudges PowerShell-only cmdlets. Mitigated via a prompt-level
  counter-instruction, not fixed - no upstream config exists (block/goose#7837).
- Qwen never self-verifies (no build/typecheck/test pass) - there is no
  `verify` option anymore, removed after a ~1-in-16 real-world success rate
  for self-checking. Always verify the result against disk yourself.
- Time budget: 400s normally, 900s if `extensions` is non-empty (a first-time
  npx package download alone can cost ~500s).
- Task results are kept 3h after completion (`qwen_check_task`). If you fire
  more than one `delegate_coding_task` call, come back for all of them before
  moving to unrelated work - an unpolled result is silently lost after 3h.
- **Any `npx`-based extension must use `npx.cmd`, not bare `npx`, in the
  `--with-extension` command.** Root-caused 2026-08-23 via captured stderr
  ("Failed to start extension 'npx' (IO error: program not found)"): Goose's
  Rust process spawner can't execute `npx` directly on Windows because it's a
  `.cmd` shim, not a real `.exe`. `npx.cmd -y @playwright/mcp@latest`
  confirmed working live - real Playwright browser tools registered. Note:
  Playwright MCP blocks `file://` URLs by default (real sites work fine) - for
  local file verification, headless Chrome via Python `subprocess`
  (`chrome.exe --headless --dump-dom <url>`) is simpler and also confirmed
  working, no attachment step to fail.
- Deep research: `extensions: ['uvx free-search-mcp']` + its `research()` tool
  - confirmed working live 2026-08-23 (registers as extension `uvx`, tools
  `search`/`research`/`fetch`/`fetch_batch`/`read_doc`; `uvx` is a real `.exe`,
  unaffected by the npx bug above). No API key needed.
- `gh` CLI is installed and already authenticated (repo/workflow/gist scopes)
  - Qwen can do real GitHub work directly via its `shell` tool, no extension
  needed. State exactly what GitHub actions are in scope per task.
- Up to **8** `delegate_coding_task` calls now run genuinely concurrently
  (raised 2 -> 4 -> 8 on 2026-08-24, matching `launchers/start_huge.sh`'s
  `MAX_SEQS=8`). Cross-checked against upstream's own README first: `MAX_SEQS`
  is a deliberate low default for single-user sessions, not an engine limit -
  a slot costs ~8 MiB and upstream measured the KV pool holding at 268,169
  tokens up to `MAX_SEQS=8` (their own tested ceiling; peak 5 concurrent
  observed on an 8-stream test). Verified on this box at every step, not just
  trusted from docs: rebooted at `MAX_SEQS=4` then `MAX_SEQS=8`, pool held at
  exactly 268,169 tokens both times, no new errors. 8 matches upstream's own
  fully-tested ceiling - going past it would be extrapolating past their
  measurement, not verified, so this is the practical top absent new evidence.
  The only observed cost of the raise: CUDA graph capture grew from 32 to 64
  sizes, adding ~15s of one-time boot time (not a per-request cost). A 9th+
  call queues until a slot frees. Keep `MAX_CONCURRENT_GOOSE` in
  `mcp-qwen/index.js` matched to whatever `MAX_SEQS` the server actually
  runs - going over either ceiling reproduces the original "3 of 4 concurrent
  calls timed out" failure this design fixed.
- Goose's own subagent dispatch (`delegate`/`summon` -> `qwen-worker`) is
  real capacity but not reliable yet - live-tested 2026-08-23: failed on a
  wrong default model (`"haiku"`, not inheriting `GOOSE_MODEL`), and the
  retry never completed within budget. Do not route work through it until
  this is revisited and a clean run is confirmed.
- Claude Code's `MCP_TOOL_TIMEOUT` is documented as configurable but multiple
  open upstream issues report it isn't honored in practice - do not rely on it.
  This is why `delegate_coding_task` uses an async taskId/poll pattern instead
  of just waiting longer.
- A localhost-only HTTP status mirror (`STATUS_PORT = 18021`, GET
  `/task/<taskId>` -> `{found, done, booting, executing, isError}`) exists
  specifically so a caller can wait on a background shell loop
  (`run_in_background:true`) instead of polling `qwen_check_task` manually -
  MCP's own current async-task spec (SEP-1686, Final) has no completion-push
  primitive, only a poll-based one, so this is a harness-level workaround, not
  a protocol gap fixable here. Read-only, no auth - never bind it to
  `0.0.0.0`.
- **This server is not a singleton** - Desktop/Code/Cowork each spawn their
  own process running it, each with independent in-memory state. Only the
  first process to start can bind `STATUS_PORT`; a real incident confirmed an
  unhandled bind-conflict crashes the whole process (not just the listener),
  taking every session's MCP connection down at once. `statusServer()` now
  handles this (`http.on("error", ...)`), but any future feature adding
  shared local state (a port, a fixed file) needs the same check.
- Goose's own process-level stderr (crashes, extension load failures) was
  never captured before 2026-08-23 - `entry.stderr` now threads it into every
  status message. If an extension silently fails again, the actual error
  should now be visible instead of just "0 tool calls."

## Serving recipe (~/qwen-serving, tracks upstream syv-ai/qwen38-27b-rtx3090)

Kept in sync via `git pull` in the WSL checkout - check
`git log --oneline HEAD..origin/main` occasionally. Every knob's tradeoff is
measured and written down in `single-user/start_qwen.sh` and `docs/gotchas.md`
- read those before assuming something is a vLLM bug.

Current correctness-relevant settings (see `mcp-qwen/NOTES.md` for the
measurements behind them): `VLLM_DFLASH2_LOOKUP_ADAPTIVE=0` permanently in
`launchers/start_huge.sh`; `SPEC=dflash2 CTX=huge` runs
`cudagraph_mode=FULL_AND_PIECEWISE`; `SPEC=mtp CTX=huge` must stay on
`PIECEWISE` (confirmed correctness bug under FULL that dflash2 doesn't share).

`mcp-qwen/index.js` runs every response through `detectCorruption()` (flags a
repeated non-benign character or a repeating block) before it reaches a
caller - root cause of the underlying rare corruption is unconfirmed, treat
the detector as a safety net on known signatures, not a guarantee.

Boot-log warnings cross-checked against upstream docs 2026-08-24 (full
findings: `mcp-qwen/NOTES.md`): the `min_frames`/`max_frames` `[ERROR]` lines
and the four `Unknown vLLM environment variable` warnings are cosmetic. The
"padding layers... may waste at most 60%" and "Mamba prefix caching...
experimental" warnings are unaddressed in upstream's own docs but already
implicitly validated (our realized 268,169-token pool matches upstream's own
benchmarked number exactly; upstream's own extensive PREFIX_CACHE=1 testing
already stress-tests the "experimental" path) - no action needed on either.
`flashinfer is unavailable; the DFlash2 selector uses torch.topk, at roughly
half the speed` traces to a missing CUDA toolkit (`CUDA_HOME` unset, no
`nvcc` in the WSL venv) - **investigated in full 2026-08-24, concluded not
worth fixing**, not merely deferred. Two independent things both point away
from installing it:
1. FlashInfer's actual role in this recipe is the fp8-KV attention backend
   for `CTX=long` only (README: "vLLM 0.27.1's FlashInfer backend (needed
   for fp8 KV, i.e. for 150k context)..."). `CTX=huge` (our default) uses
   KVarN, a Triton-kernel KV cache with no FlashInfer dependency at all.
2. The boot warning's own "DFlash2 selector" framing is misleading - vLLM's
   optional FlashInfer *sampler* path (the thing CUDA_HOME would actually
   unblock) is hardcoded off repo-wide via `VLLM_USE_FLASHINFER_SAMPLER=0`
   in `single-user/start_qwen.sh` (comment there: it "does not build with
   older system nvcc"), and DFlash2's own candidate selector is a drafter
   submodule (`candidate_selector`, `drafter/quant_dflash2.py`), not a
   FlashInfer consumer. The warning is a stock vLLM message for a code path
   this recipe's own patches already bypass.
Net: installing the toolkit would fix nothing measurable for `CTX=huge`
(confirmed, not assumed) and would only matter if switching to `CTX=long` -
which the README's own docs/long-context.md calls "worth it only for
context reproduction," and which loses on both context size (114-139k vs
245k) and single-stream speed (96-102 tok/s vs `CTX=huge`'s 130-133 tok/s)
for anything else. Not installing.
