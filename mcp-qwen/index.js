#!/usr/bin/env node
// MCP server exposing local Qwen3.8-27B (vLLM+DFlash2, fast/huge configs) as tools.
// Registered identically in Claude Code and Google Antigravity (both speak MCP).
//
// Design notes:
// - `ask_qwen` (huge, 245K context) is the DEFAULT tool - 77 tok/s is fast enough for
//   nearly everything, so tool naming/wording is deliberately biased to steer callers
//   there. `ask_qwen_fast` (57K context, 107-130 tok/s) exists as an escape hatch for
//   confirmed latency-critical loops, not a coin-flip alternative.
// - "fast" and "huge" are mutually exclusive on the same GPU/port (18020). Each tool
//   call checks which config is currently live (via max_model_len on /v1/models) and,
//   if it doesn't match what was requested, stops the running server and boots the
//   right one before sending the actual request. This is the "auto-wake" behavior.
// - A cold switch costs ~45-90s (torch.compile is cached after the first boot of each
//   config, so this is model-load time, not full compile time).
// - Requests always go to the OpenAI-compatible /v1/chat/completions endpoint with
//   thinking left in the model's default state (caller can pass enable_thinking).
//
// - `delegate_coding_task` spawns the Goose CLI (block/goose, Rust binary at
//   C:\Users\Apath\.local\bin\goose.exe) as a subprocess with --output-format json.
//   Earlier this ran `pi`'s agent loop in-process via its programmatic library,
//   which avoided subprocess entirely - but pi is deliberately minimal (its own
//   docs: "does not include built-in MCP, sub-agents, ..."), so it can't attach
//   real MCP servers. Goose is MCP-native (attach any stdio MCP server per call via
//   --with-extension) but has no Node-embeddable library, so this went back to
//   subprocess spawning - done carefully this time based on what broke with pi:
//   stdio is explicitly set (`ignore` on stdin) so nothing can block waiting on an
//   open, unwritten pipe, and goose.exe is a real PE executable (not an npm .cmd
//   shim), so the EINVAL-on-batch-file issue that affected pi.cmd doesn't apply
//   here. Verified directly (~5-90s round trips depending on task complexity, real
//   file/bash/MCP tool execution, correct output, a live official filesystem MCP
//   server successfully attached and used) before wiring it in here.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import { createServer } from "http";

const execFileAsync = promisify(execFile);

const PORT = 18020;
const BASE_URL = `http://localhost:${PORT}/v1`;
// Plain-HTTP, localhost-only status endpoint - separate from the MCP stdio
// transport entirely. Exists so a caller can wait for a task WITHOUT spending an
// LLM turn per check: MCP itself only offers a poll-based "Tasks" primitive as of
// SEP-1686 (Final status) - no completion push exists in the protocol yet, by the
// spec authors' own explicit design (their "Motivation" section scopes polling for
// exactly this minutes-scale, push for hours-scale). The fix available today isn't
// a protocol change, it's using the harness's own background-process mechanism: a
// caller can run a shell loop against this endpoint with `run_in_background`, which
// sleeps real wall-clock time outside any LLM turn and only surfaces a notification
// once, on completion - collapsing what would be N poll-turns (each a permanent,
// compounding addition to conversation context) into one wait + one result fetch.
// GET-only, read-only, 127.0.0.1-bound - a status mirror of `pendingTasks`, not a
// new way to start or cancel work.
const STATUS_PORT = 18021;
const MAX_LEN_FAST = 57344;
const MAX_LEN_HUGE = 245760;
const BOOT_TIMEOUT_MS = 180_000;
const BOOT_POLL_MS = 3000;

function wsl(cmd) {
  // Route through `bash -c` explicitly - a bare `wsl -- bash <path>` mis-resolves
  // `~` under some invocation contexts (confirmed during this project's own setup).
  return execFileAsync("wsl.exe", ["-d", "Ubuntu", "--", "bash", "-c", cmd], {
    timeout: BOOT_TIMEOUT_MS + 10_000,
  });
}

async function getApiKey() {
  const { stdout } = await wsl("cat ~/qwen-serving/api_key.txt");
  return stdout.trim();
}

