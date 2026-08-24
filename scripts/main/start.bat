@echo off
REM Default launcher: boots the huge config (245K context, ~77 tok/s).
REM 77 tok/s is fast enough for nearly everything - use start_fast.bat only if
REM you've confirmed a specific latency-critical loop actually needs 107-130 tok/s.
call "%~dp0start_huge.bat"
