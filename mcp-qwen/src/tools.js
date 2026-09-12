import { z } from "zod";
import http from "node:http";
import {
  BASE_URL,
  STATUS_PORT,
  MAX_LEN_HUGE,
  RACE_MS,
  IS_WINDOWS,
  MAX_CONCURRENT_GOOSE,
  AUTO_HEAL,
  WEDGE_STATS_SILENCE_S,
  REASONING_EFFORT_TIERS,
  TASK_RETENTION_MS,
} from "./config.js";
import { normalizeWorkspacePath, canonicalizePath, killProcessTree, killGooseSession } from "./wsl_bridge.js";
import {
  serverInfo,
  readEngineMetrics,
  ensureServerRunning,
  stopServer,
  resetEngineHealthCache,
  engineWedgeState,
  healWedgedEngine,
  readWedgeCounter,
  setHealGatekeeper,
} from "./server_lifecycle.js";
import { listGooseSlots, releaseGooseSlot } from "./semaphore.js";
import {
  tasks,
  listTasksFromDisk,
  readTaskFromDisk,
  saveTaskToDisk,
  notifyWaiters,
  cancelAllTasks,
  statusServerOwned,
  hasLiveWork,
} from "./task_registry.js";
import { startGooseTask, resolveSessionId } from "./goose_runner.js";

