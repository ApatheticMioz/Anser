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
        'description': 'Primary agentic interface for local Qwen3.8-27B running inside the Goose agent harness for $0. Has native access to Filesystem, Shell, and Git across Windows and WSL. Pure text-only model with Universal 245K context. Fast tasks (< 45s) return full deliverable in Turn 1. Long tasks (>= 45s) safely yield taskId and wait_command before client deadlines. Run wait_command to block and wake up automatically with the result at $0 token cost.',
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
                'action': {'type': 'string', 'enum': ['status', 'cancel', 'list'], 'description': 'Action to perform on background tasks'},
                'task_id': {'type': 'string', 'description': 'Task ID (required for status and cancel)'}
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
