# llama.cpp Windows CUDA Binaries

The compiled binaries (`*.dll`, `*.exe`) in this directory are excluded from Git tracking via `.gitignore` to keep the repository lightweight.

## Setup Instructions

1. Download the latest Windows CUDA build (e.g. `llama-b*-bin-win-cuda-cu12.*-x64.zip` or `cu13`) from the official repository:
   https://github.com/ggerganov/llama.cpp/releases
2. Extract the contents directly into this `llama-cpp/` directory.
3. The uncensored model launch scripts in `scripts/uncensored/` invoke `llama-server.exe` from this folder.
