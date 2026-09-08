@echo off
REM Native Windows llama.cpp server (CUDA build) serving the abliterated
REM Qwen3.8-27B GGUF + vision projector, REASONING ON (model's default
REM thinking mode). Runs OUTSIDE WSL entirely - vLLM's GGUF plugin can't
REM load this architecture (qwen3_5 unsupported), and llama.cpp only ships
REM prebuilt CUDA binaries for Windows, not Linux - so this sidesteps
REM needing a CUDA toolkit build in WSL altogether.
REM Deliberately SAME port (18020) and served-model-name (qwen3.8-27b) as
REM scripts\main\ - so Goose's env vars never need to change between them -
REM only one can ever be up at once anyway since both need the whole GPU.
REM For the non-reasoning variant, use start_noreason.bat instead.
REM Single-line command deliberately - a prior multi-line ^ continuation
REM version broke mid-session (cmd.exe treated a later flag as a separate
REM command once the continuation parsing failed), killing the server.
"D:\LLM_Ecosystem\llama-cpp\llama-server.exe" -m "\\wsl.localhost\Ubuntu\home\<user>\qwen-uncensored\model\Qwen3.8-27B-Uncensored-Q4_K_M.gguf" --mmproj "\\wsl.localhost\Ubuntu\home\<user>\qwen-uncensored\model\Qwen3.8-27B-Uncensored-vision-f16.gguf" --alias qwen3.8-27b --port 18020 --host 127.0.0.1 -ngl 999 -c 16384 -fa on -ctk q8_0 -ctv q4_0 -rea on
