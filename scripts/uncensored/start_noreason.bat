@echo off
REM Same as start.bat but REASONING OFF (no thinking trace, direct answers) -
REM use this for latency-sensitive or simple prompts where the thinking pass
REM just burns tokens/time for no benefit.
"D:\LLM_Ecosystem\llama-cpp\llama-server.exe" -m "\\wsl.localhost\Ubuntu\home\<user>\qwen-uncensored\model\Qwen3.8-27B-Uncensored-Q4_K_M.gguf" --mmproj "\\wsl.localhost\Ubuntu\home\<user>\qwen-uncensored\model\Qwen3.8-27B-Uncensored-vision-f16.gguf" --alias qwen3.8-27b --port 18020 --host 127.0.0.1 -ngl 999 -c 16384 -fa on -ctk q8_0 -ctv q4_0 -rea off
