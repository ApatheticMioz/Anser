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
# temperature 1.0. See mcp-qwen/NOTES.md.)
# Raised 2 -> 4 -> 8 on 2026-08-24, per README's own documented finding: MAX_SEQS is a
# deliberate low default for long-document sessions, not an engine limit - slots cost
# ~8 MiB each and the KV pool stays at 268,169 tokens regardless (upstream measured this
# directly: MAX_SEQS=8 achieved peak 5 concurrent on an 8-stream test, pool unchanged).
# 8 matches upstream's own fully-tested ceiling and mcp-qwen's MAX_CONCURRENT_GOOSE - keep
# the two numbers matched, or concurrent delegate_coding_task calls queue at the engine
# even though the MCP server thinks it has room. Live-verified at each step (2, 4, 8): KV
# pool held at exactly 268,169 tokens every time, no new errors. Only cost is larger
# captured CUDA graphs (64 sizes vs 32 at MAX_SEQS=4) - one-time boot memory/time
# (+~15s), not a per-request cost. Going past 8 would be extrapolating past upstream's
# own tested range, not verified - do not raise further without new evidence.
export MAX_SEQS=8
# Maximum sustained prefill throughput: W4A8 Marlin int8 tensor cores for all linears
# Measured in docs/optimizations.md: +27-30% prefill speedup (1,845 tok/s @ 1k, 1,423 tok/s @ 51k),
# decode speed unchanged, quality preserved (GSM8K 95.0% vs 96.5%).
export INT8_ACT=int8
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
