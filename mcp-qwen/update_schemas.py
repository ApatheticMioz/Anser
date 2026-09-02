import json, os, glob

mcp_dir = r'C:\Users\Apath\.gemini\antigravity-ide\mcp\qwen38-local'

# Clean old schemas
for f in glob.glob(os.path.join(mcp_dir, '*.json')):
    try:
        os.remove(f)
        print(f'Removed old schema {f}')
    except Exception:
        pass

tools = {
    'qwen_coworker': {
        'name': 'qwen_coworker',
        'description': (
            'Primary agentic interface for local Qwen3.8-27B running inside the Goose agent harness for $0. '
            'Has native access to Filesystem, Shell, and Git across Windows and WSL. Pure text-only model with Universal 245K context. '
            'Executes multi-turn Socratic collaboration, codebase exploration, threat modeling, deep research, and AVO candidate mutations. '
            'USAGE - multi-turn chat is the primary mode:\n'
            '  - Open a named `session_id` and drive work iteratively in SHORT turns: "read X and report", "now draft it", '
            '"revise per this feedback". Send corrections and pushback as follow-up turns - do NOT rewrite one '
            'monolithic spec per request. Each follow-up rides the warm prefix cache (~8-9k tok/s prefill).\n'
            '  - Sessions are long-lived (245K ctx): never roll a session for context size; roll only on milestone '
            'change or when session history has poisoned tool habits. BUT checkpoint very long sessions (1h+ of '
            'heavy turns, or KV cache usage sustained >~50% in qwen_server status): have the coworker write a '
            'handoff summary file, then continue in a fresh session_id - giant re-prefills at partial cache hit '
            'are the slowest and most stall-prone mode.\n'
            '  - Budgets are generous by design (default 1h, 10-min floor; pass more for research+write+post). '
            'Split multi-stage jobs so a timeout can never land on the irreversible step (post/commit/deploy): '
            'persist artifacts to disk first, then a short follow-up dispatch executes the critical action.\n'
            'Execution Contract:\n'
            '  - Fast tasks (< 45s): Returns full deliverable directly in Turn 1.\n'
            '  - Long tasks (>= 45s): Safely yields `taskId` and a `wait_command` before client deadlines. '
            'Run `wait_command` via native shell to block and wake up automatically with the result at $0 token cost.\n'
            'Supported Extensions:\n'
            '  - `uvx free-search-mcp` (Deep Web Search, Live Docs, PDF/DOCX Ingestion)\n'
            '  - `npx.cmd -y context7@latest` / `npx -y context7@latest` (Version-Accurate Framework & Library Docs)\n'
            '  - `gh` CLI / `git` (Authenticated GitHub operations and atomic git branch/commit workflows)'
        ),
        'parameters': {
            '$schema': 'http://json-schema.org/draft-07/schema#',
            'type': 'object',
            'properties': {
                'prompt': {'type': 'string', 'description': 'Task, inquiry, or architectural instruction for Qwen'},
                'session_id': {'type': 'string', 'description': 'Named persistent session ID (maintains KV-cache across turns)'},
                'cwd': {'type': 'string', 'description': 'Working directory for filesystem and shell tools'},
                'extensions': {'type': 'array', 'items': {'type': 'string'}, 'description': 'Optional stdio extensions (e.g. uvx free-search-mcp)'},
                'hypothesis': {'type': 'string', 'description': 'Optional NVIDIA AVO hypothesis being tested'},
                'test_command': {'type': 'string', 'description': 'Optional verification test command'},
                'metric_name': {'type': 'string', 'description': 'Target metric name in benchmark output'},
                'higher_is_better': {'type': 'boolean', 'description': 'Whether higher metric values represent improvement'},
                'timeout_ms': {'type': 'integer', 'description': 'Task timeout in ms (default 3,600,000ms / 1 hour with stream heartbeat)'}
            },
            'required': ['prompt']
        }
    },
    'qwen_task': {
        'name': 'qwen_task',
        'description': 'Manage background Qwen coworker tasks: check status, retrieve output, cancel, or list tasks.',
        'parameters': {
            '$schema': 'http://json-schema.org/draft-07/schema#',
            'type': 'object',
            'properties': {
                'action': {'type': 'string', 'enum': ['status', 'cancel', 'cancel_all', 'list'], 'description': 'Action to perform on background tasks'},
                'task_id': {'type': 'string', 'description': 'Task ID (required for status, optional for cancel/cancel_all to cancel all tasks)'}
            },
            'required': ['action']
        }
    },
    'qwen_server': {
        'name': 'qwen_server',
        'description': 'Check status, start, or stop the universal 245K context vLLM server in WSL Ubuntu.',
        'parameters': {
            '$schema': 'http://json-schema.org/draft-07/schema#',
            'type': 'object',
            'properties': {
                'action': {'type': 'string', 'enum': ['status', 'start', 'stop'], 'description': 'Lifecycle action to perform'}
            },
            'required': ['action']
        }
    }
}

