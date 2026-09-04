@echo off
setlocal enabledelayedexpansion

echo ===================================================
echo [kill_all_tasks] Stopping All Active Qwen / MCP Tasks
echo ===================================================

:: 1. Cancel in-flight tasks via HTTP coordinator (:18021)
echo [1/4] Notifying MCP status server (:18021) to cancel tasks...
curl.exe -s -X POST http://127.0.0.1:18021/tasks/cancel_all >nul 2>&1
if %ERRORLEVEL% equ 0 (
    echo       Status server notified successfully.
) else (
    echo       Status server was not reachable or already idle.
)

:: 2. Terminate Windows-side goose processes
echo [2/4] Terminating any Windows goose.exe processes...
taskkill /F /IM goose.exe /T >nul 2>&1
if %ERRORLEVEL% equ 0 (
    echo       Terminated Windows goose.exe processes.
) else (
    echo       No Windows goose.exe processes running.
)

:: 3. Terminate WSL-side goose and orphaned python/bash sub-agents
echo [3/4] Terminating WSL goose and child processes...
wsl.exe -d Ubuntu -- bash -c "pkill -9 -f 'goose run' 2>/dev/null || true; pkill -9 -f 'avo_runner.py' 2>/dev/null || true"

:: 4. Clear stale semaphore leases in ~/.qwen/tasks/goose_slots/
echo [4/4] Purging stale goose slot leases...
if exist "%USERPROFILE%\.qwen\tasks\goose_slots\*.json" (
    del /Q "%USERPROFILE%\.qwen\tasks\goose_slots\*.json" >nul 2>&1
    echo       Cleared Windows goose slot leases.
)
wsl.exe -d Ubuntu -- bash -c "rm -f /home/apath/.qwen/tasks/goose_slots/*.json 2>/dev/null || true; rm -f /home/apath/.qwen/goose_slots/*.json 2>/dev/null || true"

echo ===================================================
echo [kill_all_tasks] Done. GPU should now be idle.
echo ===================================================
