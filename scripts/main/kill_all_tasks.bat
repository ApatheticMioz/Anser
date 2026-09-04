@echo off
REM Cancel all in-flight Qwen/Goose tasks, purge leases, and idle the GPU.
taskkill /F /IM goose.exe /T >nul 2>&1
wsl -d Ubuntu -- bash /mnt/d/LLM_Ecosystem/scripts/wsl/kill_all_tasks.sh
