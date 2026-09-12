#!/bin/bash
# vLLM + DFlash2 + KVarN, CTX=huge: 245,760 context, ~77 tok/s. DEFAULT config.
set -e
pkill -9 -f 'vllm serve' 2>/dev/null || true
pkill -9 -f EngineCore 2>/dev/null || true
sleep 3
cd ~/qwen-serving
export SPEC=dflash2
export CTX=huge
export PREFIX_CACHE=1
export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:False
export VLLM_WSL2_ENABLE_PIN_MEMORY=1
export VLLM_DFLASH2_LOOKUP_ADAPTIVE=0  # A/B tested 2026-08-23: pins verify block length, fixes documented prefix-cache bug at zero cost, measured +26pct faster (160.7 vs 127.6 tok/s), no downside in 6 trials/config - see docs/gotchas or single-user/start_qwen.sh comments
# (2026-08-29: VLLM_DFLASH2_CHAIN removed. Exhaustive grep proved NOTHING in our venv
# reads it - the n-gram-chains feature lives in an external repo (upstream issue #38)
# that was never installed, so the earlier CHAIN=1/CHAIN=0 toggles were both inert.
# The feature is also documented greedy-only, and our delegated workloads run at
# temperature 1.0. See docs/archive/DEVELOPMENT_NOTES_2026.md.)
# Set MAX_SEQS=1 for single-user pair programming (MAX_CONCURRENT_GOOSE=1).
# Setting MAX_SEQS=1 eliminates unused multi-stream CUDA graphs and recurrent state
# reservations, reclaiming ~800+ MiB of non-KV VRAM headroom on the RTX 3090.
# This completely prevents WSL2 PCIe host-backing and dxgkio_escape deadlocks
# during massive chunked prefills while preserving the full 245,760 context window.
# (Trajectory: ran MAX_SEQS=8 in the early multi-task era, then deliberately 1
# for single-user pair programming — the VRAM-headroom + WSL2-deadlock rationale
# above. 2026-09-12: user-authorized raise to 2. Watch for: the WSL2 PCIe
# host-backing / dxgkio_escape deadlock signature during massive chunked
# prefills, and non-KV VRAM headroom loss on the RTX 3090. Revert to 1 if either
# reappears. Harness side must stay 1:1: MAX_CONCURRENT_GOOSE in
# mcp-qwen/src/config.js.)
export MAX_SEQS=2
# Maximum Intelligence: Pristine W4A16 (unquantized activations). Retains 96.5% GSM8K
# reasoning with zero perplexity degradation (+4.1% PPL / -1.5% GSM8K avoided).
# Per-request usage & timing metrics (issue #51): enables usage reporting & prompt-tokens details
export REQ_METRICS=1
# Server-side reasoning default: medium effort when no per-request override is sent.
# Validated: xhigh (the model's own template default) can burn an entire modest token
# budget on reasoning alone for non-trivial tasks (measured: 1500/1500 tokens consumed,
# truncated mid-answer). medium is the community- and self-validated balance - real
# accuracy lift over off, without xhigh's verbosity tax on simple delegated tasks.
export EXTRA_ARGS='--default-chat-template-kwargs {"reasoning_effort":"medium"}'
# Universal Stateful UTF-8 & SSE Stream Sanitizer Proxy (port 18022 -> 18020)
pkill -9 -f 'stream_proxy.js' 2>/dev/null || true
setsid node ~/qwen-serving/stream_proxy.js < /dev/null > /tmp/stream_proxy.log 2>&1 &
exec bash single-user/start_qwen.sh