async function currentMode() {
  try {
    const key = await getApiKey();
    const res = await fetch(`${BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const j = await res.json();
    const len = j?.data?.[0]?.max_model_len;
    if (len === MAX_LEN_FAST) return "fast";
    if (len === MAX_LEN_HUGE) return "huge";
    return "unknown";
  } catch {
    return null; // not running
  }
}

async function ensureMode(mode) {
  const current = await currentMode();
  if (current === mode) return { switched: false };
  const script = mode === "fast" ? "start_fast.sh" : "start_huge.sh";
  await wsl(
    `cd ~/qwen-serving && nohup bash launchers/${script} > /tmp/mcp_launch_${mode}.log 2>&1 < /dev/null & disown; sleep 1; true`
  );
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, BOOT_POLL_MS));
    const now = await currentMode();
    if (now === mode) return { switched: true };
  }
  throw new Error(`Timed out waiting for ${mode} to boot (${BOOT_TIMEOUT_MS}ms)`);
}

// --- Corruption detection & auto-retry ---
// A single real-use incident replaced expected punctuation with a burst of
// literal "!" characters. Deep investigation (see D:\LLM_Ecosystem\CLAUDE.md,
// "Serving recipe" section) ruled out every specific, testable cause this stack
// has (LOOKUP_ADAPTIVE prefix-cache bug, Bug B, vLLM #43713's parser class) and
// never reproduced it directly - the strongest remaining lead is an academic
// paper describing exactly this KV-quantization shape (4-bit K / 2-bit V) as a
// plausible speculative-decoding failure mode. That is a tail-risk in third-
// party inference code, not something fixable by editing this MCP server. What
// IS fixable here: never let a corrupted response reach the caller silently.
// The signatures below mirror this serving stack's own corruption detector
// (bench/bugb_sweep.py / residue_sweep.py: a repeated-character run, or a
// substantial chunk repeating verbatim) rather than being specific to "!".
// Separator/decoration characters that legitimately repeat at any length in
// normal output (markdown dividers, code comment banners, "Loading...", table
// rules) - excluded entirely from the repeated-character check below, rather
// than threshold-tuned, since real dividers routinely run 40-80+ characters.
// A degenerate output built from these chars is still caught by the repeated-
// block check (signature 2), which doesn't care what the block contains.
// Everything else (crucially "!", the character actually observed in the real
// incident) almost never legitimately repeats 5+ times in a row in prose or code.
const BENIGN_REPEAT_CHARS = new Set([..."-=_*~#`^+."]);

function detectCorruption(text) {
  if (!text || text.length < 20) return null;
  const runMatch = text.match(/([^\w\s])\1{4,}/);
  if (runMatch && !BENIGN_REPEAT_CHARS.has(runMatch[1])) {
    return `${runMatch[0].length}x repeated '${runMatch[1]}' character`;
  }
  for (let i = 0; i + 40 <= text.length; i += 40) {
    const chunk = text.slice(i, i + 40);
    // A chunk that's just a divider (all benign chars/whitespace) repeating
    // is a banner, not degenerate output - e.g. a long "====" section rule.
    if ([...chunk].every((c) => BENIGN_REPEAT_CHARS.has(c) || /\s/.test(c))) continue;
    let count = 0;
    let idx = -1;
    while ((idx = text.indexOf(chunk, idx + 1)) !== -1) count++;
    if (count >= 3) return `40-char block repeated ${count}x verbatim`;
  }
  return null;
}

// Qwen3.8's own recommended sampling (huggingface.co/Qwen/Qwen3.8-27B):
//   thinking:     temperature=1.0, top_p=0.95, top_k=20
//   non-thinking: temperature=0.7, top_p=0.80, top_k=20
// The server's own default (--default-chat-template-kwargs reasoning_effort=medium,
// set in launchers/start_fast.sh and start_huge.sh) already applies when we don't
// override reasoning_effort here - validated: xhigh (the template's own default) burned
// an entire 1500-token budget on reasoning alone for a moderate coding task and got cut
// off mid-answer; medium finished naturally (finish_reason=stop) with room to spare.
async function ask(mode, prompt, system, maxTokens, reasoningEffort) {
  const { switched } = await ensureMode(mode);
  const key = await getApiKey();
  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: prompt });
  const thinkingOff = reasoningEffort === "off";
  const body = {
    model: "qwen3.8-27b",
    messages,
    max_tokens: maxTokens ?? 4096,
    ...(thinkingOff
      ? { temperature: 0.7, top_p: 0.8, top_k: 20, chat_template_kwargs: { enable_thinking: false } }
      : { temperature: 1.0, top_p: 0.95, top_k: 20 }),
  };
  // Only override the server's medium default when the caller asked for something else.
  if (!thinkingOff && reasoningEffort) {
    body.chat_template_kwargs = { reasoning_effort: reasoningEffort };
  }
  async function once() {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new Error(`vLLM request failed: HTTP ${res.status} ${errBody.slice(0, 500)}`);
    }
    const j = await res.json();
    return { text: j.choices?.[0]?.message?.content ?? "", usage: j.usage ?? {} };
  }

  let { text, usage } = await once();
  const firstProblem = detectCorruption(text);
  let retryProblem = null;
  if (firstProblem) {
    // Free to retry blind here: this is a pure text response, nothing was
    // written to disk, so discarding it and asking again has no side effects.
    ({ text, usage } = await once());
    retryProblem = detectCorruption(text);
  }

  const note = switched
    ? `[switched to ${mode} mode, cold-start cost included in latency]\n\n`
    : "";
  const warn = retryProblem
    ? `[WARNING: response looks corrupted even after one retry (${retryProblem}) - this is a rare, unconfirmed tail-risk of this serving stack (see D:\\LLM_Ecosystem\\CLAUDE.md). Treat this output with suspicion; do not act on it without checking.]\n\n`
    : firstProblem
    ? `[note: first response looked corrupted (${firstProblem}) and was discarded; this is a clean retry.]\n\n`
    : "";
  return `${note}${warn}${text}\n\n---\n(${usage.completion_tokens ?? "?"} completion tokens, ${usage.prompt_tokens ?? "?"} prompt tokens)`;
}

// --- delegate_coding_task: spawns the Goose CLI as a subprocess ---
//
// Three real failures surfaced by actual use (not caught by my own scripted tests):
//
// 1. Parallel dispatch overloaded the GPU. The server runs --max-num-seqs 2 on a
//    single card; nothing stopped multiple delegate_coding_task calls from hitting
//    it concurrently, and 3 of 4 concurrent calls timed out. Fixed by serializing
//    every call through `delegateQueue` below - concurrent MCP calls now queue
//    automatically instead of contending for the GPU.
// 2. A successful edit got reported as a bare timeout because --output-format json
//    only prints ONE json blob at the very end - if a slow verification step (e.g.
//    tsc on a real codebase) ate the whole timeout budget, killing the process lost
//    the entire record of what had already landed. Fixed by switching to
//    --output-format stream-json (real NDJSON, one event per line, via `spawn` so
//    lines are readable as they arrive) and using the SAME event-extraction logic
//    for both the normal-completion path and the killed-on-timeout path - a timeout
//    now reports "here's what was confirmed before the cutoff" instead of nothing.
// 3. Claude Desktop has a hardcoded, non-configurable ~60s client-side timeout on
//    MCP tool calls (confirmed empirically: a deliberately-slow task showed
//    "Request timed out" in the app at ~60s while goose.exe kept running server-
//    side and successfully finished the edit ~40s later - the response just had
//    nowhere to go). Since a real delegate_coding_task call routinely takes
//    30-150s, MOST non-trivial calls would hit this wall. Fixed with an async
//    check-status pattern (the same shape the MCP spec itself is standardizing on
//    for long-running tools - see SEP-1391/SEP-1539): the task is registered in
//    `pendingTasks` and started immediately, but the tool call only waits up to
//    RACE_MS (well under the 60s wall) before returning either the real result
//    (fast tasks) or a taskId to poll via qwen_check_task (slow tasks) - the work
//    itself is never blocked on or torn down by the client giving up.

