@echo off
REM Unified status check for BOTH server families - they share GPU and port
REM 18020, so only one is ever up at a time. Checks the Windows-native
REM llama-server.exe process (scripts\uncensored\), the WSL vLLM process
REM (scripts\main\), and the shared port, so you can tell which one (if
REM either) is actually running.
echo --- GPU ---
nvidia-smi --query-gpu=memory.used,memory.free,utilization.gpu --format=csv
echo.
echo --- uncensored (Windows llama-server.exe) ---
tasklist /FI "IMAGENAME eq llama-server.exe" 2>nul | findstr /I llama-server.exe >nul
if %ERRORLEVEL%==0 (echo running) else (echo not running)
echo.
echo --- main (WSL vLLM) ---
wsl -d Ubuntu -- bash -c "pgrep -af 'vllm serve' || echo not running"
echo.
echo --- port 18020 ---
curl -s -m 3 http://localhost:18020/v1/models
echo.
