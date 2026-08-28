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
export VLLM_DFLASH2_CHAIN=0            # DISABLED 2026-08-28: prime suspect for recurring engine-core wedges (stats silence + GPU 100%, see mcp-qwen/NOTES.md:824) during ~100k-token speculative decode. Upstream ships CHAIN off by default; benefit was +7% on copy-heavy workloads only, zero on prose - not worth the deadlock risk. Re-enable only with new upstream evidence of a fix.
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
# Server-side reasoning default: medium effort when no per-request override is sent.
# Validated: xhigh (the model's own template default) can burn an entire modest token
# budget on reasoning alone for non-trivial tasks (measured: 1500/1500 tokens consumed,
# truncated mid-answer). medium is the community- and self-validated balance - real
# accuracy lift over off, without xhigh's verbosity tax on simple delegated tasks.
export EXTRA_ARGS='--default-chat-template-kwargs {"reasoning_effort":"medium"}'
exec bash single-user/start_qwen.sh
