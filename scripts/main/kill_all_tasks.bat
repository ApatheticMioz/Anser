@echo off
setlocal enabledelayedexpansion
echo =======================================================
echo [kill_all_tasks] Emergency Qwen ^& Anser Task Killer
echo =======================================================

echo 1. Notifying Windows Status Coordinator (:18021)...
curl.exe -s -m 2 -X POST http://127.0.0.1:18021/tasks/cancel_all >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo    -^> Status coordinator notified successfully.
) else (
    echo    -^> Status coordinator on port 18021 was not responding or not running.
)

echo 2. Terminating Windows worker processes...
taskkill /F /IM goose.exe /T >nul 2>&1
for /f "tokens=2 delims=," %%a in ('tasklist /FI "WINDOWTITLE eq *evo_runner*" /FO CSV /NH 2^>nul') do (
    taskkill /F /PID %%~a >nul 2>&1
)

echo 3. Purging Windows slot leases and resetting in-flight task files...
set "QWEN_DIR=%USERPROFILE%\.qwen\tasks"
if exist "%QWEN_DIR%\goose_slots" (
    del /f /q "%QWEN_DIR%\goose_slots\*.json" >nul 2>&1
)
if exist "%QWEN_DIR%" (
    powershell -NoProfile -Command "Get-ChildItem '%QWEN_DIR%\task_*.json' -ErrorAction SilentlyContinue | ForEach-Object { try { $json = Get-Content $_.FullName -Raw | ConvertFrom-Json; if (-not $json.done) { $json.status = 'cancelled'; $json.done = $true; $json.isError = $true; $json.finishedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); $json.result = @{ isError = $true; text = 'Task cancelled by emergency task killer.' }; $json | ConvertTo-Json -Depth 10 | Set-Content $_.FullName; Write-Host ('   -> Cancelled disk task: ' + $_.Name) } } catch {} }"
)

echo 4. Executing WSL-side cleanup...
wsl -d Ubuntu -- bash /mnt/d/LLM_Ecosystem/scripts/wsl/kill_all_tasks.sh

echo =======================================================
echo [kill_all_tasks] Completed. Machine-wide tasks cancelled and GPU idled.
echo =======================================================
