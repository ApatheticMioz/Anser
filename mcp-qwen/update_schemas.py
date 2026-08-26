import json, os

mcp_dir = r'C:\Users\Apath\.gemini\antigravity-ide\mcp\qwen38-local'

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
    'qwen_check_task': {
        'name': 'qwen_check_task',
        'description': 'Queries the status of an in-flight or completed background Qwen task. Returns the deliverable if complete.',
        'parameters': {
            '$schema': 'http://json-schema.org/draft-07/schema#',
            'type': 'object',
            'properties': {
                'task_id': {'type': 'string', 'description': 'Task ID returned by qwen_coworker'}
            },
            'required': ['task_id']
        }
    },
    'qwen_cancel_task': {
        'name': 'qwen_cancel_task',
        'description': 'Gracefully cancels an active background Qwen task and kills its process tree.',
        'parameters': {
            '$schema': 'http://json-schema.org/draft-07/schema#',
            'type': 'object',
            'properties': {
                'task_id': {'type': 'string', 'description': 'Task ID to cancel'}
            },
            'required': ['task_id']
        }
    },
    'qwen_list_active_tasks': {
        'name': 'qwen_list_active_tasks',
        'description': 'Lists all currently executing and recently finished tasks managed by this MCP server.',
        'parameters': {
            '$schema': 'http://json-schema.org/draft-07/schema#',
            'type': 'object',
            'properties': {}
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
