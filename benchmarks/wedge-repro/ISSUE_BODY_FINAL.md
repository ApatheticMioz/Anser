## Platform

**WSL2 (Ubuntu, kernel 6.18.33.2-microsoft-standard-WSL2, NVIDIA driver 616.56,
single RTX 3090 24GB).** Everything in this report was observed on WSL2, and our
leading suspicion involves the WSL2 GPU stack, so the platform is a first-class
part of the bug report, not a footnote. If this cannot be reproduced on bare
metal, WSL2 itself is a primary suspect.

## Summary

With this repo's `SPEC=dflash2 CTX=huge PREFIX_CACHE=1` single-user config
(KVarN 4/2-bit KV, DFlash2 7-token speculative decoding; vLLM 0.27.1 at commit
2ae239f), the vLLM engine core can **wedge on the first large chunked-prefill
request after a fresh boot**:

- the unconditional 10-second `Engine 000: … Running:` stats lines go silent;
- the API process stays up — the port answers, requests are accepted, but none
  is ever scheduled;
- in one production incident (2026-08-28) this persisted **~4.5h** with the GPU
  at 100% (~24.1/24 GB resident) producing nothing, until the core spontaneously
  unwedged; the operator then stopped the engine.
- over the following ~36h the same failure recurred **5 times**, each minutes
  after a fresh boot, always during a large-prompt (10k+ token) request.

A one-request reproduction harness, an A/B across three configurations, and a
py-spy capture of the wedged core are below. We did not root-cause it to a
single line, so this reports the phenomenon + evidence rather than a
speculative fix, and ends with two questions for the maintainer.

## Environment

- WSL2 (Ubuntu), kernel 6.18.33.2-microsoft-standard-WSL2, NVIDIA driver 616.56,
  RTX 3090 24GB, 250 W
- vLLM 0.27.1 + this repo's patches, at commit **2ae239f** (pristine tree; see
  "local patch" note below)
- Launch: the repo's `SPEC=dflash2 CTX=huge PREFIX_CACHE=1`
  `single-user/start_qwen.sh` config, i.e.
  `vllm serve <Qwen3.8-27B> --served-model-name qwen3.8-27b
  --gpu-memory-utilization 0.93 --max-model-len 245760 --max-num-seqs 8
  --kv-cache-dtype kvarn_k4v2_g128 --block-size 128
  --mamba-ssm-cache-dtype float16 --async-scheduling
  --max-num-batched-tokens 2048
  --speculative-config '{"method":"dflash","model":<DFlash2-W4A16 drafter>,
  "num_speculative_tokens":7}'
  --compilation-config '{"max_cudagraph_capture_size":…,"custom_ops":
  ["+rms_norm","+silu_and_mul"]}'
  --reasoning-parser qwen3 --enable-prefix-caching --mamba-cache-mode align
  --prefix-match-unit 128 --kv-cache-memory 5261334938
  --default-chat-template-kwargs {"reasoning_effort":"medium"}`
- **Note:** no `cudagraph_mode` is passed for dflash2 (see Question 1), so the
  engine ran the vLLM 0.27.1 V1 **default capture mode (FULL_AND_PIECEWISE)**.

## Reproduction

Attached `repro.py` (single file, Python stdlib only) drives one arm end to
end: freshly boot the engine, fire **ONE ~24k-token chat completion** (the
first large prompt — at `--max-num-batched-tokens 2048` this is the first
chunked-prefill that has a continuation step), then a 1-token canary with a
30s abort to distinguish an engine-level stall from a slow request. On a stall
it captures a `py-spy dump` of the EngineCore process plus the engine-log tail
and restarts the engine under the same config. Subsequent iterations sweep the
prompt length in 317-token steps (so the `--prefix-match-unit 128` prefix-cache
hits vary) to check post-stall behaviour. The script was written to drive our
WSL2 box from Windows; the essential sequence is just those four steps, and it
reproduces manually.

Arms (fresh boot each):

