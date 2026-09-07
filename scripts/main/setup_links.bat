@echo off
REM Sets up global symbolic links for Antigravity (GEMINI.md) and Claude Code (CLAUDE.md)
REM pointing directly to the tracked canonical copies in this repository.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\setup_links.ps1"
pause
