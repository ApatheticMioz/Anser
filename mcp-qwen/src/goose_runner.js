import crypto from "node:crypto";
import {
  IS_WINDOWS,
  DEFAULT_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  EXTENSION_BONUS_TIMEOUT_MS,
  MAX_TURNS,
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
 *   - "turn_limit_reached"        — the maxTurns cap was hit.
 *   - "aborted"                   — the client cancelled the run.
 *   - unknown / null / undefined  — fail closed: treat as an error.
 *
 * This is the single source of truth for the status -> isError mapping used by
 * the task-completion path in startGooseTask. It is a pure function so it can
 * be unit-tested offline without spawning a live engine.
 *
 * @param {string|undefined|null} status
 * @returns {boolean}
 */
export function isSuccessStatus(status) {
  return status === "completed" || status === "completed_ceiling";
}

export function resolveSessionId(cwd, requestedSessionId) {
  if (requestedSessionId && requestedSessionId.trim()) {
    return requestedSessionId.trim();
  }
  const hash = crypto.createHash("md5").update(cwd.toLowerCase()).digest("hex").slice(0, 8);
  // P15: the default session id must be unique per task, not just per cwd.
  // The old `workspace_<hash8(cwd)>` was shared by EVERY instance and EVERY
  // task in the same directory, so (a) a cancel sweep of one instance's task
  // could match and kill ANOTHER instance's live goose child with the same
  // id, and (b) two clients in one directory wrote to the same
  // ~/.qwen/sessions/<id>/events.jsonl (cross-client ledger bleed). The
  // pid + timestamp suffixes make each default id unique while keeping the
  // `workspace_` prefix. Explicit client-passed ids are untouched above.
  return `workspace_${hash}_${process.pid.toString(36)}_${Date.now().toString(36)}`;
}

export function startGooseTask({
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

  const taskEntry = {
    id: taskId,
    sessionId,
    cwd,
    prompt,
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    lastActivityAt: null,
    lastHeartbeatAt: Date.now(),
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

      let finalTaskPrompt = `Your working directory is exactly: ${targetCwd}\n\n`;
      if (evoContext) {
        finalTaskPrompt += `=== Evo Lineage Context ===\n${evoContext}\n\n`;
      }
      if (hypothesis) {
        finalTaskPrompt += `=== Current Hypothesis ===\n${hypothesis}\n\n`;
      }
      finalTaskPrompt += `=== Instruction ===\n${effectivePrompt}\n\n`;
      finalTaskPrompt += `=== Operational & Tooling Directives ===\n`;
      finalTaskPrompt += `- Available File Tools: Use \`write\` to create or overwrite files, \`edit\` to perform targeted text search-and-replace, \`tree\` to view directories, and \`shell\` (bash) to inspect files using \`cat\`, \`head\`, \`grep\`, or other POSIX utilities.\n`;
      finalTaskPrompt += `- Text-Only Engine: You are a pure text model with Universal 245K context. Do NOT call \`read_image\` on binary images (.png, .jpg). Multimodal image inspection is handled exclusively by the Lead Architect.\n`;
      finalTaskPrompt += `- CRITICAL: Do NOT call \`extensionmanager__read_resource\` or \`read_resource\` to read files. It is strictly an internal MCP resource provider and will fail on filesystem paths.\n`;
      finalTaskPrompt += `- Direct Execution: Never merely announce in conversational text that you will write or edit files in a future step. You must directly invoke the file modification tools (\`write\` or \`edit\`) in this turn to write the deliverable to disk.\n`;
      finalTaskPrompt += `- Full Objective Fulfillment: Take as many tool actions and iterations as needed to thoroughly accomplish the task without prematurely truncating your output.\n`;
      if (IS_WINDOWS && !cwdInWsl) {
        finalTaskPrompt += `- Windows Line Endings: Workspace files may use CRLF (\\r\\n). If \`edit\` encounters matching issues, inspect exact line endings with \`head\` or write the normalized file.\n`;
      }
      if (targetInWsl) {
        finalTaskPrompt += `- Linux Environment: Executing in Linux/WSL (bash). Use standard Linux commands and POSIX paths. Windows-drive workspaces live under /mnt/<drive>/.\n`;
      } else {
        finalTaskPrompt += `- Shell execution: If executing PowerShell commands via shell, use \`powershell -NoProfile -Command "..."\` or native utilities directly.\n`;
      }

      // Primary Engine: Anser (microkernel + sandboxed services) - hard-wired, no engine selection.
      taskEntry.startedAt = Date.now();
      taskEntry.status = "running";
      saveTaskToDisk(taskEntry);

      const runner = new AnserRunner({ cwd: targetCwd });
      const abortController = new AbortController();
      taskEntry.abortController = abortController;

      const maxTurnsVal = MAX_TURNS || 100;
      try {
        const runResult = await runner.run({
          prompt: finalTaskPrompt,
          cwd: targetCwd,
          sessionId,
          maxTurns: maxTurnsVal,
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
        taskEntry.result = {
          isError: !isSuccess,
          text: runResult.finalText,
          toolCalls: taskEntry.toolCallsCount,
          fileOps: taskEntry.fileOps,
          durationMs: runResult.durationMs,
        };
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
        saveTaskToDisk(taskEntry);
        notifyWaiters(taskEntry);
        return taskEntry.result;
      }
    },
    taskEntry,
    (entry) => {
      saveTaskToDisk(entry);
    }
  );

  return { taskId, taskEntry, executionPromise, totalTimeoutMs };
}
