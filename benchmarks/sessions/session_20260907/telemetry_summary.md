# 13-Hour Autonomous Production Marathon Telemetry (Session Sept 7, 2026)

## 1. Executive Summary

This telemetry log captures an unbroken **13.1-hour autonomous pairing session** between **Claude Code** (Lead Architect running `glm-5.3` and `glm-5.3-flash`) and **local Qwen3.8-27B** (Anser Coworker running via Goose MCP on an RTX 3090 24GB).

The pairing stack drove the complete **6-phase UI overhaul** of an enterprise web application, implementing unified design tokens, dark-mode infrastructure, assistant-ui integration, dashboard bento refactor, tasks view drawer, settings/suggestions refactor, and paying down 10 pre-existing lint errors (dropping from 86 to 76 baseline problems) across commits `d2383c6` $\to$ `9869945`.

---

## 2. Empirical Telemetry Ledger

| Telemetry Dimension | Measurement | Operational Significance |
| :--- | :--- | :--- |
| **Duration** | **13 hours 10 minutes** (continuous) | Unbroken autonomous execution from 09:08 to 22:18 local time |
| **Local Prefill Volume** | **73,317,306 tokens** (~73.3M) | Absorbed large multi-file ASTs and git diffs locally at **$0 cost** |
| **Prefix Cache Hit Rate** | **93.80% (68,842,624 tokens)** | Warm prefix caching sustained ~8,000–9,500 tok/s prefill speeds |
| **Local Generation Volume** | **1,490,578 tokens** (~1.49M) | Full test-time reasoning and code generation delivered at $0 |
| **DFlash2 Speculative Decoding** | **53.45% draft acceptance** | 1,176,978 accepted / 2,202,011 drafted across 7 draft positions |
| **Total vLLM Requests** | **883 requests** | 882 `stop`, 1 `length`, **0 error, 0 abort, 0 repetition** |
| **Orchestrator Token Volume** | **53,081,643 tokens** (~53.1M) | 11.08M input, 341.8K output, 41.66M cache read |
| **Orchestrator Tool Calls** | **245 calls** | 38 Qwen coworker dispatches, 38 zero-turn curl waits, 21 PowerShell |
| **MCP Process Stability (PID 16912)** | **80.59 MB RSS, 0 crashes** | Zero memory growth or socket leaks over 13 hours continuous uptime |
| **Hardware VRAM Footprint** | **24,199 MiB / 24,576 MiB** | Universal 245K context + KVarN k4v2 cache on single RTX 3090 |
| **Thermals & Power** | **47°C, 30% Fan, 35W** (idle) | Peak under 250W power cap without thermal throttling |
| **Zero-Turn Wait Savings** | **~650M tokens saved** | 38 background blocking curl tasks eliminated supervisor polling tax |
| **Shipped Production Deliverables** | **6 UI Overhaul Phases** | Commits `d2383c6` $\to$ `9869945`, paying down 10 lint errors (76 baseline) |

---

## 3. Investigated MCP & vLLM Operational Friction Modes (Detailed Incident Audit)

Detailed audit of the Claude Code transcripts reveals the specific failure and friction modes encountered across the 13-hour production marathon:

### 1. `engine_empty_response` Stream Cutoff (Transcript Line 310, `06:19:55 UTC`)
- **Transcript Record**:
  > *`engine_empty_response` — the review's final message was lost (known infra flakiness: long final responses hit the stream limit). The session context holds 32 tool calls of analysis, so I'm resuming the same session with a short "emit your verdict" turn:*
- **Operational Symptom**: During the Phase 0 review dispatch (`task_ui_ovh_review_p0`), the review's final answer turn terminated with `engine_empty_response`. The orchestrator observed that while 32 tool calls of analysis were completed inside the session context, the final report was lost.
- **Recovery**: Resumed the existing warm session with a compact directive (*"Your final response was lost to a stream error. Do NOT redo the review... emit ONLY the verdict now"*), successfully retrieving the report in 1 turn.
- **Root Cause & Fix**: Fixed in `runner.js` via empty-turn retry classification and honest status reporting instead of synthetic completions.

### 2. `curl: (56) Recv failure: Connection reset by peer` (Transcript Line 386, `06:53:21 UTC`)
- **Transcript Record**:
  > *curl dropped (exit 56 — known local endpoint flake). Checking the task itself:*
- **Operational Symptom**: While blocking on `http://127.0.0.1:18021/task/<id>/wait`, curl dropped with exit code 56 due to socket resets during concurrent SSE bursts under Windows loopback.
- **Recovery**: Checked task status via `qwen_task status` to verify the task was still alive (5 tool calls in), then re-armed the wait command with `--retry 5 --retry-connrefused --retry-all-errors`.
- **Root Cause & Fix**: Hardened default wait command in `tools.js` to supply retry flags, and eliminated unhandled socket drops in `task_registry.js`.

