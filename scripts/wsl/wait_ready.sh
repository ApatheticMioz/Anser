#!/bin/bash
for i in $(seq 1 40); do
  PID=$(pgrep -f 'vllm serve' | head -1)
  if [ -n "$PID" ]; then
    RESP=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:18020/v1/models)
    if [ "$RESP" = "200" ]; then
      echo "READY pid=$PID"
      exit 0
    fi
  fi
  sleep 10
done
echo "TIMEOUT waiting for server"
tail -n 40 /tmp/mcp_launch_huge.log 2>/dev/null || true
exit 1