| Arm | Config change | Result |
|---|---|---|
| default | none (v1 default capture mode, materialize verify route) | **iter 1 (24,000 tokens) wedged**; after restart, 23 consecutive clean iterations (24.6–31.6k tokens, residues 4–126 mod 128) |
| `cudagraph_mode=PIECEWISE` | forced (the launcher's `CUDAGRAPH_MODE` handling does not apply to dflash2, so we patched the gate for this arm — see Question 1) | **iter 1 wedged, identical signature** |
| `KVARN_FUSED_VERIFY_MAXQ=4096` | routes chunked-prefill continuations from the materialize path to the fused-verify kernels | **first big request after a fresh boot wedged 3/4 times** (iters 1, 2, 4) |

**Local-patch note (transparency):** the two non-default arms were running a
locally modified KVarN kernel (an index-clamping guard + a logging probe).
Separate testing showed that modification by itself made the first-launch
stall *deterministic* on this stack — every fresh boot's first big request
hung (4/4 boots), because the edited source compiles to a new Triton variant
whose first real-shape launch hangs the stream. We reverted it; a **pristine
upstream tree completes the same workload cleanly on the first try** (1/2
pristine boots in the A/B window + 1 pristine isolation run). We therefore
present the two non-default arms as "the same stall family appears under the
other configurations" and do not lean on their higher wedge rates; the
pristine default arm is the clean reproduction.

**Rate:** the wedge is **not deterministic** on pristine upstream — of 2
pristine fresh boots in our A/B window, 1 wedged at iteration 1 — but it is
always at the first large request after a fresh boot, and production showed
the same pattern 6 times (the 4.5h incident + 5 in ~36h).

**Post-stall behaviour:** once the first stall passes (or after a restart),
the same engine serves cleanly, but early requests are severely degraded: the
first post-stall 24.6k prefill took **143.8s** (subsequent 24–31k prefills:
6.6–58.8s), and generation on the materialize route ran **0.3–10.4 tok/s**
vs the ~36–130 tok/s this config documents on WSL2 in the README (38 tok/s
for the summary task type the harness runs). The degradation is non-fatal and
improves as the session continues.

## Observed signature (py-spy, live capture of the wedged EngineCore)

The main thread of the engine core loop is **on-CPU**, spinning inside a
single `execute_model` step:

```
Thread 154617 (active): "MainThread"
    _cached_multiquery_path (vllm/v1/attention/backends/kvarn_attn.py:2496)
    forward                 (vllm/v1/attention/backends/kvarn_attn.py:2171)
    unified_attention_with_output (…/attention/attention.py:894)
    …
    execute_model           (vllm/v1/worker/gpu/model_runner.py:1459)
    step_with_batch_queue   (vllm/v1/engine/core.py:655)
    run_busy_loop           (vllm/v1/engine/core.py:1386)
```

Frame-by-frame, the top is the KVarN **materialize path for a
chunked-prefill continuation**:

- `kvarn_attn.py:2496` — `total_k = int(cu_k[-1].item())`: the **first
  device-to-host sync of the eager continuation step** — `Tensor.item()`
  synchronizes the stream, so this call gates on *everything previously
  enqueued*. If something earlier on the stream never completes, this is
  where the host parks.
- `kvarn_attn.py:2171` — the `forward` dispatch: `num_decodes == 0` and
  `has_cached_multiquery` is true, i.e. a multi-query batch continuing a
  chunked prefill (the first chunk of a prefill goes to `_prefill_first_chunk`;
  this path is only reached once a chunked prefill has a cached-history
  continuation, and for multi-query batches with `max_query_len >
  KVARN_FUSED_VERIFY_MAXQ` (default 8) it uses the materialize route).

While wedged:

- the 10-second `Engine 000: …` stats lines (printed unconditionally in vLLM)
  go silent; the last line shows `Running: 1 reqs`, then nothing;
- the API process keeps answering the port and accepting requests that are
  never scheduled;
- in the production incident the GPU sat at 100% / 24.1 GB resident for
  hours, producing zero output;
- `dmesg` (run with sudo) shows **no Xid / no MMU fault** at wedge time —
  there is no visible illegal-memory-access signature.

Seconds before every wedge, the engine log shows this pair:

```
WARNING … [jit_monitor.py:135] Triton kernel JIT compilation during inference: _prepare_dflash_inputs_kernel.
    This causes a latency spike; consider extending warmup to cover this shape/config.
WARNING … [jit_monitor.py:135] Triton kernel JIT compilation during inference: _kvarn_build_packed_kv_kernel.
    This causes a latency spike; consider extending warmup to cover this shape/config.
```

(`_prepare_dflash_inputs_kernel` from
`vllm/v1/worker/gpu/spec_decode/dflash/speculator.py`;
`_kvarn_build_packed_kv_kernel` from
`vllm/v1/attention/ops/triton_kvarn_decode.py`.)

## What we ruled out

- **The captured verify graph** (the failure class the `kvarn-v2-runner.patch`
  header / gotcha 37 document for prefix caching + a captured FULL graph):
  the identical stall reproduces under `cudagraph_mode=PIECEWISE`.
- **The materialize route specifically:** the same signature with fused-verify
  routing (`KVARN_FUSED_VERIFY_MAXQ=4096`) — subject to the local-patch
  caveat above.
- **Garbage CPU-visible metadata:** a temporary instrumentation probe logged
  `batch / per-request blocks / grid / total_k` at every materialize-path
  call — sane right up to the stall; `seq_lens_cpu` matched device lengths.
- **Grid explosion:** the packed-KV grid is a Python int, computed and
  clamped on the host before launch.
- **Autotune re-benchmarking during the request:**
  `_kvarn_build_packed_kv_kernel` is not autotuned; the autotuned decode
  kernels are warmed before graph capture (the issue #10 note in
  `_ensure_pool`).
- **A silent MMU fault:** no Xid in `dmesg` at wedge time.

## Working suspicion (unproven)

A **first-launch-of-a-freshly-JIT-compiled-Triton-variant** interaction on
this WSL2 stack, stalling the GPU stream once per boot:

- `_prepare_dflash_inputs_kernel` has **no warmup on its path** — it compiles
  during the first speculative-decode step of every fresh boot (the
  `jit_monitor` warning is the evidence), on exactly the shape the first
  large request uses.
- `_kvarn_build_packed_kv_kernel` *does* get a pool-init warmup
  (`_warm_decode_kernels` in `_ensure_pool`), but on a tiny fixed synthetic
  shape (B=8, 4 blocks). The logs still show a **fresh JIT compilation event
  for it during the first real request** — i.e. the production
  chunked-prefill-continuation shape compiles a variant the warmup never
  produced.
- On this stack, the first real-shape launch of a freshly compiled variant
  stalls the stream: rare on pristine kernels (1/2 boots here, 6 times in
  production in ~40h), but 100% deterministic when the kernel source is
  modified at all (a new variant — 4/4 boots). That pattern fits a
  first-execution interaction (JIT + WSL2 driver/`pytorch` pin-memory
  configuration) rather than a logic bug in the kernel.

We have **not** tested "warm the production shapes at pool-init" as a fix,
and we are not claiming it would fix this — we are reporting that the
existing warmup demonstrably does not cover the shapes that precede the
stall, and asking the maintainer whether that is intended (Question 2).

## Workaround we ship in the meantime

Our MCP front-end fires one synthetic ~24k-token prompt at the engine after
every (re)boot and only marks the engine ready once that request completes
(stall-tolerant retry). This converts the failure into a bounded 1–8 minute
boot delay instead of a wedged production engine.

## Questions

1. **Is the default capture mode (FULL_AND_PIECEWISE) + `--enable-prefix-caching`
   the intended, verified-safe mode for `SPEC=dflash2 CTX=huge`?** The
   `kvarn-v2-runner.patch` header says "with prefix caching on, the DFlash2
   verify step must not be a CAPTURED cuda graph … anyone driving
   `vllm serve` directly needs the same", and the gotcha 37 mitigation says
   "`CTX=huge` forces `cudagraph_mode=PIECEWISE` for **every** speculator" —
   but `single-user/start_qwen.sh` only applies the PIECEWISE default to
   non-dflash2 specs, and deliberately runs dflash2 on the default capture
   mode, citing a 0-of-128-broken-residues FULL sweep and better GSM8K.
   (Our A/B stalls in *both* capture modes, so this is not the cause of this
   stall — but the documents disagree, so we wanted to ask rather than
   assume.)
2. **Should the pool-init warmup cover the chunked-prefill-continuation
   kernel shapes** — a first real-shape launch of
   `_prepare_dflash_inputs_kernel` and of
   `_kvarn_build_packed_kv_kernel` — so that the first large request after a
   fresh boot never triggers a JIT-during-inference? If not, what is the
   intended way to pre-compile shapes like these?

## Attachments

- `repro.py` — the single-file harness (stdlib only)
- `wedge_…_pyspy.txt` — py-spy dump of the wedged EngineCore
- `wedge_…_englog.txt` — engine-log tail around each wedge (JIT pair +
  stats silence)
- `iterations_*.jsonl` — per-iteration results for all three arms