### 3. Universal 245K Context Ceiling Overflow (Transcript Line 611, `09:46:21 UTC`)
- **Transcript Record**: During Phase 2 Turn 4 (`ui_ovh_p2`), 6 successive turns of reading full 900+ LOC files accumulated until prompt tokens reached the 245,760 context ceiling, triggering context exhaustion.
- **Recovery**: Rolled the session to `ui_ovh_p2_b` per protocol and re-dispatched the cutover mutation turn.
- **Root Cause & Fix**: Codified the micro-session roll cadence (roll after 2-3 focused turns) and added dynamic headroom clamping in `provider_vllm.js`.

### 4. vLLM Stream Idle Timeout & 4 Stalled Wait Intervals (Transcript Lines 1020–1037, `17:11:37 UTC`)
- **Transcript Record**:
  > *The review's final answer died on a vLLM stream idle timeout (known infra flake — 4 stalled attempts). Checking state, then nudging the session to emit what it has:*
  > *Task status payload: `[qwen task] id=task_ui_ovh_review_p5_1788799281847 status=error elapsed_s=1772 isError=true Anser execution error: vLLM stream idle timeout: no meaningful SSE frame for 900000ms`*
- **Operational Symptom**: `task_ui_ovh_review_p5_1788799281847` ran for 1,772 seconds (~29.5 minutes) executing 11 tool calls. Claude Code blocked across 3 consecutive 600-second TaskOutput timeouts (600s + 600s + 600s = 1800s / 30 mins) — the "4 stalled attempts" — until the MCP inactivity watchdog tripped at 900s of silence.
- **Recovery**: Dispatched a compacted prompt (`task_ui_ovh_review_p5_1788801115415`) targeting specific greps rather than full file reads. It completed in 197.9s with 4 tool calls and issued **Verdict: PASS**.
- **Root Cause & Fix**: Monolithic prompt bundling causing quadratic prefill and massive thinking loops. Resolved by prompt-level scoping discipline and `xhigh` reasoning budget management.

### 5. vLLM JSONDecodeError / Malformed Wake Payload (LLM-Ecosystem Lines 1421–1433, `13:15:40 UTC`)
- **Transcript Record**:
  > *The wait woke but the payload is a truncated vLLM JSON error, not a report — suspicious... `completed`, 90 minutes elapsed, `isError=false` — but the stored report payload died in a vLLM serialization glitch, twice. Qwen likely finished the work and only the report is lost. Ground truth is the disk — verifying the amendment's end-state directly:*
- **Operational Symptom**: `vLLM JSONDecodeError: Unterminated string starting at: line 1 column 13`. Stream proxy masked this as `[vLLM Error: ...]` with HTTP 200 and task status `completed` (`isError=false`), delivering a malformed wake payload to the orchestrator.
- **Recovery**: Orchestrator verified disk ground truth directly, confirming all source files had been modified correctly despite the truncated report.
- **Root Cause & Fix**: Enforced Fail-Fast Invariant (Rule 8) across the stream proxy — never convert JSON parser errors into synthetic completions or 200 OK statuses.

### 6. Premature Completion Stream Cutoff (LLM-Ecosystem Line 1465, `14:46:19 UTC`)
- **Transcript Record**:
  > *Pass 2's report came back terse again — "All pass. Now benchmark (needs vLLM engine):" then cut off. Task completed; disk is the referee. Verifying the end-state myself:*
- **Operational Symptom**: Final report generation cut off mid-sentence due to output token ceiling exhaustion after extensive reasoning token consumption.
- **Root Cause & Fix**: Reasoning token accounting decoupled via `QWEN_MAX_REASONING_TOKENS=32768` so reasoning tokens do not consume completion token headroom.

---

## 4. Associated Telemetry Artifacts in this Directory

* [`vllm_engine.log`](vllm_engine.log) — Complete 2.2MB vLLM serving stdout/stderr engine log.
* [`vllm_metrics.prom`](vllm_metrics.prom) — Complete Prometheus metric series dump.
* [`vllm_metrics_parsed.json`](vllm_metrics_parsed.json) — Parsed metric series (883 requests, 73.3M prefill, 1.49M decode).
* [`server_config.json`](server_config.json) — Process cmdline arguments, flags, and environment variables.
* [`vllm_models.json`](vllm_models.json) — Authenticated `/v1/models` endpoint output.
* [`gpu_snapshot.txt`](gpu_snapshot.txt) — GPU power, memory, and temperature profile.