const GOOSE_EXE = "C:\\Users\\Apath\\.local\\bin\\goose.exe";
// 400s was set before any real production data existed - a generous-feeling multiple
// of the 60-150s typical case, not a measured figure. Real telemetry since: plain
// verify:false tasks land in 40-60s (400s is a 7-10x margin, untouched below). Tasks
// with verify:true have instead shown a qualitative pattern - broad, unstructured
// exploration with zero files written well past the 200-270s mark, not "nearly done
// but out of time" - so raising this specific ceiling for verify:true was tried in
// reasoning and rejected: nothing in the evidence suggests more time converts those
// runs to successes, only that it would hold the GPU/queue longer before the same
// zero-output result. The one real, mechanical case that DOES need more than 400s
// is documented but was never wired up: a first-time npx-based extension (e.g.
// @playwright/mcp) download alone costs ~500s, which the flat 400s ceiling cannot
// possibly cover - any extension-attached call was guaranteed to be killed before
// or during install. EXTENSION_TIMEOUT_BONUS_MS fixes that specific, understood gap.
const DELEGATE_TIMEOUT_MS = 400_000;
const EXTENSION_TIMEOUT_BONUS_MS = 500_000; // added on top of DELEGATE_TIMEOUT_MS only when `extensions` is non-empty
const RACE_MS = 50_000; // stay safely under Claude Desktop's hardcoded ~60s client-side MCP timeout
// 30 min was too short in real use: a session that fired several delegate_coding_task
// calls in a tight batch, then went off to do ~90 minutes of unrelated work (manual
// browser QA) before checking back, found 2 of them already cleaned up - their results
// (success or failure, files written or not) were unrecoverable. Raised to 3h, which
// comfortably covers "got distracted for a while," while still bounding memory growth
// for a long-running server (an abandoned entry is a few KB of stream-json lines at most).
const TASK_RETENTION_MS = 3 * 60 * 60 * 1000; // how long a finished task's result stays checkable after completion

const pendingTasks = new Map(); // taskId -> { startedAt, lines, done, result }

function makeTaskId() {
  return `qwen-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Surfaced in status messages so a caller who fires several delegate_coding_task
// calls in a row can see the full backlog, not just the one taskId they're asking
// about - real use showed calls fired in a tight batch, then never followed up on
// before the results aged out (see TASK_RETENTION_MS comment). Naming the count
// explicitly is a cheap nudge against repeating that.
function unfinishedTaskCount() {
  let n = 0;
  for (const e of pendingTasks.values()) if (!e.done) n++;
  return n;
}

// Bounds concurrent Goose runs to this server's real engine capacity, not to 1.
// Originally fully serial (failure #1: "3 of 4 concurrent calls timed out" when
// nothing bounded concurrency at all) - but that failure was 4 requests against a
// 2-slot engine, not evidence that ANY concurrency is unsafe. Raised 2 -> 4 -> 8 on
// 2026-08-24 after cross-checking upstream's own README (syv-ai/qwen38-27b-rtx3090):
// MAX_SEQS is a deliberate LOW DEFAULT for single-user/long-document sessions, not
// an engine limit - a recurrent-state slot costs ~8 MiB, and upstream measured the
// KV pool staying at 268,169 tokens whether MAX_SEQS is 2 or 8 (peak 5 concurrent
// observed on an 8-stream test at MAX_SEQS=8). Verified directly on this box at
// every step, not just trusted from docs: launchers/start_huge.sh now exports
// MAX_SEQS=8, and a real reboot confirmed the KV pool held at exactly 268,169
// tokens, unchanged from the MAX_SEQS=2 and MAX_SEQS=4 boots, no new errors (the
// only observable cost was CUDA graph capture growing from 32 to 64 sizes, adding
// ~15s of one-time boot time - not a per-request cost). 8 matches upstream's own
// fully-tested ceiling; going further than upstream's own measurement would no
// longer be "verified," just extrapolated, so this is treated as the practical top
// until new evidence justifies otherwise. Raising this above whatever --max-num-seqs
// the server is actually running would reproduce the original "3 of 4 timed out"
// failure - keep the two numbers matched.
const MAX_CONCURRENT_GOOSE = 8;
let activeGooseCount = 0;
const gooseWaitQueue = []; // functions to call when a slot frees up
let queueDepth = 0; // tasks enqueued but not yet started executing - see queuePositionAtEnqueue below

function runQueued(fn) {
  return new Promise((resolve, reject) => {
    const attempt = () => {
      activeGooseCount++;
      fn().then(
        (r) => {
          activeGooseCount--;
          releaseNext();
          resolve(r);
        },
        (e) => {
          activeGooseCount--;
          releaseNext();
          reject(e);
        }
      );
    };
    if (activeGooseCount < MAX_CONCURRENT_GOOSE) attempt();
    else gooseWaitQueue.push(attempt);
  });
}
function releaseNext() {
  if (activeGooseCount < MAX_CONCURRENT_GOOSE) {
    const next = gooseWaitQueue.shift();
    if (next) next();
  }
}

// Two concurrent Goose runs both needing a MODE SWITCH at the same moment (rare -
// `huge` is the default and stays booted) would race on the same `pkill` + relaunch
// sequence in ensureMode() and could corrupt each other's boot. Serialized separately
// from the concurrency above: cheap (a single fast HTTP check) when no switch is
// needed, which is the common case, so this costs nothing in practice.
let bootMutex = Promise.resolve();
function withBootMutex(fn) {
  const result = bootMutex.then(fn, fn);
  bootMutex = result.then(
    () => {},
    () => {}
  );
  return result;
}

function extractToolEvents(lines) {
  // Works identically whether `lines` is a complete run or one cut short by a
  // timeout - each stream-json line carries one `message` object, and tool
  // call/response content items are self-contained (not split across lines the
  // way "thinking"/"text" deltas are), so this needs no notion of "did the run
  // finish."
  const contentItems = [];
  for (const line of lines) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // tolerate stray non-JSON lines (banner, etc.)
    }
    const content = obj?.message?.content;
    if (Array.isArray(content)) contentItems.push(...content);
  }
  const toolCalls = contentItems.filter((c) => c.type === "toolRequest");
  const toolResponses = contentItems.filter((c) => c.type === "toolResponse");
  const errors = toolResponses.filter((r) => r.toolResult?.value?.isError);
  const fileOps = toolCalls
    .filter((c) => ["write", "edit", "str_replace"].includes(c.toolCall?.value?.name))
    .map((c) => `${c.toolCall.value.name}:${c.toolCall.value.arguments?.path ?? "?"}`);
  // Text deltas stream token-by-token as separate lines with the same message id -
  // concatenate every "text" chunk in arrival order to reconstruct the final answer.
  const finalText = contentItems
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("")
    .trim();
  return { toolCalls, errors, fileOps, finalText };
}

function summarizeGooseRun(lines, { timedOut, timeoutMs = DELEGATE_TIMEOUT_MS, stderr = "" } = {}) {
  const { toolCalls, errors, fileOps, finalText } = extractToolEvents(lines);

  const parts = [];
  parts.push(
    (timedOut
      ? `Qwen did NOT finish within the ${timeoutMs / 1000}s time budget - reporting what was confirmed before the cutoff. `
      : `Qwen finished. `) +
      `${toolCalls.length} tool call(s) (${fileOps.length} file write/edit), ${errors.length} tool error(s).`
  );
  if (fileOps.length) {
    parts.push(
      `Files touched: ${fileOps.join(", ")}` +
        (timedOut ? " - these writes DID happen even though the run timed out; verify against disk, don't assume failure." : "")
    );
  }
  if (finalText) parts.push(`${timedOut ? "Last partial message" : "Final message"} from Qwen:\n${finalText}`);
  // Unlike ask()'s plain-text path, a blind retry here is NOT safe - Goose may
  // already have written files or run commands, and re-running the whole task
  // could double-apply them. Surface a loud warning instead so the caller (or a
  // human) re-checks any touched files before trusting this run's reasoning.
  const corruption = finalText ? detectCorruption(finalText) : null;
  if (corruption) {
    parts.push(
      `WARNING: Qwen's final message shows signs of corrupted output (${corruption}) - ` +
        `a rare, unconfirmed tail-risk of this serving stack, not specific to this task ` +
        `(see D:\\LLM_Ecosystem\\CLAUDE.md). Re-read any files it touched before trusting ` +
        `them; the reasoning that produced this run may not be sound.`
    );
  }
  if (errors.length) {
    const errText = errors
      .map((e) => (e.toolResult.value.content ?? []).map((c) => c.text ?? "").join("\n"))
      .join("\n---\n");
    parts.push(`ERRORS (Qwen's own tool calls failed - review before trusting the result):\n${errText}`);
  }
  // Goose's own process-level errors (crash, extension load failure - Goose's own
  // format is literally "process quit before initialization: stderr = ...") land
  // here, not in the stream-json event log above. Was never captured before
  // 2026-08-23 - a real extension-load failure produced zero diagnostic
  // information for exactly that reason.
  if (stderr.trim()) {
    parts.push(`Goose process stderr (last 8000 chars):\n${stderr.trim()}`);
  }
  // A timeout with file writes already confirmed is NOT the same failure as a
  // timeout with nothing landed - only flag isError when something is actually
  // known to be wrong (a real tool error, or a timeout that produced no edits at all).
  const isError = errors.length > 0 || (timedOut && fileOps.length === 0);
  return { isError, text: parts.join("\n\n") };
}

