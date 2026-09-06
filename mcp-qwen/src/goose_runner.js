import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  IS_WINDOWS,
  STREAM_PROXY_PORT,
  DEFAULT_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  EXTENSION_BONUS_TIMEOUT_MS,
  INACTIVITY_TIMEOUT_MS,
  FIRST_TOKEN_TIMEOUT_MS,
  TASK_DIR,
  MAX_TURNS,
  QWEN_ENGINE,
} from "./config.js";
import {
  isWslLocation,
  toPosixWslPath,
  toWindowsPath,
  getGooseExecutable,
  killProcessTree,
  canonicalizePath,
} from "./wsl_bridge.js";
import { buildSpawnProfile, wslHome } from "./platform.js";
import {
  ensureServerRunning,
  ensureStreamProxyRunning,
  withBootMutex,
  readEngineMetrics,
} from "./server_lifecycle.js";
import { runQueued } from "./semaphore.js";
import {
  tasks,
  saveTaskToDisk,
  readTaskFromDisk,
  notifyWaiters,
} from "./task_registry.js";
import { AvoLineageEngine } from "./avo_engine.js";
import { DeepSeekAvoRunner } from "./harness/runner.js";
import { injectSkills } from "./skills.js";

const execFileAsync = promisify(execFile);

export function extractToolEvents(lines) {
  const contentItems = [];
  for (const line of lines) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const content = obj?.message?.content;
    if (Array.isArray(content)) contentItems.push(...content);
  }
  const toolCalls = contentItems.filter((c) => c.type === "toolRequest");
  const toolResponses = contentItems.filter((c) => c.type === "toolResponse");
  const errors = toolResponses.filter((r) => r.toolResult?.value?.isError);
  const fileOps = toolCalls
    .filter((c) => ["write", "edit", "str_replace", "patch"].includes(c.toolCall?.value?.name))
    .map((c) => `${c.toolCall.value.name}:${c.toolCall.value.arguments?.path ?? "?"}`);
  const finalText = contentItems
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("")
    .trim();
  return { toolCalls, errors, fileOps, finalText };
}

const CORRUPTION_BENIGN_CHARS = new Set([" ", "\n", "\t", "\r", "-", "=", "`", "~", "_", "#"]);

export function detectCorruption(text) {
  if (!text || text.length < 32) return null;
  const findings = [];
  let run = 1;
  for (let i = 1; i < text.length; i++) {
    if (text[i] === text[i - 1]) {
      run++;
      if (run >= 5 && !CORRUPTION_BENIGN_CHARS.has(text[i])) {
        findings.push(`character burst: ${JSON.stringify(text[i].repeat(5))}`);
        break;
      }
    } else {
      run = 1;
    }
  }
  const sample = text.slice(0, 20_000);
  for (let i = 0; i + 40 <= sample.length; i += 20) {
    const block = sample.slice(i, i + 40);
    if (sample.split(block).length - 1 >= 3) {
      findings.push(`40-char block repeated 3+ times: ${JSON.stringify(block.slice(0, 30))}...`);
      break;
    }
  }
  return findings.length ? findings.join("; ") : null;
}

