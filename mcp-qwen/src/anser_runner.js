import crypto from "node:crypto";
import {
  IS_WINDOWS,
  DEFAULT_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  EXTENSION_BONUS_TIMEOUT_MS,
  MAX_TURNS,
  BASE_TURN_BUDGET,
  SESSION_TURNS_RECOMMEND,
  getReasoningEffort,
} from "./config.js";
import {
  isWslLocation,
  toPosixWslPath,
  toWindowsPath,
  canonicalizePath,
} from "./wsl_bridge.js";
import {
  ensureServerRunning,
  ensureStreamProxyRunning,
  withBootMutex,
} from "./server_lifecycle.js";
import { runQueued } from "./semaphore.js";
import {
  tasks,
  saveTaskToDisk,
  notifyWaiters,
} from "./task_registry.js";
import { EvoLineageEngine } from "./evo_engine.js";
import { AnserRunner } from "./harness/runner.js";
import { injectSkills } from "./skills.js";
import { recordTaskResult } from "./telemetry.js";

const READ_TOOLS = new Set(["read_file", "list_dir", "search_code", "ast_search"]);
const MUTATION_TOOLS = new Set([
  "write_file",
  "edit_file",
  "apply_patch",
  "ast_replace",
  "ast_replace_batch",
  "evo_propose_candidate",
  "evo_select_candidate",
  "evo_revert_candidate",
]);
const COMMAND_TOOLS = new Set(["bash"]);
const WEB_TOOLS = new Set(["web_search", "web_fetch"]);

/**
 * Pure predicate: does a runner status represent a successful task completion?
 *
 * The Anser runner reports an honest status taxonomy. A task is a SUCCESS when
 * the model produced a complete deliverable:
 *   - "completed"         — clean stop, never exhausted the continuation budget.
 *   - "completed_ceiling" — the model hit the token ceiling the maximum number
 *                           of times (continuation budget exhausted) but still
 *                           produced a complete, non-empty deliverable. This is
 *                           a SUCCESS, not a failure: the work is done, it just
 *                           ran out of room.
 *
 * Every other status is a FAILURE (isError = true):
 *   - "failed"                    — the runner's outer catch (a real upstream
 *                                   error thrown by the provider, a tool crash,
 *                                   or an aborted fetch).
 *   - "engine_empty_response"     — the engine kept returning empty generations.
 *   - "reasoning_budget_exhausted"— the model burned the whole budget on
 *                                   thinking and emitted no visible content.
 *   - "length_limit_reached"      — the model hit the ceiling and produced no
 *                                   usable content.
 *   - "degenerate_response_truncated" — the stream proxy circuit-broke a
 *                                   runaway repetition loop and the final
 *                                   message was just the guard marker (or a
 *                                   tiny sliver of text + marker) with no tool
 *                                   calls in a short session; the retry budget
 *                                   was exhausted. The original partial+marker
 *                                   is preserved in finalText for honesty.
 *   - "turn_limit_reached"        — the maxTurns cap was hit.
 *   - "context_exhausted"         — prompt context exceeded 245K token ceiling.
 *   - "aborted"                   — the client cancelled the run.
 *   - unknown / null / undefined  — fail closed: treat as an error.
 *
 * This is the single source of truth for the status -> isError mapping used by
 * the task-completion path in startAnserTask. It is a pure function so it can
 * be unit-tested offline without spawning a live engine.
 *
 * @param {string|undefined|null} status
 * @returns {boolean}
 */
export function isSuccessStatus(status) {
  return (
    status === "completed" ||
    status === "completed_ceiling" ||
    status === "completed_budget_exhausted"
  );
}

/**
 * M5b: pure helper that assembles the ORCHESTRATOR-facing result text.
 *
 * Appends structured advisory banners and recommendation markers:
 *   - Turn budget exhausted (100 turns): warning banner advising critical review
 *     of partial/synthesized deliverable.
 *   - Session >= 80 turns: note banner advising context-depth consolidation and
 *     the machine-readable SessionTurnLimitRecommendation marker.
 *
 * @param {string} finalText The runner's final text (the model's deliverable).
 * @param {number|undefined|null} sessionTurns The session-cumulative turn count.
 * @param {string|undefined|null} [status] The final runner status.
 * @returns {string} The augmented result text.
 */
