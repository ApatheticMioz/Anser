# Wedge A/B results — KVarN engine livelock (2026-08-29)

Harness: `repro.py` (see docstring). Deterministic corpus; T1 lengths sweep
24000..~33700 tokens in ~317-token steps (residues mod 128 vary); T2/T3 hit the
prefix cache; 1-token canary (30s abort) between iterations; wedge = failed T1
or failed canary; on wedge: py-spy dump + engine-log tail captured, engine
restarted under the same arm env.

## Arms

| Arm | Env change | Question it answers |
|---|---|---|
| `full` | none (current config: FULL captured verify + PREFIX_CACHE=1 + KVarN) | Do wedges reproduce deterministically? |
| `piecewise` | `CUDAGRAPH_MODE=PIECEWISE` | Is the captured verify graph the corruption source (D1)? |
| `maxq4096` | `KVARN_FUSED_VERIFY_MAXQ=4096` | Is the materialize route required for the wedge? |

## Results

### Arm: full (run stopped externally at iter 26/30; engine healthy)

- iterations completed: 25 (+iter 26 in flight when stopped)
- **hard wedges: 1** — iter 1: T1 (24,000 tokens, residue 64) stalled through its
  full 240s window, then canary failed ⇒ engine-level stall. py-spy + engine-log
  evidence captured (`logs/full/wedge_001_*`). Reproduced the production pattern
  (fresh boot + first large-prompt request).
- soft timeouts (engine healthy): 1 — iter 2 (T1 >240s, JIT-class).
- iters 3–25: clean across residues 4–126.
- **Throughput finding**: generation tok/s on the materialize route is severely
  degraded — 0.3–10.4 tok/s (documented class: ~25–77), and T1 wall-time is
  bimodal (6.6s vs 143.8s for near-identical ~24k prompts). The route pays a
  large cost even when it does not wedge.
- Geometry trace at heartbeat: B=1, max_blocks=1920, grid=1920, total_k=maxsl
  (sane, BAD=False) — no metadata garbage observed in the trace pre-wedge.

### Arm: piecewise (run stopped after iter 1 — hypothesis-decisive result)

- `cudagraph_mode: PIECEWISE` verified in the boot config (the launcher gate had
  to be temporarily patched: `CUDAGRAPH_MODE` was ignored for dflash2 entirely).
- **iter 1: WEDGE** — identical signature to Arm 1 (T1 24,000 tokens, residue 64,
  T1 timed out, canary failed). Engine log: `_prepare_dflash_inputs_kernel` JIT at
  15:16:34, `_kvarn_build_packed_kv_kernel` JIT at 15:16:41, geometry heartbeats
  all sane (BAD=False), then silence.
- **Conclusion: D1 (captured FULL verify) falsified as the wedge cause** — the
  stall reproduces without graph capture. Common to both arms: first materialize-
  path execution after boot (the JIT pair) and the raw-`block_id` far-OOB read.

### Arm: full + defensive kernel patch (ran 3 iters, 3 "wedges" — but see note)

- First attempt: every request failed **fast with HTTP 500** — root cause was a bug
  in my own guard (`UnboundLocalError: group` used before definition; the original
  code defines `group` below the guard). Fixed in both copies.
- Second attempt (guard fixed): iter 1 = the original **silent stall** again
  (T1 timed out, canary failed). Patch did not prevent the wedge ⇒ raw-`block_id`
  OOB falsified as the sole cause. No Xid/MMU entries in dmesg (sudo) ⇒ IMA class
  also has no evidence.
- Positive side-effect confirmed: the guards make metadata-garbage failure modes
  loud (slow-path fallback) instead of silent — worth keeping regardless.

### Arm: maxq4096 (fused-verify routing, env verified live in /proc/PID/environ)

- iter 1: **WEDGE** — identical fresh-boot first-big-prompt signature on a THIRD
  configuration ⇒ the materialize route is not required for the wedge either.

## Consolidated verdict (all three config arms wedge identically)

The stall is a **first-large-chunked-prefill-after-boot event**, independent of:
- CUDA graph mode (FULL and PIECEWISE both wedge),
- attention route (materialize and fused-verify both wedge),
- the defensive kernel patch (wedges with and without).

Always correlated with the first-execution JIT pair (`_prepare_dflash_inputs_kernel`,
`_kvarn_build_packed_kv_kernel`), host spinning in a D2H sync, GPU busy, no MMU
faults. And decisively: **after the first stall passes (or a restart + one slow
request), engines serve cleanly** — the unpatched FULL arm ran 24 consecutive clean
iterations (24–31k prompts, residues 4–126) on the post-wedge engine, with severe
but non-fatal slowness early (T1 143.8s → later 6.6–52s).

Working theory (for upstream): a first-execution / Triton-JIT-on-first-real-shape
interaction on WSL2 stalls the GPU stream once per boot; recovery is possible but
not guaranteed (the 2026-08-28 production incident stayed wedged 4.5h until reboot).

**Mitigation derived from the verdict (config-independent): boot-time warmup** —
fire a large synthetic prompt at boot, ride out/retry the first stall, and only
then mark the engine ready. Converts the production failure mode (auto-heal reboot
→ next big dispatch wedges → task killed) into a bounded boot delay. Implemented
in mcp-qwen `ensureServerRunning` (it owns boot) — see next section.

(raw JSONL + dumps under `logs/<arm>/`)

## Interpretation rules (pre-registered before running)

- `full` wedges ≥3× AND `piecewise` = 0 wedges ⇒ D1 confirmed: FULL captured
  verify + prefix cache is the corruption source. Fix: force PIECEWISE.
- `full` wedges ≥3× AND `maxq4096` = 0 wedges AND `piecewise` still wedges ⇒
  materialize-route bug independent of graph capture. Fix: kernel patch +
  route change.
- `full` does NOT wedge ⇒ the production trigger is subtler than pure
  prompt-size + prefix hits (likely interaction with real goose tool-call
  shapes); extend the harness toward real transcript replay before claiming.