export function summarizeGooseRun(
  lines,
  { timedOut, timeoutReason = "", timeoutMs = DEFAULT_TIMEOUT_MS, stderr = "" } = {}
) {
  const { toolCalls, errors, fileOps, finalText } = extractToolEvents(lines);
  const parts = [];

  if (timedOut) {
    parts.push(
      timeoutReason ||
        `Qwen did NOT finish within the ${Math.round(timeoutMs / 1000)}s time budget - reporting what was confirmed before the cutoff.`
    );
  } else {
    parts.push(
      `Qwen finished. ${toolCalls.length} tool call(s) (${fileOps.length} file write/edit), ${errors.length} tool error(s).`
    );
  }

  if (fileOps.length > 0) {
    const unique = [...new Set(fileOps)];
    parts.push(`Files touched:\n${unique.map((f) => `  - ${f}`).join("\n")}`);
  }

  if (finalText) {
    parts.push(
      timedOut
        ? `Last partial message from Qwen:\n${finalText}`
        : `Final message from Qwen:\n${finalText}`
    );
  }

  const corruption = detectCorruption(finalText);
  if (corruption) {
    parts.push(
      `> [!WARNING]\n` +
        `> Output corruption watchdog triggered: ${corruption}. This matches the known garbled-output\n` +
        `> signature (see NOTES.md "Serving-stack corruption incident") - treat the text above with suspicion\n` +
        `> and re-dispatch if it reads as garbage. File operations may still be valid.`
    );
  }

  if (errors.length > 0) {
    parts.push(
      `Tool errors encountered during run:\n` +
        errors
          .map((e) => {
            const name = e.toolResult?.name ?? "unknown";
            const msg =
              typeof e.toolResult?.value === "string"
                ? e.toolResult.value
                : JSON.stringify(e.toolResult?.value ?? "");
            return `  - ${name}: ${msg.slice(0, 300)}`;
          })
          .join("\n")
    );
  }

  if (stderr.trim()) {
    parts.push(`Goose stderr tail:\n${stderr.trim().slice(-1000)}`);
  }

  const degenerate = !timedOut && toolCalls.length === 0 && !finalText;
  if (degenerate) {
    parts.push(
      `Degenerate run: goose exited without producing any tool calls or output text. ` +
        `The model likely failed on a malformed command (check the stderr tail below) or the engine returned nothing. Re-dispatch recommended.`
    );
  }

  const streamErrorPattern =
    /Stream decode error|error decoding response body|Network error:\s*Stream decode error|\[vLLM (?:Error|Connection Error|Upstream Connection Error|Upstream Stream Interrupted|Mid-Stream Warning):|\[StreamProxy Guard:/i;
  const isStreamError =
    (finalText && streamErrorPattern.test(finalText)) ||
    (stderr && streamErrorPattern.test(stderr));
  if (isStreamError) {
    parts.push(
      `> [!CAUTION]\n` +
        `> **Stream decode / transport error encountered** during Goose execution.\n` +
        `> The local universal streaming proxy will handle future token streams, but this session context should be rolled to a fresh session_id (e.g. \`<session>_stage2\`) if retrying.`
    );
  }

  const isError =
    isStreamError || degenerate || errors.length > 0 || (timedOut && fileOps.length === 0);
  return { isError, text: parts.join("\n\n"), toolCalls, errors, fileOps, finalText };
}

export async function sessionExistsOnDisk(sessionId, targetInWsl = false) {
  if (!sessionId) return false;
  try {
    let stdout = "";
    if (targetInWsl && IS_WINDOWS) {
      const profile = buildSpawnProfile({
        command: `${wslHome()}/.local/bin/goose`,
        args: ["session", "list"],
        mode: "wsl",
        useCd: false,
      });
      const res = await execFileAsync(profile.command, profile.args, {
        ...profile.options,
        timeout: 10000,
      });
      stdout = res.stdout;
    } else {
      const profile = buildSpawnProfile({
        command: getGooseExecutable(),
        args: ["session", "list"],
        mode: "windows",
      });
      const res = await execFileAsync(profile.command, profile.args, {
        ...profile.options,
        timeout: 10000,
      });
      stdout = res.stdout;
    }
    const lines = stdout.split("\n");
    for (const line of lines) {
      const parts = line.split(" - ");
      if (parts.length >= 2) {
        const id = parts[0].trim();
        const name = parts[1].trim();
        if (id === sessionId || name === sessionId) {
          return true;
        }
      }
    }
    return false;
  } catch {
    return false;
  }
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
  system,
  timeoutMs,
  hypothesis,
  testCommand,
  metricName,
  higherIsBetter,
  engine = QWEN_ENGINE,
}) {
  // P4i: canonicalize the task cwd ONCE at the spawn boundary, through the OS
  // symlink/junction resolution layer. This is the single point where the
  // working directory is persisted to the task entry and handed to every
  // downstream spawn (DeepSeekAvoRunner, legacy goose, the AVO test command).
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
    engine,
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
      let avoContext = null;
      if (testCommand) {
        try {
          lineageEngine = new AvoLineageEngine(cwd);
          avoContext = await lineageEngine.getLineageContext();
        } catch {}
      }

      const cwdInWsl = isWslLocation(cwd);
      const targetInWsl = cwdInWsl || (IS_WINDOWS && process.env.QWEN_FORCE_WSL !== "0");
      const targetCwd = targetInWsl ? toPosixWslPath(cwd) : toWindowsPath(cwd);

      // P9: keyword auto-inject matching skills from the packaged skills/
      // library into the instruction block. Additive and budget-capped; when
      // nothing matches the prompt is returned unchanged. Never throws.
      const effectivePrompt = injectSkills(prompt, targetCwd);

      let finalTaskPrompt = `Your working directory is exactly: ${targetCwd}\n\n`;
      if (avoContext) {
        finalTaskPrompt += `=== NVIDIA AVO Lineage Context ===\n${avoContext}\n\n`;
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

      // Primary Engine: DeepSeek AVO (Cordis Microkernel + Sandboxed Services)
      if (engine === "deepseek_avo") {
        taskEntry.startedAt = Date.now();
        taskEntry.status = "running";
        saveTaskToDisk(taskEntry);

        const runner = new DeepSeekAvoRunner({ cwd: targetCwd });
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

          taskEntry.done = true;
          taskEntry.finishedAt = Date.now();
          taskEntry.status = runResult.status === "completed" ? "completed" : runResult.status;
          taskEntry.isError = runResult.status === "error";
          taskEntry.result = {
            isError: runResult.status === "error",
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
            text: `DeepSeek AVO runner error: ${err.message}`,
            toolCalls: taskEntry.toolCallsCount,
            fileOps: taskEntry.fileOps,
          };
          saveTaskToDisk(taskEntry);
          notifyWaiters(taskEntry);
          return taskEntry.result;
        }
      }

      // Fallback Engine: Legacy Goose CLI Wrapper
      return new Promise(async (resolve) => {
        let lastActivityAt = Date.now();
        const lines = taskEntry.lines;
        let stdout = "";
        let stderr = "";

        const args = ["run"];
        if (sessionId) {
          const exists = await sessionExistsOnDisk(sessionId, targetInWsl);
          if (exists) {
            args.push("--name", sessionId, "--resume");
          } else {
            args.push("--name", sessionId);
          }
        } else {
          args.push("--no-session");
        }
        if (MAX_TURNS) {
          args.push("--max-turns", String(MAX_TURNS));
        }
        args.push("--output-format", "stream-json");
        if (system) {
          args.push("--system", system);
        }
        args.push("-t", finalTaskPrompt);
        for (const rawExt of extensions ?? []) {
          let ext = rawExt;
          if (targetInWsl) {
            ext = ext.replace(/^npx\.cmd\b/, "npx").replace(/^uvx\.exe\b/, "uvx");
            if (ext.includes("context7@latest") && !ext.includes("@upstash/context7-mcp")) {
              ext = ext.replace("context7@latest", "@upstash/context7-mcp");
            }
          }
          args.push("--with-extension", ext);
        }

        let child;
        if (targetInWsl) {
          if (IS_WINDOWS) {
            const profile = buildSpawnProfile({
              command: "/usr/bin/env",
              args: [
                `PATH=${wslHome()}/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
                `${wslHome()}/.local/bin/goose`,
                ...args,
              ],
              cwd: targetCwd,
              mode: "wsl",
              env: {
                GOOSE_PROVIDER: "openai",
                GOOSE_MODEL: "qwen3.8-27b",
                OPENAI_BASE_URL: `http://localhost:${STREAM_PROXY_PORT}/v1`,
                OPENAI_API_KEY: "dummy",
                OPENAI_TIMEOUT: "3600",
                GOOSE_STREAM_TIMEOUT: "3600",
                PYTHONIOENCODING: "utf-8",
                PYTHONUTF8: "1",
                LANG: "C.UTF-8",
                LC_ALL: "C.UTF-8",
                GOOSE_WORKING_DIR: targetCwd,
                WSLENV:
                  "GOOSE_PROVIDER/u:GOOSE_MODEL/u:OPENAI_BASE_URL/u:OPENAI_API_KEY/u:OPENAI_TIMEOUT/u:GOOSE_STREAM_TIMEOUT/u:PYTHONIOENCODING/u:PYTHONUTF8/u:LANG/u:LC_ALL/u:GOOSE_WORKING_DIR/u",
              },
            });
            child = spawn(profile.command, profile.args, profile.options);
          } else {
            const profile = buildSpawnProfile({
              command: getGooseExecutable(),
              args,
              cwd: targetCwd,
              mode: "windows",
              detached: true,
              env: {
                GOOSE_PROVIDER: "openai",
                GOOSE_MODEL: "qwen3.8-27b",
                OPENAI_BASE_URL: `http://localhost:${STREAM_PROXY_PORT}/v1`,
                OPENAI_API_KEY: "dummy",
                OPENAI_TIMEOUT: "3600",
                GOOSE_STREAM_TIMEOUT: "3600",
                PYTHONIOENCODING: "utf-8",
                PYTHONUTF8: "1",
                LANG: "C.UTF-8",
                LC_ALL: "C.UTF-8",
                GOOSE_WORKING_DIR: targetCwd,
              },
            });
            child = spawn(profile.command, profile.args, profile.options);
          }
        } else {
          const profile = buildSpawnProfile({
            command: getGooseExecutable(),
            args,
            cwd: targetCwd,
            mode: "windows",
            detached: !IS_WINDOWS,
            env: {
              GOOSE_WORKING_DIR: targetCwd,
              GOOSE_PROVIDER: "openai",
              GOOSE_MODEL: "qwen3.8-27b",
              OPENAI_BASE_URL: `http://localhost:${STREAM_PROXY_PORT}/v1`,
              OPENAI_API_KEY: "dummy",
              PYTHONIOENCODING: "utf-8",
              PYTHONUTF8: "1",
              LANG: "C.UTF-8",
              LC_ALL: "C.UTF-8",
            },
          });
          child = spawn(profile.command, profile.args, profile.options);
        }

        taskEntry.child = child;

        let receivedAnyOutput = false;
        let lineBuf = "";
        let lastSaveAt = Date.now();
        child.stdout.on("data", (chunk) => {
          lastActivityAt = Date.now();
          taskEntry.lastActivityAt = lastActivityAt;
          taskEntry.lastHeartbeatAt = lastActivityAt;
          taskEntry.streamBytes = (taskEntry.streamBytes || 0) + chunk.length;
          const chunkStr = chunk.toString("utf8");
          stdout += chunkStr;
          taskEntry.streamTail = ((taskEntry.streamTail || "") + chunkStr).slice(-2000);
          receivedAnyOutput = true;
          lineBuf += chunkStr;
          const chunkLines = lineBuf.split("\n");
          lineBuf = chunkLines.pop() ?? "";
          for (const l of chunkLines) {
            if (l.trim()) {
              lines.push(l);
              try {
                const obj = JSON.parse(l);
                const content = obj?.message?.content;
                if (Array.isArray(content)) {
                  for (const c of content) {
                    if (c.type === "toolRequest") {
                      taskEntry.toolCallsCount++;
                      const name = c.toolCall?.value?.name;
                      if (["write", "edit", "str_replace", "patch"].includes(name)) {
                        taskEntry.fileOps.push(`${name}:${c.toolCall.value.arguments?.path ?? "?"}`);
                      }
                    }
                  }
                }
              } catch {}
            }
          }
          if (Date.now() - lastSaveAt > 2000) {
            lastSaveAt = Date.now();
            saveTaskToDisk(taskEntry);
          }
        });

        child.stderr.on("data", (chunk) => {
          lastActivityAt = Date.now();
          taskEntry.lastActivityAt = lastActivityAt;
          receivedAnyOutput = true;
          stderr += chunk.toString("utf8");
          if (stderr.length > 50_000) {
            stderr = stderr.slice(-50_000);
          }
        });

        let settled = false;
        const finish = async (timedOut, timeoutReason = "") => {
          if (settled) return;
          settled = true;
          if (lineBuf.trim()) lines.push(lineBuf.trim());
          const summary = summarizeGooseRun(lines, {
            timedOut,
            timeoutReason,
            timeoutMs: totalTimeoutMs,
            stderr,
          });

          if (testCommand && lineageEngine) {
            try {
              let shellCmd;
              let execOptions = { timeout: 300_000 };
              if (targetInWsl) {
                if (IS_WINDOWS) {
                  const profile = buildSpawnProfile({
                    command: "/usr/bin/env",
                    args: [
                      `PATH=${wslHome()}/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
                      "/bin/bash",
                      "-c",
                      testCommand,
                    ],
                    cwd: targetCwd,
                    mode: "wsl",
                  });
                  shellCmd = { bin: profile.command, args: profile.args };
                } else {
                  const profile = buildSpawnProfile({
                    command: "bash",
                    args: ["-c", testCommand],
                    cwd: targetCwd,
                    mode: "windows",
                  });
                  shellCmd = { bin: profile.command, args: profile.args };
                  execOptions.cwd = profile.options.cwd;
                }
              } else {
                const profile = buildSpawnProfile({
                  command: IS_WINDOWS ? "powershell.exe" : "bash",
                  args: IS_WINDOWS
                    ? ["-NoProfile", "-Command", testCommand]
                    : ["-c", testCommand],
                  cwd: toWindowsPath(cwd),
                  mode: "windows",
                });
                shellCmd = { bin: profile.command, args: profile.args };
                execOptions.cwd = profile.options.cwd;
              }

              let testOut = "";
              let testErr = "";
              let testExitCode = 0;
              try {
                const r = await execFileAsync(shellCmd.bin, shellCmd.args, execOptions);
                testOut = r.stdout ?? "";
                testErr = r.stderr ?? "";
              } catch (err) {
                testExitCode = typeof err.code === "number" ? err.code : 1;
                testOut = err.stdout ?? "";
                testErr = err.stderr ?? err.message;
              }

              const metricVal = metricName ? lineageEngine.extractMetric(testOut, metricName) : null;
              const rec = await lineageEngine.recordCandidate({
                hypothesis: hypothesis ?? prompt,
                testCommand,
                filesModified: summary.fileOps,
                metricScore: metricVal,
                targetMetricName: metricName ?? "test_execution",
                higherIsBetter: higherIsBetter ?? true,
                stdout: testOut,
                stderr: testErr,
                exitCode: testExitCode,
              });
              summary.text += `\n\n=== NVIDIA AVO Verification ===\nTest Command: \`${testCommand}\`\nCandidate: ${rec.candidateId}\nStatus: ${rec.status}\nMetric: ${metricVal ?? "Executed"}\n${rec.message}`;
            } catch (e) {
              summary.text += `\n\n=== NVIDIA AVO Error ===\nFailed to run test command: ${e.message}`;
            }
          }

          taskEntry.done = true;
          taskEntry.finishedAt = Date.now();
          taskEntry.isError = summary.isError;
          taskEntry.status = summary.isError ? "failed" : "completed";
          summary.partialOutput = stdout;
          taskEntry.result = summary;

          // Emergency Output Preservation: Never lose partial work on timeout or failure
          if (summary.isError && stdout && stdout.trim()) {
            try {
              const dumpPath = path.join(TASK_DIR, `${taskId}.dump.md`);
              fs.writeFileSync(
                dumpPath,
                `# Emergency Task Dump: ${taskId}\n\n` +
                  `- **Session**: \`${sessionId}\`\n` +
                  `- **Elapsed**: ${Math.round((Date.now() - taskEntry.startedAt) / 1000)}s\n` +
                  `- **Status**: ${taskEntry.status}\n` +
                  `- **Reason**: ${timeoutReason || (summary.isError ? summary.text : "Unknown error")}\n\n` +
                  `## Partial Stdout Output\n\n\`\`\`\n${stdout}\n\`\`\`\n\n` +
                  `## Stderr\n\n\`\`\`\n${stderr}\n\`\`\`\n`,
                "utf8"
              );
            } catch {}
          }

          saveTaskToDisk(taskEntry);
          notifyWaiters(taskEntry);
          resolve(summary);
        };

        let lastKnownPromptTokens = -1;
        let lastKnownGenTokens = -1;
        let tokensLastAdvancedAt = Date.now();

        const watchdog = setInterval(async () => {
          if (settled) {
            clearInterval(watchdog);
            return;
          }

          if (taskEntry.done) {
            clearInterval(watchdog);
            killProcessTree(child, sessionId);
            finish(true, `Task cancelled.`);
            return;
          }

          try {
            const onDisk = readTaskFromDisk(taskEntry.id);
            if (onDisk && (onDisk.status === "cancelled" || onDisk.done)) {
              clearInterval(watchdog);
              killProcessTree(child, sessionId);
              taskEntry.done = true;
              taskEntry.status = "cancelled";
              finish(true, `Task cancelled externally.`);
              return;
            }
          } catch {}

          const now = Date.now();
          const inactiveMs = now - lastActivityAt;
          const totalElapsedMs = now - taskEntry.startedAt;

          // 1. Hard Wall-Clock Budget Ceiling
          if (totalElapsedMs >= totalTimeoutMs) {
            clearInterval(watchdog);
            killProcessTree(child, sessionId);
            finish(
              true,
              `Task Wall-Clock Budget Exceeded: Total elapsed time ${Math.round(totalElapsedMs / 1000)}s reached the budget ceiling of ${Math.round(totalTimeoutMs / 1000)}s. Partial output has been saved to disk.`
            );
            return;
          }

          // 2. Degenerate Repetition Loop Circuit Breaker in Stream Output
          if (taskEntry.streamTail) {
            const repeatMatch = taskEntry.streamTail.match(/([^ \t\n\r\-_=*#])\1{34,}/);
            if (repeatMatch) {
              clearInterval(watchdog);
              killProcessTree(child, sessionId);
              finish(
                true,
                `Degenerate Loop Circuit Breaker: Model entered an unrecoverable repetition loop on character "${repeatMatch[1]}" in stream output. Subprocess safely aborted.`
              );
              return;
            }
          }

          // 3. Token-Velocity Aware Inactivity Watchdog
          const timeoutThreshold = !receivedAnyOutput
            ? FIRST_TOKEN_TIMEOUT_MS
            : INACTIVITY_TIMEOUT_MS;
          if (inactiveMs >= timeoutThreshold) {
            let tokenProgress = false;
            try {
              const metrics = await readEngineMetrics(2000);
              if (metrics) {
                const pTokens = metrics["vllm:prompt_tokens_total"] ?? 0;
                const gTokens = metrics["vllm:generation_tokens_total"] ?? 0;
                if (lastKnownPromptTokens < 0) {
                  lastKnownPromptTokens = pTokens;
                  lastKnownGenTokens = gTokens;
                  tokensLastAdvancedAt = now;
                } else if (pTokens > lastKnownPromptTokens || gTokens > lastKnownGenTokens) {
                  tokenProgress = true;
                  lastKnownPromptTokens = pTokens;
                  lastKnownGenTokens = gTokens;
                  tokensLastAdvancedAt = now;
                } else if (
                  (metrics["vllm:num_requests_running"] ?? 0) > 0 ||
                  (metrics["vllm:num_requests_waiting"] ?? 0) > 0
                ) {
                  if (now - tokensLastAdvancedAt < 120_000) {
                    tokenProgress = true;
                  }
                }
              }
            } catch {}

            if (tokenProgress) {
              lastActivityAt = now;
              return;
            }

            // No stdout from Goose AND token velocity is completely stalled -> True wedge/deadlock.
            clearInterval(watchdog);
            killProcessTree(child, sessionId);
            const timeoutReason = !receivedAnyOutput
              ? `First-Token Timeout: Goose produced zero stream output and vLLM token counters remained static for ${Math.round(inactiveMs / 1000)}s after spawn. The engine may be deadlocked or out of memory. Safe to re-dispatch.`
              : `Inactivity Timeout: Goose subprocess and vLLM token velocity were completely stalled for ${Math.round(inactiveMs / 1000)}s. Subprocess safely aborted to preserve GPU resources.`;
            finish(true, timeoutReason);
          }
        }, 5000);

        child.on("close", () => {
          clearInterval(watchdog);
          finish(false);
        });

        child.on("error", (err) => {
          clearInterval(watchdog);
          if (settled) return;
          settled = true;
          const result = { isError: true, text: `Failed to spawn goose (${getGooseExecutable()}): ${err.message}` };
          taskEntry.done = true;
          taskEntry.isError = true;
          taskEntry.status = "failed";
          taskEntry.result = result;
          notifyWaiters(taskEntry);
          resolve(result);
        });
      });
    },
    taskEntry,
    (entry) => {
      saveTaskToDisk(entry);
    }
  );

  return { taskId, taskEntry, executionPromise, totalTimeoutMs };
}
