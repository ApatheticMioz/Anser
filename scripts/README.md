# scripts/

Repo-level tooling that lives **outside** the self-contained `mcp-qwen` npm
package. These are not part of `mcp-qwen`'s build or test chain; they operate
on the Qwen harness's on-disk telemetry (task files + session event logs).

## qwen_tasks_analysis.mjs

Telemetry exporter for Qwen task dispatches. Rebuilds (with **corrected
semantics**) the one-off script that produced
`docs/audits/telemetry/qwen_tasks_analysis_2026-09-13.json` — only that
script's *output* was ever committed; the script itself was lost. This is the
repo-tool reconstruction (M8, audit findings F17/F18).

Node >= 22, ESM, **no dependencies**.

### Inputs

| Flag             | Meaning                                                                 |
|------------------|-------------------------------------------------------------------------|
| `--tasks-dir`    | Directory of per-dispatch task files: `task_<id>.json` (`id`, `sessionId`, `cwd`, `prompt`, `createdAt`, `startedAt`, `finishedAt`, `status`, `done`, `isError`, `reasoningEffort`, `toolCallsCount`, `fileOps`, …) |
| `--sessions-dir` | Directory of per-session event logs: `<sessionId>/events.jsonl` (per-turn `assistant_message` events with `metrics{promptTokens, ttftMs, totalMs, reasoningTokens, completionTokens, tokensPerSec}`, plus `tool_call` / `continuation_injected` / `empty_stream_retry` / `engine_empty_response` / `session_end` events) |
| `--out`          | Output JSON file (array of per-dispatch rows)                            |

### Usage

```sh
node scripts/qwen_tasks_analysis.mjs \
  --tasks-dir    C:/Users/Apath/.qwen/tasks \
  --sessions-dir C:/Users/Apath/.qwen/sessions \
  --out          docs/audits/telemetry/qwen_tasks_analysis_<date>.json
```

A readable summary (dispatch/session counts, reused sessions, null-`promptTokens`
count, output path) is written to **stderr**; the JSON array goes to `--out`.

### Output schema

Field-compatible with the committed 2026-09-13 analysis — **25 fields, fixed
order**:

```
taskId, sessionId, cwd, createdAt, durationSec, status, isError,
endStatus, promptLen, prompt, toolCallsCount, tools, totalBash,
bashCommandsSummary, filesWritten, filesReadCount, turns, promptTokens,
completionTokens, thinkingTokens, ttftMedMs, rateAvgTokS, continuations,
emptyStreamRetries, engineEmptyResponses
```

### Corrected semantics (the audit's defects)

1. **`promptTokens` = MAX per-turn `metrics.promptTokens`** across the
   session's events — the *final context depth*. It is **never 0**: when the
   engine never reported a non-zero `promptTokens` (or there are no events at
   all) the value is **`null`**, distinguishing *unknown* from *zero*.
   (The original summed every turn's `promptTokens`, inflating a ~200K-token
   context into a ~27M "total".)

2. **Session-cumulative fields are stamped ONLY on the LAST dispatch row** of
   each session (the most recent `createdAt`); every other row of that session
   carries **`null`**. The cumulative fields are: `turns`, `completionTokens`,
   `thinkingTokens`, `tools`, `totalBash`, `ttftMedMs`, `continuations`,
   `emptyStreamRetries`, `engineEmptyResponses`. This stops downstream sums
   from double-counting a reused session (the ~3× inflation in the original,
   where the same session total was repeated on every row).

   Session-level *descriptive* fields that are **not** cumulative sums —
   `endStatus`, `bashCommandsSummary`, `filesWritten`, `filesReadCount`,
   `promptTokens`, `rateAvgTokS` — are present on **every** row of the session
   (they describe session state/depth, so they do not double-count).

3. **`rateAvgTokS` uses an honest derivation.** The mean per-turn tokens/sec
   uses the engine's `metrics.tokensPerSec` when it is present and > 0; when
   the engine field is absent or 0, the rate is **derived** as
   `completionTokens / ((totalMs - ttftMs) / 1000)` — i.e. generation time
   only, excluding time-to-first-token. The output schema has no dedicated
   "derived" flag, so this derivation is documented here (and in the
   exporter's header) rather than encoded in a field.

### Test

The exporter is a repo-level tool, so its test is a **standalone** repo-level
test (not part of `mcp-qwen`'s `npm test` chain, which imports only from
`mcp-qwen/src/` and never reaches the repo root):

```sh
node tests/qwen_tasks_exporter.test.js
```

It builds a tiny fixture in a temp dir (2 dispatches sharing one session + a
tiny synthetic `events.jsonl`, plus one no-events session), runs the exporter
as a child process, and asserts all three corrected semantics plus
field-compatibility. No vLLM, no network, no dependencies.
