#!/bin/bash
pkill -9 -f 'vllm serve' 2>/dev/null && echo "stopped vllm serve" || echo "no vllm serve running"
pkill -9 -f EngineCore 2>/dev/null && echo "stopped EngineCore" || echo "no EngineCore running"
pkill -9 -f 'stream_proxy.js' 2>/dev/null && echo "stopped stream_proxy" || echo "no stream_proxy running"