// Starts a Goose run immediately and registers it in `pendingTasks`, independent
// of whether anyone is still around to await the returned promise - this is what
// lets qwen_check_task find it later even after the original tool call's client-
// side timeout gave up. Queued through `runQueued` (failure #1) so it doesn't
// start executing until the GPU is actually free.
function startGooseTask({ cwd, task, mode, extensions }) {
  const taskId = makeTaskId();
  // `startedAt` is enqueue time, not execution time - with the single-GPU queue
  // (runQueued), a task can sit behind others for minutes before Goose actually
  // spawns. A real session hit exactly this: qwen_check_task reported "832s
  // elapsed" on a task that had barely run, because most of that was queue wait,
  // and it read as "stuck" to the caller with no way to tell the difference.
  // `execStartedAt` (set once the spawn callback actually runs) and
  // `queuePositionAtEnqueue` let the status text distinguish "queued" from
  // "running" instead of reporting one undifferentiated elapsed time.
  // Everything in this function runs synchronously up to the first `await`
  // inside runQueued's callback - so taskId/entry are registered in
  // `pendingTasks` before any async work (including model boot) starts. This
  // matters: `ensureMode`/`getApiKey` used to be awaited by the caller BEFORE
  // this function was even called, meaning a cold model boot (up to 180s,
  // BOOT_TIMEOUT_MS) had no taskId to poll and could silently outrun the
  // client's own timeout with no recovery path - confirmed directly: a cold
  // first call reported a bare client timeout with nothing to check, and the
  // edit only showed up on disk minutes later once a second call incidentally
  // revealed it. Moving the boot inside here, after the taskId already exists,
  // closes that gap the same way RACE_MS closes it for the Goose run itself.
  queueDepth++;
  // A flat timeout can't cover both cases at once: a first-time npx extension
  // download alone costs ~500s (see DELEGATE_TIMEOUT_MS comment above), which the
  // base 400s ceiling cannot fit - so any extensions-attached call gets a bonus
  // window on top of it, computed once here and reused everywhere this task's
  // deadline is referenced (kill timer, status messages).
  const timeoutMs = extensions && extensions.length ? DELEGATE_TIMEOUT_MS + EXTENSION_TIMEOUT_BONUS_MS : DELEGATE_TIMEOUT_MS;
  const entry = {
    startedAt: Date.now(),
    execStartedAt: null,
    booting: true,
    queuePositionAtEnqueue: queueDepth - 1,
    lines: [],
    stderr: "", // was never captured before 2026-08-23 - stdio piped stderr but nothing
    // read it, so every Goose-level error (crash, extension load failure - Goose's own
    // error format is literally "process quit before initialization: stderr = ...")
    // was silently discarded. A real Playwright-extension test came back with no
    // diagnostic information because of exactly this gap.
    done: false,
    result: null,
    child: null,
    cancelled: false,
    timeoutMs,
  };
  pendingTasks.set(taskId, entry);

  // cwd alone is not enough: Goose's developer extension resolves its working
  // directory from the process-wide GOOSE_WORKING_DIR env var, not from
  // std::env::current_dir() (block/goose#6610) - without this, file tools can
  // silently operate against a stale/compiled-in directory while the model's
  // turn-context still claims `cwd`, which is exactly what produced a
  // fabricated path in a real run. Restating cwd in the prompt itself is
  // defense in depth against that same failure mode recurring model-side.
  // The shell note below addresses a second, independently-reproduced failure
  // in the same real session: Goose has no shell-selection config on Windows
  // (block/goose#7837, open) and its own built-in system prompt tells the model
  // to prefer PowerShell-only cmdlets (Get-Content, Select-String) regardless of
  // what shell is actually spawned - this exact mismatch caused a real tool
  // error ('Get-Content' is not recognized...) on this box, on a retry that had
  // already gotten the cwd fix. Countering Goose's own baked-in guidance costs
  // nothing if the mismatch turns out not to apply on a given box.
  // Self-verification (Qwen running its own build/typecheck/test pass) was a
  // caller-facing option (`verify: true`) and, before that, the default.
  // Real-world track record across every real session so far: ~1 successful
  // completion in 16 attempts, every other one burning the full time budget
  // on exploration/tooling before reaching (or without ever reaching) the
  // edit - while the caller re-verified against disk afterward regardless,
  // per standing policy. Zero confirmed cases where it caught something the
  // caller's own check wouldn't have. Removed as an option entirely rather
  // than left as a documented-bad choice: the caller kept reaching for it
  // anyway despite explicit warnings in the tool description, so a written
  // warning wasn't sufficient - only removing the option is.
  const finalTask =
    `Your working directory is exactly: ${cwd}\n\n` +
    `If a shell command fails with "'Get-Content'/'Select-String' is not recognized", ` +
    `you're in cmd.exe, not PowerShell - use \`type\` and \`findstr\` instead.\n\n` +
    `${task}\n\n(Do not run any build, typecheck, lint, or test commands to verify this change - just make the edit and stop. The caller will verify separately.)`;

  const args = ["run", "--no-session", "--output-format", "stream-json", "-t", finalTask];
  for (const ext of extensions ?? []) {
    args.push("--with-extension", ext);
  }

  const promise = runQueued(
    async () => {
      queueDepth--;
      // A caller may have already cancelled this task while it sat in queue -
      // don't boot/spawn anything for work nobody is waiting on anymore.
      if (entry.cancelled) {
        const result = { isError: true, text: "delegate_coding_task: cancelled before it started executing (was still queued)." };
        entry.done = true;
        entry.result = result;
        setTimeout(() => pendingTasks.delete(taskId), TASK_RETENTION_MS);
        return result;
      }

      let key;
      try {
        key = await withBootMutex(async () => {
          await ensureMode(mode ?? "huge");
          return await getApiKey();
        });
      } catch (err) {
        const result = { isError: true, text: `delegate_coding_task: failed to boot/reach the model server - ${err.message}` };
        entry.done = true;
        entry.result = result;
        setTimeout(() => pendingTasks.delete(taskId), TASK_RETENTION_MS);
        return result;
      }
      entry.booting = false;
      if (entry.cancelled) {
        const result = { isError: true, text: "delegate_coding_task: cancelled during model boot, before Goose started." };
        entry.done = true;
        entry.result = result;
        setTimeout(() => pendingTasks.delete(taskId), TASK_RETENTION_MS);
        return result;
      }

      return new Promise((resolve) => {
        entry.execStartedAt = Date.now();
        const child = spawn(GOOSE_EXE, args, {
          cwd,
          env: {
            ...process.env,
            GOOSE_WORKING_DIR: cwd,
            GOOSE_PROVIDER: "openai",
            GOOSE_MODEL: "qwen3.8-27b",
            OPENAI_HOST: BASE_URL.replace(/\/v1$/, ""),
            OPENAI_API_KEY: key,
            OPENAI_BASE_PATH: "v1/chat/completions",
          },
          windowsHide: true,
          // Explicit, not incidental: an unset stdin is an open pipe nothing ever
          // closes, which is exactly what hung the previous (pi CLI subprocess)
          // design indefinitely. Never spawn an agent CLI here without this.
          stdio: ["ignore", "pipe", "pipe"],
        });
        entry.child = child;

        let buf = "";
        child.stdout.on("data", (chunk) => {
          buf += chunk.toString("utf8");
          let idx;
          while ((idx = buf.indexOf("\n")) !== -1) {
            entry.lines.push(buf.slice(0, idx));
            buf = buf.slice(idx + 1);
          }
        });
        // Capped at 8000 chars so a runaway or noisy process can't grow this
        // unbounded - a stack trace or extension-load error easily fits well
        // under that, and this is diagnostic text, not something truncation
        // correctness depends on.
        child.stderr.on("data", (chunk) => {
          entry.stderr = (entry.stderr + chunk.toString("utf8")).slice(-8000);
        });

        let settled = false;
        const finish = (timedOut) => {
          if (settled) return;
          settled = true;
          if (buf) entry.lines.push(buf);
          const result = entry.cancelled
            ? { isError: true, text: "delegate_coding_task: cancelled by caller. " + summarizeGooseRun(entry.lines, { timedOut: false, timeoutMs: entry.timeoutMs, stderr: entry.stderr }).text }
            : summarizeGooseRun(entry.lines, { timedOut, timeoutMs: entry.timeoutMs, stderr: entry.stderr });
          entry.done = true;
          entry.result = result;
          setTimeout(() => pendingTasks.delete(taskId), TASK_RETENTION_MS);
          resolve(result);
        };

        const killTimer = setTimeout(() => {
          // taskkill /T kills the whole process tree, not just goose.exe itself -
          // plain child.kill() on Windows only signals the immediate PID, which can
          // orphan a long-running verification command (tsc, npm test, ...) that
          // Goose's shell tool spawned and is still waiting on.
          execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], () => {});
          finish(true);
        }, entry.timeoutMs);

        child.on("close", () => {
          clearTimeout(killTimer);
          finish(false);
        });
        child.on("error", (err) => {
          clearTimeout(killTimer);
          if (settled) return;
          settled = true;
          const result = { isError: true, text: `delegate_coding_task: failed to spawn goose - ${err.message}` };
          entry.done = true;
          entry.result = result;
          setTimeout(() => pendingTasks.delete(taskId), TASK_RETENTION_MS);
          resolve(result);
        });
      });
    }
  );

  return { taskId, promise };
}

