# LLM_Ecosystem

Local-first LLM delegation stack: Claude Sonnet 5 (in Claude Code / Antigravity)
orchestrates, a locally-served Qwen3.8-27B does the bounded implementation work
for free via a real agentic harness (Goose). Agent-facing rules live in
[CLAUDE.md](CLAUDE.md) (and its mirror at `~/.claude/CLAUDE.md`) and
[~/.gemini/GEMINI.md](file:///C:/Users/Apath/.gemini/GEMINI.md) for Antigravity —
this file is the human-readable map and model/architecture reference; it is not
loaded into any agent's context automatically.

## Layout

```
D:\LLM_Ecosystem\
├── CLAUDE.md              agent rules: serving mechanics, known limits, gotchas
├── README.md               this file
├── scripts\                 Windows-side launchers, one subfolder per model
│   │                         (reorganized 2026-08-24: grouped by model so
│   │                         alphabetical sort clusters related files instead
│   │                         of interleaving start/stop/status across models)
│   ├── status.bat             unified - checks BOTH models below (they share
│   │                           port 18020; only one is ever up at a time)
│   ├── main\                  the delegation model (MCP/Goose-wired)
│   │   ├── start.bat            default entry point -> start_huge.bat
│   │   ├── start_huge.bat        CTX=huge, 245,760 ctx, ~77-133 tok/s
│   │   ├── start_fast.bat        CTX=fast, 57,344 ctx, ~107-130 tok/s (rare)
│   │   └── stop.bat
│   └── uncensored\            manual/academic-use only, NOT MCP-wired
│       ├── download_model.sh    one-time GGUF fetch into WSL (already run)
│       ├── start.bat            reasoning on
│       ├── start_noreason.bat    reasoning off (-rea off)
│       └── stop.bat
├── llama-cpp\                native Windows CUDA build of llama.cpp (serves
│                             scripts\uncensored\ - vLLM can't load that
│                             model's GGUF architecture, see CLAUDE.md)
├── mcp-qwen\                the MCP server (Node.js) exposing the main model to any MCP client
│   ├── index.js               server implementation (ask_qwen, delegate_coding_task, ...)
│   ├── NOTES.md                full investigation history / rationale for every decision
│   ├── mcp_client_test.js
│   └── package.json
├── benchmarks\
│   └── swe-rebench\           Goose+Qwen validated against a contamination-resistant
│                               benchmark (SWE-rebench, not SWE-bench Verified/Pro -
│                               both retired by OpenAI for training-data leakage). See
│                               benchmarks/swe-rebench/README.md for the full pipeline.
├── .venv\                   standalone Open WebUI install (unrelated to the MCP
│                             stack - a browser chat UI for the same vLLM endpoint,
│                             not touched by anything in mcp-qwen or CLAUDE.md)
├── .webui_secret_key        Open WebUI's session secret
├── .mcp.json                empty ({"mcpServers": {}}) - MCP registration is done
│                             globally (Claude Desktop config / ~/.gemini config),
│                             not per-project; kept for compatibility, does nothing
└── .claude\                  Claude Code harness state (scheduled-task lock), not
                              hand-edited
```

The actual vLLM server, model weights, and all serving scripts for the main
model live outside this tree, in WSL Ubuntu at `~/qwen-serving` (a fork of
[syv-ai/qwen38-27b-rtx3090](https://github.com/syv-ai/qwen38-27b-rtx3090),
kept in sync via `git pull`). `mcp-qwen/index.js` and `scripts/main/*.bat` are
the Windows-side control surface for it.

The uncensored model's weights live in WSL at `~/qwen-uncensored/model/` (GGUF
files, no vLLM recipe involved), but are served by `llama-cpp\llama-server.exe`
running natively on Windows, not from inside WSL - see CLAUDE.md's "Second
model" section for why. It is a separate, manual-use-only model, not part of
the Sonnet→Goose→Qwen delegation path described below.

## Architecture

```
User <-> Claude Sonnet 5 (Claude Code / Antigravity, orchestrator)
             |
             | MCP: ask_qwen / delegate_coding_task (mcp-qwen/index.js, stdio)
             v
        Goose (block/goose, Rust binary) — spawned as a subprocess per call,
        real agentic loop: file/edit/shell tools + any attached MCP server
        (Playwright, gh CLI, free-search-mcp, ...)
             |
             | OpenAI-compatible /v1/chat/completions
             v
        vLLM server (WSL Ubuntu, port 18020) — Qwen3.8-27B, DFlash2 speculative
        decoding, KVarN 4/2-bit KV cache, prefix caching
             |
             v
        RTX 3090, 24 GB, 250 W power limit
```

Sonnet decomposes work into single-file/bounded tasks, dispatches them to Qwen
via Goose, and verifies the result against disk itself (Qwen never self-runs
build/typecheck/test — see CLAUDE.md's "Known limits"). This keeps Sonnet's own
token usage (the metered $20/mo resource) to planning, judgment, and
verification, while Goose+Qwen (free, local, uncapped) does the mechanical work.

## The model, quantization, and every script that built it

**Base model**: Qwen3.8-27B (Qwen3.5 architecture — hybrid Gated-DeltaNet /
attention, 65 layers, MoE-free dense), served from a pre-quantized W4A16
checkpoint (AutoRound, `Qwen3.8-27B-W4A16-AutoRound`), with `--language-model-only`
dropping the vision tower (not needed here, frees 2.7 GB).

**Why the published quant alone isn't servable on 24 GB**, and the one-time fix
(`prepare/`, run once, each step skipped if already applied — `bash verify.sh
--no-server` checks and names what's missing):
1. `quant_lm_head.py` — the 248k-row `lm_head` (2.5 GB bf16) → int8 group-128 in
   place. ~1.3 GB freed.
2. `quant_embed.py` — the untied `embed_tokens` matrix, likewise. Another ~1.3 GB.
3. `quant_mtp.py` — the shipped MTP speculative-decode draft module (~850 MB
   bf16) → int8.
4. `build_draft_vocab.py` — slices a 40,960-row subset of `lm_head` that the MTP
   drafter is allowed to propose from (`prepare/draft_vocab_ids.json`; a token
   outside this list is a guaranteed rejection that also truncates the
   speculation chain).
5. `fetch_fast_variant.py` / `fetch_dflash2.py` — optional downloads: the
   single-user "fast" variant (int4-GPTQ lm_head + drafter + a
   self-distilled draft vocabulary) and the DFlash2 block drafter. Both are
   rebuildable from scratch (that's what `drafter/` is), not just downloads.

**What `drafter/` actually built** (the "fast" variant, ~6h GPU time total),
in order of measured impact:
1. **Draft vocabulary counted over the model's own outputs**, not web text.
   `collect_prompts.py` (6.8k prompts across UltraChat/Magicoder/Danish
   instruction sets/reasoning/GSM8K) → `gen_data.py` (5.4M generated output
   tokens) → `capture.py` (hidden states, 74 GB memmap) → frequency-counted
   vocab. Coverage of what the model actually emits: 92.1% (old web-text list,
   83% on code) → 97.5% (96% on code). This alone: 98.0 → 108.6 tok/s greedy.
2. **GPTQ-calibrated int4** (not round-to-nearest) for `lm_head` and the MTP
   module, Hessians from 300k captured hidden states (`gptq_lm_head.py`,
   `requant_mtp_gptq.py`). Halves lm_head KL (0.0068 → 0.0029, +0.6% PPL vs
   bf16, GSM8K 96.5% unchanged) and keeps MTP acceptance intact. +1.8 ms/step
   (108.6 → 118.8 tok/s greedy).
3. **Fine-tuning the MTP head itself: tried, kept as a documented negative
   result.** Distillation training (`train_mtp.py`) halves KL on the naive
   metric but true-token top-1 agreement on response tokens is unchanged
   (0.685 → 0.685) — Qwen's shipped head is already at the ceiling a
   single-layer chain drafter can reach for greedy top-1 on this data. Not
   used in the served model.

**Speculative decoding — two drafters, selectable per boot:**
- **MTP** (shipped, `SPEC=mtp`): the int4-GPTQ-requantized single-layer chain
  drafter above, 4 draft tokens, draft-vocab-scoped, split-KV verify attention
  patch + small-topk/fast-softmax sampler patch (`docs/optimizations.md`).
- **DFlash2** (`SPEC=dflash2`, [Inco, Aug 2026](https://inco.ai/blog/dflash2/),
  backported via vLLM PR #52816): a separate 1.92B-parameter, 5-layer
  non-autoregressive block drafter that predicts a whole 7-token block per
  pass from the target's own layer 5/19/33/47/61 hidden states, plus a
  16-candidate path selector, quantized to ~1.0 GB (`quant_dflash2.py`).
  4.80 tokens/step reported vs MTP's 4.28 at the same block size. This is
  the model actually running (`CTX=huge` defaults to it) — faster than MTP
  up to ~8k tokens of context, MTP slightly ahead past that.
- **Lookup-augmented drafting** (`VLLM_DFLASH2_LOOKUP*`, on by default): when
  the model is reproducing something already in its own context (quoting,
  editing), it proposes the continuation of the most recent earlier
  occurrence directly — free draft tokens, verify block grows past the
  drafter's own 7 while a "copy" is detected. 260 → 381 tok/s reproducing a
  document verbatim.

**KV cache — KVarN, why `CTX=huge` exists at all:** Qwen3.8-27B's full
262,144-token context needs a KV cache smaller than fp8 allows on 24 GB (fp8:
16 attn layers × 4 KV heads × 256 dims × 2B ≈ 2 KB/token/layer, caps out
around 150-195k tokens). [KVarN](https://github.com/huawei-csl/KVarN) (Huawei
CSL, Apache-2.0) — Hadamard rotation + iterative variance normalization,
4-bit keys / 2-bit values per 128-token tile, ~840 B/token/layer — is ported
onto this repo's vLLM 0.27.1 in `kvarn/` (dense/non-MLA path only; upstream
ships against vLLM 0.23). Result: 268,169-token pool at 245,760 max-model-len
on the same pinned 5.26 GiB budget that fp8 gets ~150k out of. Cost: a real
decode tax that scales with context length — ~6% at short single-user
prompts, 1.22x in batch mode at 100k, **2.13x in single-user mode at 112k**
(measured: 32.0 vs 68.1 tok/s, MTP-3, real single-stream test) — about half
of which is raw step time from the wider dequant path, the rest is ~7% fewer
accepted draft tokens (quantization noise shifts the target's logits enough
that the draft head agrees less often). Prefill is unaffected either way.
`CUDAGRAPH_MODE`: `SPEC=dflash2 CTX=huge` runs `FULL_AND_PIECEWISE`
(upstream swept all 128 residues, zero broken — genuinely safe here, and
faster: 96.5% vs 95.0% GSM8K, better under GPU passthrough); `SPEC=mtp
CTX=huge` is forced to `PIECEWISE` for correctness (a confirmed empty-answer
bug under FULL at one specific residue in 128 that dflash2 doesn't share).

## Measured throughput (this box, RTX 3090 @ 250W, `CTX=huge`, `SPEC=dflash2`, `KVarN k4v2`, `PREFIX_CACHE=1`)

**Decode, single-user, C1 (one request):**

| variant | tok/s | tokens/step |
|---|---|---|
| default (`DFLASH_TOKENS=7`, lookup on) | 130 | 3.3 |
| reproducing context (copy/quote) | up to 259 | 3.3-7.8 |
| `DFLASH_TOKENS=15` reproduction mode | 133 short-prompt, up to **381** reproducing | 3.4-15.0 |

**Six-task real-prompt suite, WSL2, `SPEC=dflash2 CTX=huge PREFIX_CACHE=1`:**

| task | tok/s | tokens/step |
|---|---|---|
| copy/reproduction | 130 | 7.8 |
| code | 89 | — |
| edit | 65 | — |
| quote | 44 | — |
| summary | 38 | — |
| qa | 36 | — |
| **all six together** | **53** | **3.0** |

**Prefill (prompt processing, separate budget from decode — KVarN vs fp8
"same within ±5%", so this applies to `CTX=huge` too):**

| input length | tok/s | single-request TTFT |
|---|---|---|
| 1k | ~1,741-1,812 | 0.56-0.85 s |
| 16k | ~1,569-1,595 | 10.3-14.7 s |
| 100k | ~997-1,050 | 103-129 s |

Concurrency does nothing for prefill — chunked prefill shares one
2,048-token-per-step budget across the whole server, so it's a fixed resource,
not something that parallelizes.

**Real single-stream long-context number** (MTP-3, 112,648-token prompt,
`PREFIX_CACHE=1`, KVarN): 32.0 tok/s decode (31.3 ms/token), TTFT cold 146.7s,
KV pool 292,035 tokens at that context length.

**KV pool ceiling**: 268,169 tokens at `MAX_SEQS=8` (and at 2 and 4 — live
reverified at every step 2026-08-24, unchanged; raising `MAX_SEQS` only grows
one-time CUDA-graph-capture boot cost, not the pool or per-request throughput).

## Benchmarking the MCP delegation architecture — recommended method

**Superseded 2026-08-24 — do not use SWE-bench Verified or SWE-bench Pro.**
Both were the initial recommendation here; both turned out to be
contaminated. OpenAI retired SWE-bench Verified in Feb 2026 after an audit
found 59.4% of its "hard" tasks flawed and frontier models reproducing gold
patches **verbatim from the task ID alone** (10.6% documented leakage) — a
training-data fingerprint, not a capability signal. SWE-bench Pro was
scrapped by the same team ~5 months later for the identical failure mode
(~59% flawed tasks, memorized answers on "nearly impossible" tasks). Neither
can answer "does my setup actually work" — they measure memorization.

**The actual answer: [SWE-rebench](https://swe-rebench.com/)** (Nebius) —
its `nebius/SWE-rebench-leaderboard` HF dataset rebuilds its eval set every
month from real GitHub issues, published as monthly splits. A model can't
have memorized a month's issues if they postdate its training cutoff, which
March 2026 (`2026_03`, the latest split published as of this writing) safely
does for both Qwen3.5 (released Feb 2026) and Sonnet 5 (Jan 2026 cutoff).
Docker-graded, real agentic issue resolution — a much better match for
Goose's actual file/edit/shell loop than SWE-bench's static-patch format.
Public leaderboard reference points (best-of-5 Resolved Rate, Aug 2026):
Claude Opus 4.6 65.3%, and — same architecture family as what's served
here — **Qwen3.5-35B-A3B 53.7%**.

**Done: [benchmarks/swe-rebench/](benchmarks/swe-rebench/) — 32.0% Resolved
Rate (16/50), best-of-1**, 44% of the sample never got a solve attempt
within the 900s per-task budget (57.1% among the 28 that did get attempted
- the more informative number, since the timeout is a tunable knob, not a
capability ceiling). See [results/results.md](benchmarks/swe-rebench/results/results.md)
for the full breakdown, including an honest log of five real bugs (two in
the solve script, three in the grading path — one of them upstream, in
SWE-rebench's own `eval.py`) found and fixed before this number could be
trusted; the first two grading attempts produced a false 0% before the
root cause (a wrong hardcoded container path in the upstream eval tool)
was found via direct container inspection rather than accepted at face
value.

**Separately** — if the delegation-architecture question (is Sonnet
decomposing + Qwen executing actually worth it, vs either extreme) becomes
the priority later, SWE-rebench's single-agent-solves-the-whole-issue format
doesn't map cleanly onto that either; it would still need a small custom
task set run three ways (Sonnet solo / Sonnet-decomposes-Qwen-executes /
Qwen alone undecomposed) as originally scoped, just against real
undecomposed SWE-rebench issues as the task source instead of a hand-picked
set.

Sources:
- [OpenAI: why SWE-bench Verified no longer measures frontier capability](https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified/)
- [SWE-rebench leaderboard](https://swe-rebench.com/)
- [nebius/SWE-rebench-leaderboard dataset](https://huggingface.co/datasets/nebius/SWE-rebench-leaderboard)