export function buildResultText(finalText, sessionTurns, status) {
  let text = finalText;
  if (status === "completed_budget_exhausted") {
    text =
      `${text}\n\n` +
      `> [!WARNING] **Turn Limit Reached (Budget Exhausted)**\n` +
      `> The coworker reached the maximum turn budget for this dispatch. All tools were disabled and a mandatory final synthesis was performed.\n` +
      `> **Advisory:** Take this deliverable with a grain of salt. It represents grounded observations and partial progress gathered up to the turn limit, but may be incomplete or lack final verification. Review findings critically and dispatch a focused follow-up slice if needed.`;
  }
  if (
    typeof sessionTurns === "number" &&
    sessionTurns >= SESSION_TURNS_RECOMMEND
  ) {
    if (status !== "completed_budget_exhausted") {
      text =
        `${text}\n\n` +
        `> [!NOTE] **High Turn Count Advisory (Turn ${sessionTurns})**\n` +
        `> The coworker completed this deliverable in a session that has reached ${sessionTurns} cumulative turns (>= ${SESSION_TURNS_RECOMMEND}).\n` +
        `> **Advisory:** As context depth grows, early consolidation can occur and speculative decoding degrades. Validate critical findings and roll to a fresh session_id before the next dispatch.`;
    }
    text =
      `${text}\n` +
      `[SessionTurnLimitRecommendation: session at ${sessionTurns} turns — roll to a fresh session_id before the next dispatch]`;
  }
  return text;
}

// FX2: the charset the system itself generates for session ids. The default
// generator produces `workspace_<md5hex8>_<pid-b36>_<ts-b36>`; the shell
// executor tags are `qwen_sh_<ts>_<rand>`; clients use `<milestone>_s1`,
// `task-ui-ovh`, etc. All of these are [A-Za-z0-9._:-]. A session id is
// interpolated into a single-quoted POSIX shell string (the anchored
// pgrep sweep in wsl_bridge.js), so any
// character outside this charset (a single quote, `;`, backtick, space,
// newline, ...) is a shell-injection vector. We REFUSE such ids loudly
// (fail-fast) rather than silently sanitizing them.
const SESSION_ID_CHARSET = /^[A-Za-z0-9._:-]+$/;

export function resolveSessionId(cwd, requestedSessionId) {
  if (requestedSessionId && requestedSessionId.trim()) {
    const id = requestedSessionId.trim();
    if (!SESSION_ID_CHARSET.test(id)) {
      throw new Error(
        `Invalid session_id "${id}": session ids must match [A-Za-z0-9._:-]+ ` +
          `(the charset the system generates, e.g. qwen_sh_<ts>_<rand>, ` +
          `<milestone>_s1). Refusing to use a session id containing shell ` +
          `metacharacters (quote, ;, backtick, space, newline, ...) to prevent ` +
          `shell injection in the anchored process sweep.`
      );
    }
    return id;
  }
  const hash = crypto.createHash("md5").update(cwd.toLowerCase()).digest("hex").slice(0, 8);
  // P15: the default session id must be unique per task, not just per cwd.
  // The old `workspace_<hash8(cwd)>` was shared by EVERY instance and EVERY
  // task in the same directory, so (a) a cancel sweep of one instance's task
  // could match and kill ANOTHER instance's live child with the same
  // id, and (b) two clients in one directory wrote to the same
  // ~/.qwen/sessions/<id>/events.jsonl (cross-client ledger bleed). The
  // pid + timestamp suffixes make each default id unique while keeping the
  // `workspace_` prefix. Explicit client-passed ids are untouched above.
  return `workspace_${hash}_${process.pid.toString(36)}_${Date.now().toString(36)}`;
}