const server = new McpServer({ name: "qwen38-local", version: "1.1.0" });

const commonSchema = {
  prompt: z.string().describe("The task or question to send to Qwen3.8-27B"),
  system: z.string().optional().describe("Optional system prompt"),
  max_tokens: z.number().int().positive().max(8192).optional().describe("Max output tokens (default 4096 - reasoning consumes a real chunk of this budget)"),
  reasoning_effort: z
    .enum(["off", "low", "medium", "xhigh"])
    .optional()
    .describe(
      "Reasoning depth. Default (omit this) is 'medium', set server-side - validated as the " +
        "right balance: a real accuracy lift over 'off', without 'xhigh' (the model's own " +
        "template default) burning the whole token budget on trivial tasks. Use 'xhigh' only " +
        "for genuinely hard multi-step problems where you've budgeted enough max_tokens for " +
        "it; use 'off' only for simple lookups where any reasoning tax is wasted."
    ),
};

server.registerTool(
  "ask_qwen",
  {
    title: "Ask Qwen3.8-27B (default — 245K context)",
    description:
      "DEFAULT tool for delegating a pure-text task (no file/tool access) to the local " +
      "Qwen3.8-27B model: explaining an error, drafting text, answering a question about " +
      "code already pasted into the conversation. For anything that needs to touch files " +
      "or run commands, use delegate_coding_task instead. Runs the huge configuration " +
      "(245,760 token context, ~77 tok/s decode) - fast enough for essentially all " +
      "delegated text work. Auto-boots this config if the rarely-used fast config is " +
      "currently running (costs ~45-90s once, only on the first call after a switch).",
    inputSchema: commonSchema,
  },
  async ({ prompt, system, max_tokens, reasoning_effort }) => {
    const text = await ask("huge", prompt, system, max_tokens, reasoning_effort);
    return { content: [{ type: "text", text }] };
  }
);

