@echo off
REM Qwen3.8-27B via vLLM+DFlash2+KVarN, CTX=huge: 245,760 context, ~77 tok/s.
REM DEFAULT config - 77 tok/s is fast enough for nearly everything. See start.bat.
REM Runs in WSL Ubuntu. Serves on http://localhost:18020/v1
REM API key: wsl -d Ubuntu -- cat ~/qwen-serving/api_key.txt
REM NOTE: exclusive with scripts\uncensored\ (same GPU, same port 18020) -
REM stop that first (scripts\uncensored\stop.bat).
echo Starting Qwen3.8-27B (vLLM+DFlash2+KVarN, CTX=huge, 245k context) - default config...
wsl -d Ubuntu -- bash ~/qwen-serving/launchers/start_huge.sh