export function startAnserTask({
  cwd,
  prompt,
  sessionId,
  extensions,
  timeoutMs,
  hypothesis,
  testCommand,
  metricName,
  higherIsBetter,
  skills,
  reasoningEffort,
}) {
  // P4i: canonicalize the task cwd ONCE at the spawn boundary, through the OS
  // symlink/junction resolution layer. This is the single point where the
  // working directory is persisted to the task entry and handed to every
  // downstream spawn (AnserRunner, the test command).
  // If the MCP server process was launched through a junction/symlink cwd,
  // process.cwd() returns the junction literal; canonicalizing here makes the
  // entire spawn pipeline operate on the real path, eliminating false
  // SymlinkEscapeError/PathEscapeError in the child's sandboxed services.
  // A requested real-path cwd is unaffected (realpath is a no-op on a
  // non-junction path); a genuinely outside cwd is still caught by the
  // per-service containment checks downstream.
  cwd = canonicalizePath(cwd);
  const taskId = `task_${sessionId}_${Date.now()}`;
  const baseTimeoutMs = Math.max(timeoutMs ?? DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS);
  const totalTimeoutMs =
    baseTimeoutMs + (extensions && extensions.length ? EXTENSION_BONUS_TIMEOUT_MS : 0);

  // Effective reasoning effort for THIS task: the per-dispatch param when
  // provided, else the QWEN_REASONING_EFFORT env default (read at dispatch
  // time). Surfaced on the task record for telemetry; the provider re-resolves
  // the same value per request (param precedence, env fallback).
  const effectiveReasoningEffort = reasoningEffort || getReasoningEffort();

  const taskEntry = {
    id: taskId,
    sessionId,
    cwd,
    prompt,
    reasoningEffort: effectiveReasoningEffort,
    ownerPid: process.pid,
    ownerPlatform: process.platform,
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    lastActivityAt: null,
    lastHeartbeatAt: Date.now(),
    budgetTurns: BASE_TURN_BUDGET,
    leaseExtensionsCount: 0,
    lastActivityPreview: "",
    toolOpsSummary: { reads: 0, mutations: 0, commands: 0, web: 0 },
    lastTool: null,
    streamBytes: 0,
    streamTail: "",
    status: "queued",
    done: false,
    isError: false,
    child: null,
    lines: [],
    fileOps: [],
    toolCallsCount: 0,
    result: null,
    waiters: [],
  };

  tasks.set(taskId, taskEntry);
  saveTaskToDisk(taskEntry);

  const executionPromise = runQueued(
    async () => {
      if (taskEntry.done || taskEntry.status === "cancelled") {
        return taskEntry.result ?? { isError: true, text: "Task was cancelled before execution." };
      }
      try {
        await withBootMutex(async () => {
          if (taskEntry.done || taskEntry.status === "cancelled") return;
          await ensureServerRunning();
          await ensureStreamProxyRunning();
        });
        if (taskEntry.done || taskEntry.status === "cancelled") {
          return taskEntry.result ?? { isError: true, text: "Task was cancelled before dispatch." };
        }
      } catch (err) {
        taskEntry.done = true;
        taskEntry.isError = true;
        taskEntry.status = "failed";
        taskEntry.result = { isError: true, text: `Failed to boot model server: ${err.message}` };
        try {
          recordTaskResult({ isSuccess: false, effort: effectiveReasoningEffort });
        } catch {}
        notifyWaiters(taskEntry);
        return taskEntry.result;
      }

      let lineageEngine = null;
      let evoContext = null;
      if (testCommand) {
        try {
          lineageEngine = new EvoLineageEngine(cwd);
          evoContext = await lineageEngine.getLineageContext();
        } catch {}
      }

      const cwdInWsl = isWslLocation(cwd);
      const targetInWsl = cwdInWsl || (IS_WINDOWS && process.env.QWEN_FORCE_WSL !== "0");
      const targetCwd = targetInWsl ? toPosixWslPath(cwd) : toWindowsPath(cwd);

      // P9: keyword auto-inject matching skills from the packaged skills/
      // library into the instruction block. Additive and budget-capped; when
      // nothing matches the prompt is returned unchanged. Never throws.
      const effectivePrompt = injectSkills(prompt, targetCwd, undefined, skills);

      let finalTaskPrompt = `Your working directory is: ${targetCwd}\n\n`;
      if (evoContext) {
        finalTaskPrompt += `=== Evo Lineage Context ===\n${evoContext}\n\n`;
      }
      if (hypothesis) {
        finalTaskPrompt += `=== Current Hypothesis ===\n${hypothesis}\n\n`;
      }
      finalTaskPrompt += effectivePrompt;

      // Primary Engine: Anser (microkernel + sandboxed services) - hard-wired, no engine selection.
      taskEntry.startedAt = Date.now();
      taskEntry.status = "running";
      saveTaskToDisk(taskEntry);

      const runner = new AnserRunner({ cwd: targetCwd });
      const abortController = new AbortController();
      taskEntry.abortController = abortController;

      const maxTurnsVal = taskEntry.budgetTurns || MAX_TURNS || BASE_TURN_BUDGET;
      const heartbeatTimer = setInterval(() => {
        if (taskEntry.done) {
          clearInterval(heartbeatTimer);
          return;
        }
        taskEntry.lastHeartbeatAt = Date.now();
        saveTaskToDisk(taskEntry);
      }, 5_000);
      heartbeatTimer.unref();

      try {
        const runResult = await runner.run({
          prompt: finalTaskPrompt,
          cwd: targetCwd,
          sessionId,
          maxTurns: maxTurnsVal,
          getDynamicBudget: () => taskEntry.budgetTurns || maxTurnsVal,
          onActivity: (preview) => {
            taskEntry.lastActivityPreview = preview;
            taskEntry.lastHeartbeatAt = Date.now();
            saveTaskToDisk(taskEntry);
          },
          // Task-local reasoning-effort override (per-dispatch). Threaded RAW
          // (may be undefined) to the provider so its existing dynamic
          // QWEN_REASONING_EFFORT read remains the fallback when the param is
          // absent — no process.env mutation, no cross-task leakage.
          reasoningEffort,
          signal: abortController.signal,
          // P8: make extensions[] first-class on the primary engine. The
          // runner boots the MCP extension bridge before the loop and
          // disposes it in its finally block (no leaked children).
          extensions,
          targetInWsl,
          onToken: (tok) => {
            taskEntry.lastActivityAt = Date.now();
            taskEntry.lastHeartbeatAt = Date.now();
            taskEntry.streamBytes = (taskEntry.streamBytes || 0) + tok.length;
            taskEntry.streamTail = (taskEntry.streamTail + tok).slice(-4096);
          },
          onToolCall: (tc) => {
            taskEntry.toolCallsCount = (taskEntry.toolCallsCount || 0) + 1;
            taskEntry.fileOps.push(`${tc.name}:${tc.args?.path || ""}`);
            if (!taskEntry.toolOpsSummary) {
              taskEntry.toolOpsSummary = { reads: 0, mutations: 0, commands: 0, web: 0 };
            }
            if (READ_TOOLS.has(tc.name)) taskEntry.toolOpsSummary.reads++;
            else if (MUTATION_TOOLS.has(tc.name)) taskEntry.toolOpsSummary.mutations++;
            else if (COMMAND_TOOLS.has(tc.name)) taskEntry.toolOpsSummary.commands++;
            else if (WEB_TOOLS.has(tc.name)) taskEntry.toolOpsSummary.web++;

            let argSummary = "";
            if (tc.args?.path) argSummary = String(tc.args.path);
            else if (tc.args?.command) argSummary = String(tc.args.command).replace(/[\r\n]+/g, " ").slice(0, 80);
            else if (tc.args?.query) argSummary = String(tc.args.query).slice(0, 60);
            else if (tc.args?.url) argSummary = String(tc.args.url).slice(0, 60);

            taskEntry.lastTool = {
              name: tc.name,
              summary: argSummary,
              timestamp: Date.now(),
            };
            taskEntry.lastActivityAt = Date.now();
            taskEntry.lastHeartbeatAt = Date.now();
            saveTaskToDisk(taskEntry);
          },
        });

        if (lineageEngine && testCommand) {
          try {
            await lineageEngine.recordCandidate({
              hypothesis: hypothesis || "Variation candidate",
              testCommand,
              metricName,
              higherIsBetter,
              stdout: runResult.finalText,
            });
          } catch {}
        }

        const isSuccess = isSuccessStatus(runResult.status);
        taskEntry.done = true;
        taskEntry.finishedAt = Date.now();
        taskEntry.status = runResult.status;
        taskEntry.isError = !isSuccess;
        // M5b: surface the 80-turn session-rollover recommendation to the
        // ORCHESTRATOR in the dispatch result text. The runner's M5a
        // `session_turn_limit_recommended` event lands in the session event
        // log, which the orchestrator rarely reads; the result text is what
        // it does read. When the session's CUMULATIVE turn count (prior
        // assistant_message events + this run's turnsTaken) reaches
        // SESSION_TURNS_RECOMMEND, buildResultText appends a structured
        // advisory line. ADVISORY ONLY: it never alters status/isError and
        // never cancels the task — the hard MAX_TURNS cap is untouched.
        //
        // NOTE: no anser_runner-level event sink exists in this module (no
        // EventLoggerService / logger), so per the M5b spec we do NOT emit a
        // `session_turn_limit_recommended` event from this layer and do NOT
        // invent a new sink — the M5a runner-side event (harness/runner.js)
        // already records it in the session log.
        const resultText = buildResultText(runResult.finalText, runResult.sessionTurns, runResult.status);
        taskEntry.result = {
          isError: !isSuccess,
          text: resultText,
          toolCalls: taskEntry.toolCallsCount,
          fileOps: (taskEntry.fileOps || []).slice(-5),
          durationMs: runResult.durationMs,
        };
        try {
          recordTaskResult({
            isSuccess,
            effort: effectiveReasoningEffort,
          });
        } catch {}
        saveTaskToDisk(taskEntry);
        notifyWaiters(taskEntry);
        return taskEntry.result;
      } catch (err) {
        taskEntry.done = true;
        taskEntry.finishedAt = Date.now();
        taskEntry.status = "failed";
        taskEntry.isError = true;
        taskEntry.result = {
          isError: true,
          text: `Anser runner error: ${err.message}`,
          toolCalls: taskEntry.toolCallsCount,
          fileOps: taskEntry.fileOps,
        };
        try {
          recordTaskResult({
            isSuccess: false,
            effort: effectiveReasoningEffort,
          });
        } catch {}
        saveTaskToDisk(taskEntry);
        notifyWaiters(taskEntry);
        return taskEntry.result;
      } finally {
        clearInterval(heartbeatTimer);
      }
    },
    taskEntry,
    (entry) => {
      saveTaskToDisk(entry);
    }
  );

  return { taskId, taskEntry, executionPromise, totalTimeoutMs };
}
