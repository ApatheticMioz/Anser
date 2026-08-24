#!/bin/bash
KEY=$(cat ~/qwen-serving/api_key.txt 2>/dev/null || true)
for i in $(seq 1 40); do
  PID=$(pgrep -f 'vllm serve' | head -1)
  if [ -n "$PID" ]; then
    RESP=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $KEY" http://localhost:18020/v1/models)
    if [ "$RESP" = "200" ]; then
      echo "READY pid=$PID"
      tr '\0' '\n' < /proc/$PID/environ 2>/dev/null | grep -i LOOKUP_ADAPTIVE || true
      exit 0
    fi
  fi
  sleep 10
done
echo "TIMEOUT waiting for server"
tail -n 40 ~/qwen-serving/last_start.log 2>/dev/null || true