server.registerTool(
  "ask_qwen_fast",
  {
    title: "Ask Qwen3.8-27B (fast, 57K context - rarely needed)",
    description:
      "NOT the default - prefer ask_qwen. Only use this if you have already confirmed " +
      "ask_qwen's ~77 tok/s is a genuine bottleneck for a specific, tight, latency-critical " +
      "loop (many small sequential calls where cumulative delay matters more than context " +
      "headroom). Trades context (57,344 vs 245,760 tokens) for higher throughput " +
      "(~107-130 tok/s). Switching back and forth between this and ask_qwen costs ~45-90s " +
      "each time, so do not alternate between the two within the same task - pick one and " +
      "stay on it. Auto-boots this config if ask_qwen's huge config is currently running.",
    inputSchema: commonSchema,
  },
  async ({ prompt, system, max_tokens, reasoning_effort }) => {
    const text = await ask("fast", prompt, system, max_tokens, reasoning_effort);
    return { content: [{ type: "text", text }] };
  }
);

server.registerTool(
  "qwen_status",
  {
    title: "Check which Qwen3.8-27B config is running",
    description: "Returns 'fast', 'huge', 'unknown', or 'not running' without booting anything.",
    inputSchema: {},
  },
  async () => {
    const mode = (await currentMode()) ?? "not running";
    return { content: [{ type: "text", text: mode }] };
  }
);

