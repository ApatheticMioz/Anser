#!/usr/bin/env bash
set -euo pipefail

SERVING_DIR="${HOME}/qwen-serving"
cd "$SERVING_DIR"

SP="venv/lib/python3.12/site-packages/vllm"

echo "=== Applying upstream vLLM 0.28.0 patches ==="
for p in patches/*.patch; do
  b="$(basename "$p")"
  if [ "$b" = "dflash2-backport.patch" ]; then
    echo "SKIP: $b (DFlash2 is native in vLLM 0.28.0)"
    continue
  fi

  if patch -p1 -R --dry-run -s -d "$SP" < "$p" >/dev/null 2>&1; then
    echo "ALREADY APPLIED: $b"
    continue
  fi

  if patch -p1 -s -d "$SP" < "$p"; then
    echo "APPLIED: $b"
  else
    echo "FAILED: $b"
  fi
done

echo "=== Installing / Updating KVarN for vLLM 0.28.0 ==="
bash kvarn/install.sh

echo "=== Running verify.sh --no-server ==="
bash verify.sh --no-server