export function registerTools(server) {
  // Wire the heal backstop: refuse to stop/reboot the engine while live work
  // is in flight. Uses the injection hook so server_lifecycle.js stays free of
  // a hard dependency on task_registry.js (which has import-time side effects).
  setHealGatekeeper(hasLiveWork);

  // Tool 1: qwen_coworker (Primary Hybrid Agent Interface)
  server.registerTool(
    "qwen_coworker",
    {
      title: "Autonomous Senior Coworker (Goose Agent + Universal 245K vLLM)",
      description:
        "Primary autonomous execution coworker for local Qwen3.8-27B via Goose agent harness ($0 local text execution). " +
        "Has full native access to Filesystem, Shell, and Git across Windows and WSL. Pure text-only model with Universal 245K context. " +
        "Executes codebase exploration, refactoring, implementation, diagnostics, live web/docs research, and git operations.\n\n" +
        "ORCHESTRATION RULES:\n" +
        "  - Single Logical Concern: Scope each prompt to ONE cohesive subsystem, architectural layer, or target AST slice. Do not bundle disparate subsystems or cross-cutting concerns into a single dispatch.\n" +
        "  - Full Objective Fulfillment: Do not instruct Qwen to limit its tool calls or artificially restrict its execution. Qwen operates autonomously with full tool depth once dispatched with a focused objective.\n" +
        "  - Session Lifecycle: Use persistent `session_id` across 2-3 focused turns, then roll to a fresh session_id (e.g. '<milestone>_stage2') when context accumulates.\n" +
        "  - Zero-Turn Execution Contract: Tasks completing within ~45s return results synchronously. Long-running tasks yield a `taskId` and a `wait_command`. Execute the `wait_command` immediately in your shell to block at $0 cost and wake on completion. Do not poll manually or execute parallel exploratory tools while waiting.\n" +
        "  - Reasoning Effort: optional `reasoning_effort` param (xhigh | medium | low) tunes per-dispatch thinking depth; omit to use the QWEN_REASONING_EFFORT env default (xhigh).\n\n" +
        "SUPPORTED EXTENSIONS:\n" +
        "  - `uvx free-search-mcp` (Web search, documentation lookup, PDF/DOCX ingestion)\n" +
        "  - `npx -y @upstash/context7-mcp` (Live framework/library documentation)\n" +
        "  - `gh` CLI / `git` (Authenticated GitHub operations and atomic commits)",
      inputSchema: {
        prompt: z
          .string()
          .describe(
            "Task, inquiry, or architectural instruction for Qwen (pure text-only; images must be inspected natively by Lead Architect and summarized into text)"
          ),
        session_id: z
          .string()
          .optional()
          .describe(
            "Named persistent session ID (maintains KV-cache and conversation context across turns)"
          ),
        cwd: z
          .string()
          .optional()
          .describe(
            "Working directory for filesystem and shell tools (defaults to current workspace)"
          ),
        extensions: z
          .array(z.string())
          .optional()
          .describe(
            "Optional stdio extensions (e.g. ['uvx free-search-mcp'], ['npx -y @upstash/context7-mcp'])"
          ),
        hypothesis: z.string().optional().describe("Optional Evo hypothesis being tested"),
        test_command: z
          .string()
          .optional()
          .describe("Optional verification test/benchmark command (e.g. 'pytest tests/test_core.py')"),
        metric_name: z
          .string()
          .optional()
          .describe("Target metric name in benchmark output (e.g. 'throughput', 'accuracy')"),
        higher_is_better: z
          .boolean()
          .optional()
          .describe("Whether higher metric values represent improvement (default true)"),
        timeout_ms: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Task timeout in ms (default 14,400,000ms (4 hours), minimum 600,000ms (10 min) - budgets are floored because a 27B model on consumer silicon routinely needs tens of minutes)"
          ),
        skills: z
          .array(z.string())
          .optional()
          .describe("Explicit list of skill names to inject (bypasses keyword auto-matching)"),
        reasoning_effort: z
          .enum(REASONING_EFFORT_TIERS)
          .optional()
          .describe(
            "Per-dispatch reasoning-effort tier forwarded to the engine chat template (xhigh = maximal deliberation, medium = balanced, low = brief). Omit to use the QWEN_REASONING_EFFORT env default (xhigh). Only the engine's supported tiers are accepted; invalid values are rejected."
          ),
      },
    },
    async ({
      prompt,
      session_id,
      cwd,
      extensions,
      hypothesis,
      test_command,
      metric_name,
      higher_is_better,
      timeout_ms,
      skills,
      reasoning_effort,
    }) => {
      let raceHandle;
      try {
      // P4i: canonicalize the working directory ONCE at the single task-entry
      // point, through the OS symlink/junction resolution layer. This is the
      // provenance fix: if the MCP server process was launched with a
      // junction/symlink cwd (e.g. D:\mnt\d\LLM_Ecosystem\mcp-qwen -> D:\),
      // process.cwd() returns the junction literal, and every downstream
      // service (SandboxFsService, AstService, EvoOperator, the spawned
      // goose/runner) would inherit that literal and produce false
      // SymlinkEscapeError/PathEscapeError. Canonicalizing here - before the
      // cwd is persisted to the task entry, hashed into the session id, and
      // passed to the runner - makes the entire pipeline operate on the real
      // path. A requested real-path cwd is unaffected (realpath is a no-op on
      // a non-junction path), and a genuinely outside cwd is still caught by
      // the per-service containment checks downstream.
      const workingDir = canonicalizePath(normalizeWorkspacePath(cwd ?? process.cwd()));
      const resolvedSession = resolveSessionId(workingDir, session_id);

      const { taskId, taskEntry, executionPromise, totalTimeoutMs } = startGooseTask({
        cwd: workingDir,
        prompt,
        sessionId: resolvedSession,
        extensions,
        timeoutMs: timeout_ms,
        hypothesis,
        testCommand: test_command,
        metricName: metric_name,
        higherIsBetter: higher_is_better,
        skills,
        reasoningEffort: reasoning_effort,
      });

      const raceTimer = new Promise((resolve) => {
        raceHandle = setTimeout(() => resolve({ timedOutOnClientRace: true }), RACE_MS);
      });
      const winner = await Promise.race([executionPromise, raceTimer]);
      clearTimeout(raceHandle);

      if (!winner.timedOutOnClientRace) {
        return {
          content: [{ type: "text", text: winner.text }],
          isError: winner.isError,
        };
      }

      const curlBin = IS_WINDOWS ? "curl.exe" : "curl";
      const waitCmd = `${curlBin} -fsS --retry 5 --retry-delay 2 --retry-connrefused http://127.0.0.1:${STATUS_PORT}/task/${taskId}/wait`;
      const elapsedSec = Math.round(RACE_MS / 1000);
      const responseText = [
        `### Qwen Task Dispatched (Background Execution)`,
        `- **Task ID**: \`${taskId}\``,
        `- **Session**: \`${resolvedSession}\``,
        `- **Working Directory**: \`${workingDir}\``,
        `- **Time Elapsed**: ${elapsedSec}s (Task continuing in background with ${Math.round(totalTimeoutMs / 60000)} min budget)`,
        ``,
        `> [!TIP]`,
        `> **Zero-Turn Reactive Wait**: Execute the wait command via \`run_command\` (Antigravity) or \`Bash\` (Claude Code). It sleeps at $0 token cost and automatically wakes you on completion.`,
        `> For extended background tasks, enforce the telemetry-grounded decaying check-in schedule via bounded wait windows (\`--max-time 3000\` -> \`1800\` -> \`900\` -> \`300\`):`,
        `\`\`\`bash`,
        `${waitCmd}`,
        `\`\`\``,
        `> **Chain Invariant**: When chaining sequential task waits, always use \`&&\` (stop on error), never \`;\`.`,
        ``,
        `Or inspect status via tool: \`qwen_task(action: "status", task_id: "${taskId}")\`.`,
      ];

      return {
        content: [{ type: "text", text: responseText.join("\n") }],
        isError: false,
      };
      } catch (err) {
        // P12: MCP-conformant tool-execution failure - a normal result with
        // isError:true, never a thrown exception or protocol-level error.
        // The original message is preserved verbatim; stack traces are never
        // leaked into content.
        return {
          content: [{ type: "text", text: `qwen_coworker: ${err && err.message ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );

  // Tool 2: qwen_task (Unified Background Task Management)
  server.registerTool(
    "qwen_task",
    {
      title: "Manage Background Qwen Tasks",
      description: "Check status, retrieve output, cancel, or list background Qwen coworker tasks.",
      inputSchema: {
        action: z
          .enum(["status", "cancel", "cancel_all", "list"])
          .describe("Action to perform on background tasks"),
        task_id: z
          .string()
          .optional()
          .describe(
            "Task ID (required for 'status', optional for 'cancel'/'cancel_all' to cancel all tasks)"
          ),
      },
    },
    async ({ action, task_id }) => {
      try {
      if (action === "list") {
        const merged = new Map();
        for (const dt of listTasksFromDisk()) {
          merged.set(dt.id, {
            id: dt.id,
            sessionId: dt.sessionId,
            status: dt.status,
            elapsed_s: Math.round(((dt.finishedAt || Date.now()) - dt.createdAt) / 1000),
            done: dt.done,
            isError: dt.isError,
          });
        }
        for (const t of tasks.values()) {
          merged.set(t.id, {
            id: t.id,
            sessionId: t.sessionId,
            status: t.status,
            elapsed_s: Math.round(((t.finishedAt || Date.now()) - t.createdAt) / 1000),
            done: t.done,
            isError: t.isError,
          });
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ tasks: Array.from(merged.values()) }, null, 2),
            },
          ],
        };
      }

      if (
        action === "cancel_all" ||
        (action === "cancel" && (!task_id || task_id.toLowerCase() === "all"))
      ) {
        const count = await cancelAllTasks("cancelled by caller");
        return {
          content: [
            {
              type: "text",
              text: `Cancelled ${count} active/queued task(s), killed all Goose processes, and cleared slot leases.`,
            },
          ],
        };
      }

      if (!task_id) {
        return {
          content: [
            {
              type: "text",
              text: `Error: \`task_id\` parameter is required for action: '${action}'.`,
            },
          ],
          isError: true,
        };
      }

      let task = tasks.get(task_id) || readTaskFromDisk(task_id);
      if (task && task.corrupted) {
        // D11 (FX6): a corrupt task file is an explicit corruption signal,
        // never conflated with a clean not-found. Surface the file and the
        // parse error verbatim (the file has already been quarantined).
        return {
          content: [
            {
              type: "text",
              text: `Task \`${task_id}\` file is CORRUPT (quarantined to ${task.file}): ${task.error}`,
            },
          ],
          isError: true,
        };
      }
      if (!task) {
        return {
          content: [
            {
              type: "text",
              text: `Task \`${task_id}\` not found in memory or disk (retention is ${Math.round(TASK_RETENTION_MS / 3_600_000)}h).`,
            },
          ],
          isError: true,
        };
      }

      if (action === "status") {
        // FX3-A (F2): compute elapsed seconds ONCE before the branch dispatch.
        // The DONE branch previously used a camelCase `elapsedS` while the
        // QUEUED/EXECUTING branches referenced an undeclared snake_case
        // `elapsed_s` -> ReferenceError for any non-done task. A not-done task
        // has finishedAt=null, so this resolves to now - (startedAt ||
        // createdAt): queued -> now - createdAt (time waiting), executing ->
        // now - startedAt (time running). The DONE branch keeps the identical
        // formula and value.
        const elapsedS = Math.round(
          ((task.finishedAt || Date.now()) - (task.startedAt || task.createdAt)) / 1000
        );
        if (task.done) {
          const header = `[qwen task] id=${task.id} status=${task.status} elapsed_s=${elapsedS} isError=${task.isError}`;
          return {
            content: [{ type: "text", text: `${header}\n${task.result?.text || "Task completed."}` }],
            isError: task.isError,
          };
        }
        const curlBin = IS_WINDOWS ? "curl.exe" : "curl";
        const hint = `\n\nWait command (blocks at $0 until done):\n\`${curlBin} -fS --retry 5 --retry-delay 2 --retry-connrefused http://127.0.0.1:${STATUS_PORT}/task/${task_id}/wait\``;
        if (task.status === "queued") {
          const holders = listGooseSlots().map((l) => l.taskId ?? `pid ${l.pid}`);
          const heldBy = holders.length ? ` Currently held by: ${holders.join(", ")}.` : "";
          return {
            content: [
              {
                type: "text",
                text: `Task \`${task_id}\` is QUEUED for a global goose slot (${elapsedS}s waiting; MAX_CONCURRENT_GOOSE=${MAX_CONCURRENT_GOOSE} machine-wide).${heldBy}${hint}`,
              },
            ],
            isError: false,
          };
        }
        return {
          content: [
            {
              type: "text",
              text: `Task \`${task_id}\` is actively EXECUTING (${elapsedS}s elapsed, ${task.toolCallsCount || 0} tool calls made).${hint}`,
            },
          ],
          isError: false,
        };
      }

      if (action === "cancel") {
        const memTask = tasks.get(task_id);
        if (memTask && !memTask.done) {
          killProcessTree(memTask.child, memTask.sessionId);
          // P10: trigger the native runner's abort signal. For a
          // native task `memTask.child` is null (no goose subprocess),
          // so killProcessTree is a no-op and the ONLY way to stop the
          // in-flight LLM call is the abort signal. Aborting it makes the
          // provider's fetch reject, which lands in the runner's catch and
          // then its finally block - which disposes the MCP extension bridge
          // (no leaked children). Without this, cancel would mark the task
          // done but the runner (and its bridge children) would keep running
          // until the LLM call completed naturally.
          if (memTask.abortController) {
            try {
              memTask.abortController.abort();
            } catch {}
          }
          // FX5-A (D6): release the goose slot immediately. For a wedged
          // task the runner's finally never fires (the fn never returns), so
          // the slot must be freed here. releaseGooseSlot is idempotent — a
          // cancel landing after natural completion is a no-op.
          if (memTask.slot) {
            releaseGooseSlot(memTask.slot);
            memTask.slot = null;
          }
          memTask.status = "cancelled";
          memTask.done = true;
          memTask.isError = true;
          memTask.result = { isError: true, text: `Task ${task_id} was cancelled by caller.` };
          saveTaskToDisk(memTask);
          notifyWaiters(memTask);
          return {
            content: [{ type: "text", text: `Task \`${task_id}\` cancelled and process tree killed.` }],
          };
        }

        // Delegate cancellation to the status coordinator process if not owned locally
        try {
          const httpCancel = await new Promise((resolve) => {
            const postReq = http.request(
              {
                hostname: "127.0.0.1",
                port: STATUS_PORT,
                path: `/task/${encodeURIComponent(task_id)}/cancel`,
                method: "POST",
                timeout: 4000,
              },
              (res) => {
                let data = "";
                res.on("data", (chunk) => (data += chunk));
                res.on("end", () => {
                  try {
                    resolve(JSON.parse(data));
                  } catch {
                    resolve(null);
                  }
                });
              }
            );
            postReq.on("error", () => resolve(null));
            postReq.on("timeout", () => {
              postReq.destroy();
              resolve(null);
            });
            postReq.end();
          });
          if (httpCancel?.cancelled) {
            return {
              content: [
                { type: "text", text: `Task \`${task_id}\` cancelled via status coordinator.` },
              ],
            };
          }
        } catch {}

        const diskTask = readTaskFromDisk(task_id);
        if (diskTask && diskTask.corrupted) {
          // D11 (FX6): a corrupt task file is an explicit corruption signal.
          // There is no live task to cancel (the file is already quarantined);
          // surface the file and the parse error rather than a fabricated
          // "already finished".
          return {
            content: [
              {
                type: "text",
                text: `Task \`${task_id}\` file is CORRUPT (quarantined to ${diskTask.file}): ${diskTask.error}`,
              },
            ],
            isError: true,
          };
        }
        if (diskTask && !diskTask.done) {
          if (diskTask.sessionId) {
            // P15: anchored sweep (pgrep -> /proc cmdline boundary verify ->
            // kill) instead of a raw unanchored `pkill -9 -f` - a session id
            // that is a substring of another session's id must never be
            // over-killed, and the hardcoded `-d "Ubuntu"` wsl.exe call is
            // gone with the switch.
            try {
              await killGooseSession(diskTask.sessionId);
            } catch {}
          }
          diskTask.status = "cancelled";
          diskTask.done = true;
          diskTask.isError = true;
          diskTask.result = { isError: true, text: `Task ${task_id} was cancelled by caller.` };
          saveTaskToDisk(diskTask);
          return {
            content: [{ type: "text", text: `Task \`${task_id}\` marked as cancelled.` }],
          };
        }
        return {
          content: [{ type: "text", text: `Task \`${task_id}\` was already finished.` }],
        };
      }
      } catch (err) {
        // P12: MCP-conformant tool-execution failure - a normal result with
        // isError:true, never a thrown exception or protocol-level error.
        // The original message is preserved verbatim; stack traces are never
        // leaked into content.
        return {
          content: [{ type: "text", text: `qwen_task: ${err && err.message ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );

  // Tool 3: qwen_server (Unified Server Lifecycle)
  server.registerTool(
    "qwen_server",
    {
      title: "Manage Local Qwen3.8-27B vLLM Instance Lifecycle",
      description:
        "Check status, start, or stop the universal 245K context vLLM server in WSL Ubuntu. Status includes live engine gauges from /metrics (running/waiting requests, KV cache %, prefix-cache hit ratio, spec-decode acceptance) and an end-to-end canary completion - the port answering is NOT proof of health. Note: during active task execution, canary latency will be higher due to GPU batch contention; this is normal under load and is NOT a wedge. Only stop the server if the engine is idle or if the human user explicitly commands it.",
      inputSchema: {
        action: z.enum(["status", "start", "stop"]).describe("Lifecycle action to perform"),
        force: z
          .boolean()
          .optional()
          .describe(
            "Force stop even if a task is actively executing. ONLY permitted if the human USER explicitly requested stopping/rebooting the server or cancelling all tasks. Prohibited for autonomous agent decisions."
          ),
      },
    },
    async ({ action, force }) => {
      try {
      if (action === "status") {
        const info = await serverInfo();
        const running = !!info;
        const wedge = running ? await engineWedgeState() : { wedged: false, stats: null };
        let autoHeal = null;
        if (running && wedge.wedged && AUTO_HEAL) {
          try {
            autoHeal = await healWedgedEngine(wedge.stats?.ageSec ?? null);
          } catch (err) {
            autoHeal = { healed: false, error: err.message };
          }
        }
        const statusLabel = !running
          ? "stopped"
          : wedge.wedged
          ? autoHeal?.healed
            ? "wedged_restarted"
            : "wedged"
          : "running";
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: statusLabel,
                  endpoint: BASE_URL,
                  max_model_len: running ? info.maxModelLen : null,
                  context_window_nominal: MAX_LEN_HUGE,
                  stack: "vLLM + DFlash2 + KVarN (Universal 245K)",
                  engine: running
                    ? {
                        running_requests: wedge.gauges?.running_requests ?? null,
                        waiting_requests: wedge.gauges?.waiting_requests ?? null,
                        kv_cache_pct: wedge.gauges?.kv_cache_pct ?? null,
                        prefix_cache_hit_ratio: wedge.gauges?.prefix_cache_hit_ratio ?? null,
                        spec_decode_acceptance: wedge.gauges?.spec_decode_acceptance ?? null,
                        // BUSY-GATE: when the engine is busy (MAX_SEQS=1), the canary
                        // is intentionally NOT fired (it would queue behind the active
                        // generation and time out, measuring queue depth not health).
                        // Surface that honestly; wedge is then derived from stats
                        // silence only.
                        engine_busy: wedge.engineBusy ?? null,
                        canary_skipped: wedge.canary?.skipped ?? null,
                        canary: wedge.canary,
                        engine_stats_age_seconds: wedge.stats?.ageSec ?? null,
                        wedge_detected: wedge.wedged,
                        wedge_threshold_seconds: WEDGE_STATS_SILENCE_S,
                        auto_heal: autoHeal,
                      }
                    : null,
                  status_endpoint: `http://127.0.0.1:${STATUS_PORT}`,
                  status_endpoint_owned_by_this_instance: statusServerOwned,
                  wedge_counter: readWedgeCounter(),
                },
                null,
                2
              ),
            },
          ],
        };
      }
      if (action === "start") {
        const res = await ensureServerRunning();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { status: "running", result: res.status, endpoint: BASE_URL, context: MAX_LEN_HUGE },
                null,
                2
              ),
            },
          ],
        };
      }
      if (action === "stop") {
        const activeTasks = listTasksFromDisk().filter((t) => !t.done && t.status === "executing");
        if (activeTasks.length > 0 && !force) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    status: "rejected",
                    error: `Refusing to stop vLLM server: task '${activeTasks[0].id}' is actively executing.`,
                    guidance:
                      "To cancel the active task without rebooting vLLM, call qwen_task(action: 'cancel', task_id: '" +
                      activeTasks[0].id +
                      "'). Only pass force: true to stop the server if the human USER explicitly commanded stopping the server or cancelling all tasks.",
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }
        await cancelAllTasks("server stopped by user");
        // FX5-B (D7): report the HONEST stop result. stopServer() now returns
        // {stopped:false, reason:"engine_still_responding"} when the engine
        // survives the grace window, so we surface that instead of fabricating
        // a "stopped" success.
        const stopRes = await stopServer();
        resetEngineHealthCache();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                stopRes.stopped
                  ? {
                      status: "stopped",
                      message: "vLLM server stopped and all active/queued tasks cancelled.",
                      forced: !!force,
                    }
                  : {
                      status: "stop_failed",
                      message:
                        "All active/queued tasks were cancelled, but the vLLM engine is still responding after the stop grace window.",
                      reason: stopRes.reason,
                      forced: !!force,
                    },
                null,
                2
              ),
            },
          ],
          isError: !stopRes.stopped,
        };
      }
      } catch (err) {
        // P12: MCP-conformant tool-execution failure - a normal result with
        // isError:true, never a thrown exception or protocol-level error.
        // The original message is preserved verbatim; stack traces are never
        // leaked into content.
        return {
          content: [{ type: "text", text: `qwen_server: ${err && err.message ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );
}
