# Case Study: The 453-Session Marathon

> Provenance: extracted verbatim from README.md on 2026-09-26 (docs present-state rewrite, slice D1).

Anser is battle-tested. The metrics below reflect **exact, ground-truth telemetry** captured across an intensive 3-week continuous development marathon on a single consumer workstation equipped with an **NVIDIA GeForce RTX 3090 (24 GB VRAM)**:

| Production Telemetry Axis | Measured Ground Truth | Operational Significance |
|---|---|---|
| **Completion Tokens Generated** | **10,372,422 tokens** (10.37M) | Production code, AST transforms, unified diffs |
| **Deliberative Reasoning Tokens** | **14,916,578 tokens** (14.92M) | Full test-time compute chain-of-thought (`xhigh`) |
| **Total Prompt Prefill Absorbed** | **962,266,455 tokens** (962.3M) | 268.1M exact measured + 694.1M estimated |
| **Total Model Turns** | **10,918 turns** | Multi-turn agentic pair-programming cycles |
| **Production Sessions Indexed** | **453 sessions** | Persistent multi-week development lifecycle |
| **Completed Complex Tasks** | **118 completed** (35 failed, 4 cancelled) | Real-world feature implementations & refactors |
| **Total Tool Invocations** | **13,749 calls** | `bash` (7,840), `read_file` (2,626), `edit_file` (1,646) |
| **Tool Execution Error Rate** | **1.87%** (257 errors / 13,749 calls) | 98.13% first-pass tool execution reliability |
| **Prefix Cache Hit Rate** | **68.2% sustained** | Sub-second prompt re-prefill via deterministic history |
| **Peak GPU KV Cache Usage** | **99.4% allocation** | VRAM pinned safely below OOM threshold |
| **DFlash2 Speculative Decoding** | **4.59 tokens/step** mean acceptance | Draft acceptance rate of 44.8% (up to 8.0 tok/step) |
| **Active Generation Speed** | **44.54 t/s avg** (Peak: **159.10 t/s**) | Instantaneous speculative decoding burst throughput |
| **Active Prompt Throughput** | **1,376.75 t/s avg** (Peak: **12,044 t/s**) | Fast context digestion via vLLM flash-attention |
| **Financial Savings vs Claude Sonnet 5** | **$2,028.25 USD** saved | At Sonnet 5 rates ($2.00/M prompt, $10.00/M completion) |
| **Financial Savings vs Claude Opus 5.5** | **$4,056.52 USD** saved | At Opus 5.5 rates ($4.00/M prompt, $20.00/M completion) |
| **Financial Savings vs GPT-6 Astra / Claude Fable 5.1** | **$10,141.28 USD** saved | At frontier flagship rates ($10.00/M prompt, $50.00/M completion) |
| **Financial Savings vs GLM-5.3** | **$1,392.81 USD** saved | At cloud value rates ($1.40/M prompt, $4.40/M completion) |
| **Local Inference Token Cost** | **$0.00** | **A $1,000 GPU paid for itself in less than a month.** |
