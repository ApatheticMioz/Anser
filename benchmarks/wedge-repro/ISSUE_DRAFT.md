# Upstream issue draft — syv-ai/qwen38-27b-rtx3090

> Status: DRAFT for user review. Do not post until approved. Title + body below.

---

**Title:** Engine livelock on the first large chunked-prefill after boot (all cudagraph modes, all KVarN attention routes) — repro harness + py-spy evidence

**Body:**

## Summary

On RTX 3090 / WSL2 (`SPEC=dflash2 CTX=huge PREFIX_CACHE=1 MAX_SEQS=8`, kvarn_k4v2_g128,
vLLM 0.27.1 @ commit 2ae239f), the first large prompt (~24k tokens) submitted after an
engine boot reliably stalls the engine core: the GPU spins, host threads block in a D2H
sync, no further requests are scheduled, and the engine either self-recovers after
minutes or stays wedged until reboot (observed once in production: 4.5h, GPU 100%).

A deterministic one-request reproduction, an A/B across three configurations, and a
py-spy capture of the wedged core are below. We could not root-cause it to a single
line and are reporting the phenomenon + evidence rather than a speculative fix. We are
also shipping a boot-time warmup workaround on our side.

## Reproduction

`repro.py` (attached; stdlib-only) fires ONE ~24k-token chat completion at a freshly
booted engine, then a 1-token canary with a 30s abort:

- FULL captured verify (`dflash2`, our launcher default): **iter 1 wedges.**
- `cudagraph_mode=PIECEWISE`: **iter 1 wedges, identical signature.**
- `KVARN_FUSED_VERIFY_MAXQ=4096` (routes chunked-prefill continuations into the fused
  verify path instead of the materialize path): **iter 1 wedges, identical signature.**

After the first stall passes (or after a restart + one slow request), the same engine
serves 24+ consecutive clean iterations of 24–31k-token prompts across residues mod 128.
Early post-stall requests are severely slowed (a 24k prefill that later takes 7–20s
takes 140–240+s) and generation throughput on the affected path is 0.3–10 tok/s vs the
expected 25–77.

## Observed signature (py-spy, wedged EngineCore, live capture)

Main thread of the core loop, spinning ~100% CPU inside a single `execute_model` step:

```
_cached_multiquery_path  vllm/v1/attention/backends/kvarn_attn.py:2496
                         (total_k = int(cu_k[-1].item())  — first D2H sync of the
                          eager continuation step; gates ALL previously enqueued work)
forward                  kvarn_attn.py:2171
... execute_model → run_busy_loop
```

GPU util 100% during the stall; engine stats lines go silent; queues appear empty in
`/metrics` (the stalled step never yields). Always preceded, seconds earlier, by the
pair:

```
WARNING [jit_monitor.py:135] Triton kernel JIT compilation during inference: _prepare_dflash_inputs_kernel
WARNING [jit_monitor.py:135] Triton kernel JIT compilation during inference: _kvarn_build_packed_kv_kernel
```

## What we ruled out

- **Captured verify graph (gotcha 37 class):** wedges identically under PIECEWISE.
- **The materialize route:** wedges identically with `KVARN_FUSED_VERIFY_MAXQ=4096`.
- **Grid explosion / garbage `fa_max_blocks_per_req`:** Python int, clamped; an
  instrumentation probe logging `B / max_blocks / grid / total_k / max(seq_lens_cpu)`
  at every materialize-path call shows sane values right up to the stall.
- **CPU-visible metadata garbage:** `seq_lens_cpu` matches device lengths pre-stall.
- **Silent MMU fault:** `dmesg` (sudo) shows no Xid entries at wedge time.
- **Autotune re-benchmark:** the build_packed kernel has no autotune; autotuned
  kernels are warmed pre-capture.
- **DFLASH2_CHAIN:** irrelevant here (and in our checkout the variable is not read by
  anything — the n-gram-chains feature of issue #38 was never installed).

## Remaining suspicion

A first-execution interaction — the first real-shape launch of the freshly-JIT-compiled
Triton kernels on WSL2 (`jit_monitor`'s "extend warmup" warnings) stalling the GPU
stream once per boot. The in-code warmup (`_warm_decode_kernels`) covers the decode/
verify kernels but the stall follows the **prefill-continuation** shapes
(`_kvarn_build_packed_kv_kernel` via `_cached_multiquery_path`, and
`_prepare_dflash_inputs_kernel`), which do not appear to be warmed at pool-init on
this path. Extending pool-init warmup to the chunked-prefill continuation shapes
might fix or drastically mitigate this — we have not yet tested that patch and did
not want to claim it blind.

## Workaround we ship in the meantime

Our MCP dispatcher warms the engine after every boot with one large synthetic prompt
(24k tokens) before marking it ready, with a bounded reboot-retry if that warmup
itself stalls. This converts the failure into a 1–8 minute boot delay.

## Environment

- RTX 3090 24GB, WSL2 (Ubuntu, kernel 6.18.33.2-microsoft-standard-WSL2), driver
  current as of 2026-08-29
- vLLM 0.27.1 + repo patches @ 2ae239f, SPEC=dflash2 (7 tokens), CTX=huge
  (max-model-len 245760, kv-cache-memory 5261334938), kvarn_k4v2_g128,
  --max-num-batched-tokens 2048, --async-scheduling, --enable-prefix-caching
  --prefix-match-unit 128, MAX_SEQS=8
- Attachments: repro.py, py-spy dump, per-iteration JSONL, engine-log tails

---

## Notes for us (not part of the issue)

- PR candidate (after maintainer reply): extend warmup to prefill-continuation
  shapes; the launcher-gate comment contradiction (patch header / gotcha 37 say
  PIECEWISE-with-prefix-cache is required, script claims FULL swept-clean) is worth
  asking about in the issue text — ask, don't assert.
- If bare-metal (non-WSL2) maintainers cannot reproduce, WSL2 becomes a primary
  suspect in itself; state our platform prominently in the report.