server.registerTool(
  "delegate_coding_task",
  {
    title: "Delegate a coding task to local Qwen3.8-27B (real agentic loop, real MCP tools)",
    description:
      "Hands ONE isolated, fully-specified coding subtask to the local Qwen3.8-27B " +
      "model via Goose (block/goose), which runs a REAL multi-step agentic loop with " +
      "its own file/edit/shell tools - it can read files, make edits, run commands, " +
      "for $0 instead of subscription tokens. It never self-verifies (no build/typecheck/" +
      "test pass) - that option was removed after a ~1-in-16 real-world success rate; " +
      "verify the result yourself against disk instead, every time. This is NOT a text " +
      "relay: Qwen actually touches the filesystem in `cwd`. Optionally attach real MCP " +
      "servers via `extensions` (e.g. GitHub, Context7, Playwright) so Qwen can use them " +
      "mid-task - USE `npx.cmd`, NOT bare `npx`, in any npx-based extension command on this " +
      "box: Goose's Rust process spawner cannot execute `npx` directly (it's a `.cmd` shim " +
      "on Windows, not a real .exe - confirmed via captured stderr: \"Failed to start " +
      "extension 'npx' (IO error: program not found)\"); `npx.cmd -y @playwright/mcp@latest` " +
      "confirmed working live (Qwen reported real Playwright browser tools available). Note: " +
      "Playwright MCP blocks `file://` URLs by default (real sites work fine) - for local " +
      "file verification specifically, headless Chrome is still simpler: launch " +
      "`C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe --headless --disable-gpu " +
      "--dump-dom <url>` via Python's subprocess module (not a raw shell string - cmd.exe " +
      "mangles the space in \"Program Files\"), and read the DOM output - also proven to " +
      "work. Concurrent calls are automatically managed - up to 4 run genuinely in " +
      "parallel (this server's actual engine capacity, confirmed from its launch " +
      "config: --max-num-seqs 4 with real prefix-cache sharing between them, and " +
      "live-verified: the KV pool holds at 268,169 tokens regardless), a 5th " +
      "queues until a slot frees. Use for: implementing a function/feature whose shape is " +
      "decided, scripts, boilerplate, single-file/module refactors, tests for " +
      "existing code, an already-diagnosed bug fix, docs/comments, reformatting, or " +
      "research-and-implement tasks that need an MCP tool. Do NOT use for " +
      "architecture decisions, ambiguous requirements, or security-critical review - " +
      "keep those yourself. Keep each call scoped to roughly one file or one tightly " +
      "bounded change - a task spanning many files at once has been observed to land " +
      "nothing at all rather than partial progress; split large work into sequential " +
      "calls instead. Returns a structured summary (files touched, final message, " +
      "any tool errors) - not the raw agent trace. If the task doesn't finish within " +
      "~50s (your own client likely can't wait longer than that anyway), this " +
      "returns a taskId instead - poll it with qwen_check_task. The underlying work " +
      "is NOT cancelled by that early return; it keeps running and will complete. " +
      "IMPORTANT: even on a timeout, check the returned summary for 'Files touched' " +
      "before assuming nothing happened - always confirm against the actual file on " +
      "disk, never trust the summary text alone as proof of correctness. A run can " +
      "reasonably take 30-150s. Time budget is 400s normally, 900s if `extensions` is " +
      "non-empty (a first-time npx package download alone can cost ~500s) - expect to " +
      "use qwen_check_task for most non-trivial tasks. If you " +
      "decide to stop waiting and do the work yourself instead, call qwen_cancel_task " +
      "on the taskId first - an abandoned task keeps running and can write to disk " +
      "AFTER you've already made the same fix by hand, silently clobbering it.",
    inputSchema: {
      cwd: z
        .string()
        .describe(
          "Absolute path to the directory Qwen should operate in. Its file/edit/shell " +
            "tools are scoped to this directory."
        ),
      task: z
        .string()
        .describe(
          "A fully self-contained task description. Qwen has NO access to this " +
            "conversation - include exact file paths and exact expected behavior. Do not " +
            "instruct it to run build/typecheck/test commands to verify its own work - it " +
            "won't (see tool description); verify against disk yourself after it returns. " +
            "For any UI-facing change, DO instruct it to drive headless Chrome directly " +
            "(see tool description) and report what actually rendered."
        ),
      mode: z
        .enum(["huge", "fast"])
        .optional()
        .describe("Server config to use - default 'huge' (245K ctx). Only pass 'fast' for a confirmed latency-critical case."),
      extensions: z
        .array(z.string())
        .optional()
        .describe(
          "Optional stdio MCP servers to attach for this task, each in Goose's " +
            "--with-extension format: '[name:]ENV1=val1 command args...' (this exact format " +
            "confirmed against Goose's own docs - the syntax itself is not the suspected " +
            "problem below). UNVERIFIED on this box for at least one real package " +
            "(@playwright/mcp attached, confirmed via a live test that it never registered " +
            "in Goose's toolset - stderr wasn't captured at the time, root cause still " +
            "undiagnosed as of the last check; capture was added 2026-08-23, re-test before " +
            "trusting any extension). Do not assume an extension works without confirming " +
            "from the actual result text. " +
            "FOR DEEP RESEARCH (multi-source web research, not just one known URL): pass " +
            "['uvx free-search-mcp'] (no API key needed) and instruct Qwen to use its " +
            "`research()` tool - one call does search + fetch + brief generation. CONFIRMED " +
            "WORKING live 2026-08-23 (registers as extension 'uvx' with tools search/" +
            "research/fetch/fetch_batch/read_doc - the last one reads PDF/DOCX/XLSX directly, " +
            "which this orchestrator doesn't have natively). " +
            "For UI/browser verification, either instruct Qwen to drive headless Chrome " +
            "directly via shell (see tool description, proven to work, no attachment step to " +
            "fail), or attach Playwright with `npx.cmd -y @playwright/mcp@latest` - CONFIRMED " +
            "WORKING live 2026-08-23 after fixing the npx/npx.cmd issue above (real browser " +
            "tools, though it blocks file:// URLs by default - use headless Chrome instead " +
            "for local file verification, Playwright for real sites). " +
            "FOR GITHUB WORK: no extension needed - `gh` CLI is installed and already " +
            "authenticated (repo/workflow/gist/read:org scopes) on this box, so Qwen can " +
            "call it directly via its `shell` tool (`gh pr create`, `gh issue comment`, etc.) " +
            "for real work. Since it's a real authenticated account, state exactly what " +
            "GitHub actions are in scope for the task - don't leave it open-ended. " +
            "Omit extensions for plain file/shell work - they add real latency, a first-time " +
            "download alone can cost ~500s (covered by a larger time budget automatically " +
            "when extensions is non-empty), and a somewhat higher chance the model picks the " +
            "wrong tool on the first try."
        ),
    },
  },
  async ({ cwd, task, mode, extensions }) => {
    // Model boot (ensureMode/getApiKey) happens INSIDE startGooseTask now, after
    // the taskId is already registered - see the comment there. Do not await
    // boot here first; a cold boot can take up to BOOT_TIMEOUT_MS (180s), which
    // would blow through RACE_MS and the client's own hard timeout with no
    // taskId ever having been handed back to poll.
    const { taskId, promise } = startGooseTask({ cwd, task, mode, extensions });

    // Race against RACE_MS, not DELEGATE_TIMEOUT_MS: Claude Desktop's own MCP
    // client times out a tool call at a hardcoded ~60s regardless of what this
    // server does, so waiting longer than that here would never actually be seen
    // by the caller anyway (confirmed directly - the task keeps running and
    // completes fine, but the response has nowhere to go once the client's given
    // up). Returning early with a taskId lets the caller poll instead.
    const winner = await Promise.race([
      promise.then((r) => ({ ready: true, ...r })),
      new Promise((resolve) => setTimeout(() => resolve({ ready: false }), RACE_MS)),
    ]);

    if (winner.ready) {
      return { content: [{ type: "text", text: winner.text }], isError: winner.isError };
    }
    return {
      content: [
        {
          type: "text",
          text:
            `Still running after ${RACE_MS / 1000}s - this is normal for a non-trivial task, not a failure. ` +
            `The work continues in the background even if your client shows this as timed out. ` +
            `Call qwen_check_task with taskId "${taskId}" in 30-60s to get the result (it will tell you ` +
            `whether the task is still queued behind other work or actually executing). Do not re-dispatch ` +
            `the same task while this is still running - it would just queue behind itself. If you decide ` +
            `to do the work yourself instead of waiting, call qwen_cancel_task on this taskId first.\n\n` +
            `${unfinishedTaskCount()} task(s) total are currently unfinished on this server (including this ` +
            `one) - if you dispatched more than one and moved on to other work, come back and poll ALL of ` +
            `them with qwen_check_task before their results age out (kept for ${TASK_RETENTION_MS / 60000} ` +
            `minutes after completion). A result you never collect is silently lost.\n\n` +
            `TO WAIT WITHOUT SPENDING A TURN PER CHECK: run, via your Bash tool with run_in_background:true, ` +
            `\`until curl -s http://127.0.0.1:${STATUS_PORT}/task/${taskId} | grep -q '"done":true'; do sleep 15; done\` ` +
            `- this sleeps real wall-clock time outside your own context and notifies you once, on completion, ` +
            `instead of you polling qwen_check_task repeatedly (each poll permanently adds to conversation ` +
            `context, re-sent on every later turn - this is the actual mechanism behind delegation eating a ` +
            `token budget, more than any manual work). Call qwen_check_task exactly once after that ` +
            `notification to get the formatted result - the curl loop only tells you WHEN, not WHAT.`,
        },
      ],
      isError: false,
    };
  }
);

