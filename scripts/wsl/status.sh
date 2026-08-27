#!/bin/bash
echo "--- GPU ---"
nvidia-smi --query-gpu=memory.used,memory.free,utilization.gpu --format=csv
echo "--- vLLM process ---"
pgrep -af 'vllm serve' || echo "not running"
echo "--- server health ---"
curl -s -m 3 http://localhost:18020/v1/models | python3 -m json.tool 2>/dev/null || echo "server not responding"