for name, schema in tools.items():
    p = os.path.join(mcp_dir, f'{name}.json')
    with open(p, 'w', encoding='utf-8') as f:
        json.dump(schema, f, indent=2)
    print(f'Wrote {p}')

instructions_content = """# qwen38-local MCP Server Best Practices & Protocol

## 1. Quick Reference & Tool Invocation
To dispatch work to the local autonomous Qwen3.8-27B coworker, call `call_mcp_tool`:
- **ServerName**: `"qwen38-local"`
- **ToolName**: `"qwen_coworker"`
- **Arguments**:
  - `prompt`: Specific, single-concern task or inquiry scoped by the Lead Architect to ONE subsystem (Full Objective Fulfillment, no tool ceilings).
  - `cwd`: Target project directory (e.g. `<workspace_root>` or workspace).
  - `session_id`: Named session (e.g. `"redteam_stage1"`) to maintain KV-cache across 2–3 turns.
  - `extensions`: Optional stdio extensions, e.g. `["uvx free-search-mcp"]` for live web lookup or `["npx -y @upstash/context7-mcp"]`.

## 2. Invariants & Guardrails for the Meta-Supervisor
1. **Rule 0 — Universal Turn 1 Coworker Invariant**:
   - Dispatch directly to `qwen_coworker` on Turn 1 with the user's objective and target `cwd`.
   - **DO NOT** execute manual health checks, network probes (`curl localhost:18020`, `curl localhost:18021`), or read `index.js` manually prior to dispatching. The server lifecycle and proxy are fully autonomous and self-healing.
2. **Zero-Turn Execution & Reactive Sleep Contract**:
   - Fast tasks (< 45s): Returns full deliverable directly in Turn 1.
   - Long tasks (>= 45s): Safely yields `taskId` and a `wait_command` (`curl -s http://127.0.0.1:18021/task/<id>/wait`). Run this `wait_command` via `run_command` so Antigravity automatically sleeps at $0 token cost and wakes up upon completion.
3. **Anti-Monolithic Discipline (Prompt Scoped, Never Prompt Qwen to Scope)**:
   - The Lead Architect scopes the PROMPT itself around ONE subsystem; NEVER prompt Qwen to "keep tool calls low" or "limit to N actions".
   - Qwen executes with Full Objective Fulfillment without wasting reasoning tokens on artificial tool ceilings.
   - Keep `session_id` active for 2–3 focused turns, then roll to `<milestone>_stage2` to reset context and maintain peak decoding speed.
4. **Mid-Flight User Injections**:
   - If the user sends guidance while a background task is running, acknowledge it, stage the requirement for the next turn, and immediately re-execute the `wait_command` via `run_command` in the same turn.
"""

inst_path = os.path.join(mcp_dir, 'instructions.md')
with open(inst_path, 'w', encoding='utf-8') as f:
    f.write(instructions_content)
print(f'Wrote {inst_path}')