server.registerTool(
  "qwen_check_task",
  {
    title: "Check the result of a delegate_coding_task call that didn't finish within the response window",
    description:
      "Poll for the result of a delegate_coding_task call that returned a taskId instead of a " +
      "final result because it was still running. Safe to call repeatedly - returns current " +
      "progress (tool calls/files touched so far) if still running, or the final structured " +
      "result once done. Results remain checkable for 3 hours after completion.",
    inputSchema: {
      taskId: z.string().describe("The taskId returned by a delegate_coding_task call that hadn't finished yet."),
    },
  },
  async ({ taskId }) => {
    const entry = pendingTasks.get(taskId);
    if (!entry) {
      return {
        content: [
          {
            type: "text",
            text: `No task found with id "${taskId}" - either it's a typo, or it finished and was cleaned up more than ${TASK_RETENTION_MS / 60000} minutes ago.`,
          },
        ],
        isError: true,
      };
    }
    if (entry.done) {
      return { content: [{ type: "text", text: entry.result.text }], isError: entry.result.isError };
    }
    // Distinguish queued from running - a real session mistook queue wait for a
    // hang (see startGooseTask comment), because this used to report one
    // undifferentiated "elapsed" number covering both.
    if (!entry.execStartedAt) {
      const waitS = Math.round((Date.now() - entry.startedAt) / 1000);
      const backlog = `${unfinishedTaskCount()} task(s) total are currently unfinished on this server - if that's more than 1, make sure you come back for all of them.`;
      const text = entry.booting
        ? `Still queued or booting the model server (${waitS}s) - ${entry.queuePositionAtEnqueue} task(s) were ` +
          `ahead of it when dispatched (up to ${MAX_CONCURRENT_GOOSE} run concurrently, this server's real ` +
          `engine capacity - more than that waits for a slot), and/or the server needs a cold start (up to ` +
          `180s the first time after a mode switch or idle shutdown). This is not a hang; Goose starts once a ` +
          `slot frees and the server responds. Call qwen_cancel_task with this taskId if you no longer need it. ${backlog}`
        : `Still queued (${waitS}s), not yet executing - ${entry.queuePositionAtEnqueue} task(s) were ` +
          `ahead of it when dispatched (up to ${MAX_CONCURRENT_GOOSE} run concurrently, this server's real ` +
          `engine capacity - more than that waits for a slot). This is not a hang; it starts once a slot frees. ` +
          `Call qwen_cancel_task with this taskId if you no longer need it. ${backlog}`;
      return { content: [{ type: "text", text }], isError: false };
    }
    const execS = Math.round((Date.now() - entry.execStartedAt) / 1000);
    const { text: progressText } = summarizeGooseRun(entry.lines, { timedOut: false, timeoutMs: entry.timeoutMs, stderr: entry.stderr });
    return {
      content: [
        {
          type: "text",
          text: `Executing (${execS}s so far, budget ${entry.timeoutMs / 1000}s, ${unfinishedTaskCount()} task(s) unfinished total). Progress so far:\n\n${progressText}`,
        },
      ],
      isError: false,
    };
  }
);

server.registerTool(
  "qwen_cancel_task",
  {
    title: "Cancel a delegate_coding_task run you no longer intend to wait for",
    description:
      "Kill a still-running or still-queued delegate_coding_task run. Use this when you've " +
      "decided to do the work yourself instead of waiting (e.g. after a timeout) - otherwise " +
      "the abandoned task keeps running on the GPU and can land a write AFTER you've already " +
      "fixed the file by hand, silently clobbering it. Safe to call on a task that's already " +
      "finished (no-op). Frees the GPU immediately for the next queued task if this one was " +
      "still executing.",
    inputSchema: {
      taskId: z.string().describe("The taskId to cancel."),
    },
  },
  async ({ taskId }) => {
    const entry = pendingTasks.get(taskId);
    if (!entry) {
      return { content: [{ type: "text", text: `No task found with id "${taskId}" - already finished and cleaned up, or a typo.` }], isError: true };
    }
    if (entry.done) {
      return { content: [{ type: "text", text: `Task "${taskId}" already finished before the cancel request arrived - nothing to do.` }], isError: false };
    }
    entry.cancelled = true;
    if (entry.child?.pid) {
      execFile("taskkill", ["/PID", String(entry.child.pid), "/T", "/F"], () => {});
      return { content: [{ type: "text", text: `Cancelled task "${taskId}" - it was executing; killed the process tree.` }], isError: false };
    }
    return {
      content: [
        {
          type: "text",
          text: `Marked task "${taskId}" cancelled - it was still queued or booting the model server; it will not spawn Goose when its turn comes.`,
        },
      ],
      isError: false,
    };
  }
);

// Serializes exactly what a waiting shell loop needs: is it done, and if so was it
// an error - nothing more. The actual formatted result text still comes from
// qwen_check_task (MCP), which the caller calls once, after this confirms "done" -
// this endpoint's only job is to make waiting free of LLM turns, not to duplicate
// summarizeGooseRun's formatting logic.
function statusServer() {
  const http = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    const match = /^\/task\/([^/?]+)/.exec(req.url ?? "");
    if (req.method !== "GET" || !match) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: "GET /task/<taskId> only" }));
      return;
    }
    const entry = pendingTasks.get(decodeURIComponent(match[1]));
    if (!entry) {
      res.writeHead(404);
      res.end(JSON.stringify({ found: false }));
      return;
    }
    res.writeHead(200);
    res.end(
      JSON.stringify({
        found: true,
        done: entry.done,
        booting: entry.booting,
        executing: !entry.done && !!entry.execStartedAt,
        isError: entry.done ? entry.result.isError : null,
      })
    );
  });
  // CRITICAL: each Claude surface (Desktop, Code, Cowork, ...) spawns its OWN
  // separate process running this same stdio MCP server - only the first one can
  // actually bind this port, every later one hits EADDRINUSE. An unhandled 'error'
  // event on an http.Server is an uncaught exception in Node, which kills the
  // ENTIRE process - not just this listener, the whole MCP server, stdio
  // connection included. Confirmed this happened for real: added this endpoint,
  // multiple sessions' qwen38-local tools went down within seconds of each other
  // (log showed "Connection closed" moments after a successful tools/list). This
  // handler is what makes losing the port race harmless instead of fatal - that
  // instance just runs without a working status mirror; its actual MCP tools
  // (delegate_coding_task etc, all stdio-based, never depended on this port) are
  // completely unaffected either way.
  http.on("error", (err) => {
    console.error(`status endpoint: could not bind ${STATUS_PORT} (${err.code ?? err.message}) - continuing without it, another session's process likely already holds it`);
  });
  // 127.0.0.1, not 0.0.0.0: this is a same-machine convenience for background
  // shell loops, never meant to be reachable off this box.
  http.listen(STATUS_PORT, "127.0.0.1");
  return http;
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  statusServer();
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
