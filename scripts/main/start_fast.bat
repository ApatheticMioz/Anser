@echo off
REM Qwen3.8-27B via vLLM+DFlash2, CTX=fast: 57,344 context, ~107-130 tok/s.
REM NOT the default - use start.bat (huge) unless you've confirmed a specific
REM latency-critical loop needs this. 77 tok/s (huge) is fast enough for nearly everything.
REM Runs in WSL Ubuntu. Serves on http://localhost:18020/v1
REM API key: wsl -d Ubuntu -- cat ~/qwen-serving/api_key.txt
REM NOTE: exclusive with scripts\uncensored\ (same GPU, same port 18020) -
REM stop that first (scripts\uncensored\stop.bat).
echo Starting Qwen3.8-27B (vLLM+DFlash2, CTX=fast, 57k context) - rarely needed, prefer start.bat...
wsl -d Ubuntu -- bash ~/qwen-serving/launchers/start_fast.sh
