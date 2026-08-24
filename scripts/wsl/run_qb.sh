#!/bin/bash
cd ~/qwen-serving
source venv/bin/activate 2>/dev/null || true
export VLLM_API_KEY=$(cat api_key.txt 2>/dev/null || true)
nohup venv/bin/python bench/quality_battery.py huge_live > /tmp/qb.log 2>&1 &
disown
echo "started pid=$!"
