import crypto from "node:crypto";
import {
  IS_WINDOWS,
  DEFAULT_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  EXTENSION_BONUS_TIMEOUT_MS,
  MAX_TURNS,
  BASE_TURN_BUDGET,
  SESSION_TURNS_RECOMMEND,
  MAX_LEN_HUGE,
  getReasoningEffort,
} from "./config.js";
import {
  isWslLocation,
  toPosixWslPath,
  toWindowsPath,
  canonicalizePath,
  killSessionProcessTreeSync,
} from "./wsl_bridge.js";
import {
  ensureServerRunning,
  ensureStreamProxyRunning,
  withBootMutex,
} from "./server_lifecycle.js";
import { runQueued, clearReclaimableTaskSlots } from "./semaphore.js";
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
 * Assembles the orchestrator-facing result text with advisory metadata.
 *
 * Appends structured advisory banners when thresholds are reached:
 *   - Turn budget exhausted: warning banner advising review of partial deliverables.
 *   - Session turn limit reached: advisory note recommending context consolidation
 *     and the machine-readable SessionTurnLimitRecommendation marker.
 *
 * @param {string} finalText The runner's raw deliverable text.
 * @param {number|undefined|null} sessionTurns Cumulative session turn count.
 * @param {string|undefined|null} [status] Terminal status of the runner execution.
 * @returns {string} Formatted result string for client consumption.
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

/**
 * Permitted character set for session identifiers: [A-Za-z0-9._:-].
 * Validates session IDs fail-fast to prevent shell metacharacter injection
 * during process-tree management and process sweeps.
 * @type {RegExp}
 */
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
  // Generates a unique default session identifier combining directory hash, process PID, and timestamp.
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
  // Canonicalize task working directory through OS symlink and junction resolution
  // to ensure consistent realpath evaluation across sandboxed services.
  cwd = canonicalizePath(cwd);
  const taskId = `task_${sessionId}_${Date.now()}`;
  const baseTimeoutMs = Math.max(timeoutMs ?? DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS);
  const totalTimeoutMs =
    baseTimeoutMs + (extensions && extensions.length ? EXTENSION_BONUS_TIMEOUT_MS : 0);

  // Resolve task-level reasoning effort: explicit dispatch parameter takes precedence over environment default.
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
    lastPromptTokens: null,
    contextHeadroom: null,
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

      // Execute task within Anser microkernel and sandboxed service harness.
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
          // Pass dispatch-scoped reasoning effort to the model provider.
          reasoningEffort,
          signal: abortController.signal,
          // Initialize stdio MCP extension servers on the execution harness.
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
          // E3: live context-headroom tracking. Each turn's promptTokens
          // updates the task state so the status/wait endpoints can surface
          // remaining headroom to the orchestrator in real time.
          onMetrics: (m) => {
            if (typeof m?.promptTokens === "number" && m.promptTokens > 0) {
              taskEntry.lastPromptTokens = m.promptTokens;
              taskEntry.contextHeadroom = Math.max(0, MAX_LEN_HUGE - m.promptTokens);
            }
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
        // Propagate remaining context headroom telemetry to task state.
        taskEntry.lastPromptTokens = runResult.lastPromptTokens ?? null;
        taskEntry.contextHeadroom = runResult.contextHeadroom ?? null;

        // Append session-rollover advisory to result text when cumulative turn thresholds are reached.
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
        // Run idempotent post-task cleanup: terminate session process trees and release stale slot leases.
        try {
          killSessionProcessTreeSync(sessionId);
        } catch (err) {
          const msg = err && err.message ? err.message : String(err);
          console.error(`[anser_runner] session-end sweep failed for ${sessionId}: ${msg}`);
        }
        try {
          clearReclaimableTaskSlots();
        } catch (err) {
          const msg = err && err.message ? err.message : String(err);
          console.error(`[anser_runner] stale slot-lease cleanup failed: ${msg}`);
        }
      }
    },
    taskEntry,
    (entry) => {
      saveTaskToDisk(entry);
    }
  );

  return { taskId, taskEntry, executionPromise, totalTimeoutMs };
}
