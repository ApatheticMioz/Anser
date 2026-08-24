#!/bin/bash
# One-time provisioning: pulls the Q4_K_M GGUF + vision projector into WSL at
# ~/qwen-uncensored/model. Already run once (2026-08-23) - re-run only if the
# model files are missing or need re-fetching. Invoke via:
#   MSYS_NO_PATHCONV=1 wsl -d Ubuntu -- bash /mnt/d/LLM_Ecosystem/scripts/uncensored/download_model.sh
set -e
mkdir -p ~/qwen-uncensored/model
cd ~/qwen-uncensored/model
source ~/qwen-serving/venv/bin/activate
python3 -c "
from huggingface_hub import hf_hub_download
for fn in ['Qwen3.8-27B-Uncensored-Q4_K_M.gguf', 'Qwen3.8-27B-Uncensored-vision-f16.gguf']:
    p = hf_hub_download(repo_id='JonathanColetti/Qwen3.8-27B-Uncensored-GGUF', filename=fn, local_dir='.')
    print('DONE', p)
"
