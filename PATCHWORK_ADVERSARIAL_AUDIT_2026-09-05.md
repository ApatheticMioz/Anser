# Patchwork × DeepSeek-AVO — Adversarial Architectural Audit

**Date:** 2026-09-05 · **Auditor:** Autonomous Execution Coworker (Qwen3.8-27B, DeepSeek-AVO harness)
**Scope:** Finalization of `deepseek-avo` integrating the FAST-NUCES FYP "Patchwork: A Controlled Factorial Study of Structural Retrieval, Editing, and Repair in LLM Coding Agents" (Ali, Aamir, Kiani) — three structural interventions (M1–M2 RepoGraph/CodeKG retrieval, M3 CodeStruct/ast-grep editing, M4 TraceCoder/SHERLOC repair) into the embedded Cordis-microkernel + NVIDIA-AVO harness in `mcp-qwen`.
**Method:** Source-level read of every module in `mcp-qwen/src/harness/` + `mcp-qwen/*.js`; `node --check` on all harness modules (all pass); cross-reference against `QWEN_AVO_AUDIT.md`, `AUDIT_2026-09-05.md`, `benchmarks/swe-rebench/`, `benchmarks/wedge-repro/`, and the live `.avo/lineage.json`. **No file was modified during this audit.**

> **Verification caveat (stated up front):** The `bash` tool in this session executes under Windows `cmd`, not WSL, so I could **not** run the live vLLM test suite (`test_deepseek_avo.js` Test 6) or any WSL command. I verified all harness modules parse cleanly (`node --check` → all OK) and rely on the recorded 6/6 pass from `QWEN_AVO_AUDIT.md` §0 for the live-streaming claim. Every code-level claim below is grounded in a file I actually read, with file:line references.

---

## 0. Executive Verdict

**The embedded `deepseek_avo` harness is the correct substrate, and Patchwork's three structural interventions are directionally right — but the FYP's *specific* instantiations (full CodeKG property graph + PPR, model-emitted AST selectors, raw-traceback slicing) are each over- or mis-specified for a single-GPU (24 GB), 9p-I/O, 1-slot-vLLM local stack.** The adversarial findings, in one line each:

1. **Embedded > official DSH** is correct on IPC, process-lifecycle, and evolutionary-loop coupling — *but* the win is conditional on the embedded harness's own latent bugs (H1 process-tree kill; the wedge detector that was deleted in `de01aa9` and only partially restored) being closed, because embedding *concentrates* those failures in one process rather than distributing them.
2. **AST editing (M3)** is sound *only if the AST is a harness-side symbol→node resolver, not a model-facing selector interface.* A 27B model cannot reliably emit tree-sitter node-type taxonomies; making it do so causes prompt bloat + selector hallucination. The fallback ladder (AST → exact-text → full-rewrite) with a **parse-validity gate (not precondition)** is the correct design.
3. **Structural retrieval (M1–M2)**: full CodeKG+PPR is **over-engineered** for this deployment. Tree-sitter parsing is cheap; the property-graph *resolution* + *incremental PPR update* on a 9p-mounted drive is the real cost, and it competes with DFlash2/KVarN *indirectly* (via injected-subgraph prefill → TTFT → KV-pool), not directly. A **lazy incremental symbol index + on-demand AST slicing** captures ~80% of the navigation value at ~10% of the cost.
4. **Structural repair (M4)**: the current `evaluator.js` does **no** traceback→frame mapping at all (it slices raw stderr). TraceCoder's value is real but its failure modes (xdist interleaving, third-party top frames, recursion, silent hangs) are exactly the ones a naive "take the top frame, slice 30 tokens" implementation gets wrong. The repair context must be a **bounded, evicted, separate message** — never appended to the growing conversation — or it starves the 1-slot KV pool.

**Net recommendation:** Adopt all three interventions, but in the *harness-resolved* forms specified in §5, phased so that each is independently A/B-testable against the current raw-text baseline on the SWE-rebench `2026_03` split (the contamination-resistant set already in `benchmarks/`). Do **not** build the full CodeKG+PPR graph before the symbol-index baseline is measured.

---

## 1. Official DeepSeek Harness (`dsh`) vs. Embedded `deepseek_avo`

### 1.1 What the official `@deepseek-ai/dsh` actually is

`dsh` is a **standalone CLI daemon** (`npx dsh web` → web UI on `:3080`). It is a separate OS process that owns: its own agent loop, its own tool registry, its own session store, and its own model-provider client. It is a *general-purpose* coding agent with a web front-end. It is **not** an evolutionary engine and has no built-in propose→mutate→evaluate→select closed loop.

### 1.2 Why embedding Cordis + AVO into `mcp-qwen` is architecturally superior (concrete, per-axis)

| Axis | Official `dsh` daemon | Embedded `deepseek_avo` (this harness) | Why embedded wins on a 24 GB / 1-slot stack |
|---|---|---|---|
| **IPC per tool call** | model → dsh loop → dsh spawns subprocess (shell/file) → serialize output → feed back. A process boundary + serialization on *every* tool call. | `Context.executeTool()` is an **in-process function call** (`kernel.js:117-135`). Zero IPC, zero serialization, zero spawn. | A tight AVO loop is dozens of propose→evaluate iterations. The per-iteration subprocess-marshalling tax of a separate daemon is pure latency that compounds. |
| **Process lifecycle** | **Two** process trees: the MCP server's *and* dsh's. Cancellation must cross the boundary (MCP → dsh → dsh's children). A wedged dsh daemon is **invisible** to the MCP watchdog. | **One** process tree: the MCP server process owns the runner, shell executor, and AVO operator. `killProcessTreeSync` / `taskkill /T /F` (`wsl_bridge.js:129-162`) reaches everything. | The 2026-08-28/29 wedge incidents and the "MCP shutdown kills nothing" finding (`AUDIT_2026-09-05.md` §4.4) are *worse* with a second daemon in the middle. One tree = one kill path. |
| **Evolutionary-loop coupling** | AVO state (lineage DAG, snapshots) must be **externalized** to dsh and **re-imported** across the boundary each iteration; dsh's own turn-budget/context-management/retry logic fights the tight cadence. | `AvoOperator` holds `LineageDag` + `ClosedLoopEvaluator` + `AvoWatchdog` **in the same process, same Cordis context** (`avo_operator.js:20-32`). The fitness from `evaluateCandidate` is a direct in-memory value consumed by `selectCandidate`/`revertCandidate`. No serialization, no re-hydration, no state drift. | The *entire point* of AVO is a tight closed loop. In-process state means the fitness signal is a variable, not a message. |
| **GPU / KV-pool pressure** | dsh issues its **own** requests (canaries, its own agent turns, tool-call preambles) to the same 1-slot vLLM. This fragments the 268,169-token KV pool and the prefix cache, and adds unpredictable prefill load — the exact trigger of the "first large chunked-prefill after boot" wedge (`wedge-repro/RESULTS.md`). | The harness issues **exactly** the requests the AVO loop needs, through the **same** stream proxy (`:18022`), with a **stable `session_id`** per milestone → prefix-cache hits at 8–9k tok/s, <0.5 s wakeup (README §6). | On a `MAX_SEQS=1` engine with a single 268k-token KV pool, *any* extraneous request stream is a wedge risk. The embedded harness is the only request source. |
| **Session / KV continuity** | dsh has its **own** session store (its own format/SQLite). Bridging to the harness means either re-reading the whole transcript (defeats prefix cache) or maintaining **two divergent session stores** — the exact "two goose binaries, two session stores" problem (`AUDIT_2026-09-05.md` §3.6). | One append-only JSONL ledger (`events.jsonl`, `event_logger.js`) + one `.avo/lineage.json`. The Lead Architect reads both directly. | One source of truth. The modular refactor's whole value (`DEEPSEEK_AVO_PROGRESS.md` §1) is replacing "opaque SQLite sessions.db" with a readable ledger. |
| **Observability** | dsh's opaque session store + the MCP server's ledger = **two** ledgers to reconcile. | One ledger + one lineage DAG, both on disk, both readable by the Lead Architect. | The audit's recurring theme is *drift between two sources of truth*. One ledger eliminates the class. |

### 1.3 Concrete DSH shortcomings for local single-GPU high-throughput (the adversarial list)

1. **IPC tax compounds in the evolutionary loop.** Every AVO iteration is ≥2 tool calls (mutate + evaluate). At 20–50 iterations, that's 40–100 extra process-boundary round-trips vs. zero in-process calls.
2. **Cross-boundary cancellation is unreliable.** The MCP server's `cancelAllTasks` (`task_registry.js:144-199`) kills *its own* tree. It cannot reach dsh's children. A cancelled AVO candidate leaves dsh's subprocesses orphaned — the H1 class of bug, now *unreachable* by the watchdog.
3. **The evolutionary loop is not dsh's native paradigm.** dsh is a general agent with a turn budget; AVO is a *population* process with a lineage DAG. Forcing AVO through a general agent loop means the "select/revert" decision is made by the model (nondeterministic) rather than by the deterministic `avo_operator` fitness gate. The whole "deterministic rollback" guarantee (`avo_operator.js:169-239`) is lost if the decision crosses into a general agent's discretion.
4. **GPU fragmentation.** dsh's own canary/heartbeat/agent traffic adds prefill load to a 1-slot engine. The wedge-repro showed the stall is a *first-large-prefill-after-boot* event that is **config-independent** — adding a second, unpredictable request source raises its probability.
5. **Two session stores diverge** (see §1.2), breaking the milestone-session prefix-cache protocol (README §3.5).

### 1.4 Adversarial honesty — where DSH is actually fine, and the embedded harness's own preconditions

- If the goal is a **general** coding agent with a **web UI** (not a tight AVO loop), `dsh` is fine and gives you a UI for free. The embedded harness has no UI; the Lead Architect talks to it over MCP stdio.
- `dsh` may ship **better-maintained** tool implementations (LSP, etc.) upstream. The embedded harness's tools are hand-rolled and carry the latent bugs in `QWEN_AVO_AUDIT.md`.
- **Embedding does not make the embedded harness's own bugs go away — it concentrates them.** The two preconditions for the "embedded > dsh" verdict to hold:
  - **H1 (process-tree kill) must be fixed.** `QWEN_AVO_AUDIT.md` §3.2/H1: `spawn` without `detached:true` means `process.kill(-pid)` throws and only the direct child dies → orphaned grandchildren on timeout, *especially* for WSL (separate PID namespace, `taskkill /T` can't reach it). The current `shell_executor.js:63-68` spawns **without** `detached:true`, and `execute()` calls `killProcessTreeSync(child)` **without** a `sessionId` (`shell_executor.js:74`), so the WSL `pkill -f` branch is **dead** in this path. This is the single biggest safety gap, and it is *worse* when concentrated in one process.
  - **The wedge detector must be present.** `AUDIT_2026-09-05.md` §4.1 found it **deleted in `de01aa9`**. I verified the modularized `src/server_lifecycle.js` **does** contain `canaryProbe` (58-96), `engineWedgeState` (148-178), `healWedgedEngine` (180-200), and the pre-dispatch gate in `ensureServerRunning` (264-289) — so it appears **restored** in the `076456b` modular refactor. **This is a doc/code discrepancy the audit should close:** `AUDIT_2026-09-05.md` §4.1 and the README §4 still describe the *deleted* state. Confirm `de01aa9`'s removal was fully superseded by `src/server_lifecycle.js`, or the "self-heals instead of hanging" claim in the `qwen_server` tool description (`tools.js:394`) is false.

**Verdict §1:** Embedded is the right call *for the AVO use case*, and the IPC/lifecycle/loop arguments are sound. But it is a **conditional** win: it is only as safe as the H1 process-tree kill and the wedge detector, both of which must be verified closed before unattended autonomy.

---

## 2. Adversarial Attack on Structural AST Editing (M3 — CodeStruct / ast-grep / LibCST)

### 2.0 Current baseline (what we're attacking)

`edit_file` (`sandbox_fs.js:117-147`) is **exact-text search-and-replace**: `original.split(target_content)`, then `.replace`/`.replaceAll`. `write_file` is full overwrite. There is **no** AST, no node resolution, no parse validation. This is precisely the "raw text diffs" Patchwork criticizes — and it is the baseline the FYP's M3 must beat.

### 2.1 Where pure AST editing breaks down in messy real repos

1. **Syntax-invalid *intermediate* states — the AVO-specific trap.** M3's "mandatory compile/parse validation before committing mutations" sounds safe, but it mislocates the failure. AVO's whole point is to *propose a possibly-wrong mutation, then evaluate it*. If parse-validity is a **precondition**, the operator rejects any edit that is transiently invalid. Worse: a **multi-file** mutation (change a signature in `A.py`, update callers in `B.py`) is *individually* parse-valid per file, but the **cross-file type contract is broken** until all edits land. Per-file parse validation gives **false confidence** — each file parses, the build is broken. Parse validation must be a **gate on the committed result** (reject + bounce the error back to the model), not a precondition on each edit, and it must be **whole-program** (typecheck/build), not per-file, to catch cross-file breaks.

2. **Macro / decorator / metaprogramming-heavy code.** Tree-sitter gives **syntax, not semantics**. A `@decorator` is a syntactic node; whether it *transforms* the function (arity-changing `@staticmethod`, `@property`, a custom decorator, `@functools.wraps`) is invisible to the AST. C preprocessor `#define`, Rust `#[derive]`/`#[macro]`, Python metaclasses, `__getattr__`/`__getattribute__` dynamic attribute resolution, `exec`/`eval`, `importlib`, `getattr`-dispatch — all are syntactically present but semantically opaque. An AST "replace the function" that ignores the decorator's effect produces a **parse-valid but semantically broken** result. LibCST (concrete-syntax-tree) preserves *formatting* but does **not** resolve what a decorator does. This is the fundamental limit: **AST is a static approximation of a dynamic language.**

3. **Docstring / comment / formatting preservation.** This is M3's genuine strength (LibCST preserves formatting). But adversarially: the moment the agent's mutation is expressed as *new code text*, the tool must **re-serialize** it, and re-serialization normalizes quote style, trailing commas, line width, and — critically on **this** workspace — **CRLF line endings** (the repo uses CRLF; `sandbox_fs.js` S7 in the audit notes `split("\n")` leaves a trailing `\r`). A re-serialized edit produces a **noisy diff** (every line touched by a quote-style change) that the AVO snapshot/rollback then has to carry. For a polyglot repo you need **four** CST engines (JS/Python/Rust/Go), each with different preservation guarantees — the "structural" win shrinks to whatever fraction of files the grammar covers.

4. **Multi-language polyglots.** The SWE-rebench `2026_03` split is Python-only, but **this** repo is polyglot: JS (`mcp-qwen`), Python (`avo_runner.py`, `qwen-serving`), bash (`.sh`), Windows `.bat`, JSON, YAML, TOML, Markdown. A single CodeKG/ast-grep pipeline must dispatch to the right grammar per file. ast-grep supports many languages but node-type coverage varies. The FYP's 2×2×2 factorial is presumably single-language; the real-world "structural" benefit is bounded by grammar coverage.

5. **Dynamic runtime constructs.** Python `**kwargs`/`*args`, `functools.partial`, monkey-patching, `sys.modules` manipulation; JS `Proxy`, `Object.defineProperty`, `__proto__`, dynamic `import()`, template-literal codegen. The AST shows the **static** shape; the **runtime** shape differs. An AST-based "find all callers of X" **misses dynamic dispatch**. This is not a bug to fix — it is the ceiling of static analysis.

### 2.2 Can the agent express AST replacements without prompt bloat / hallucinated selectors?

**No — not if the model is asked to emit raw AST selectors.** This is the sharpest adversarial point, and the FYP under-weights it:

- **Selector hallucination.** To do ast-grep / tree-sitter surgery, the model must emit a **node-type selector** (`function_declaration > parameters > parameter[0]`). Node-type taxonomies **differ by language and by tree-sitter version** (`function_declaration` vs `function_item` vs `method_definition`). A 27B model is **not** reliable at emitting exact tree-sitter node-type names. This is a measurable, recurring failure mode, not a theoretical one.
- **Prompt bloat.** To let the model emit a *valid* selector, you must inject the grammar's node-type taxonomy into the prompt — **hundreds of node types per language**, thousands of tokens per turn. On a 245K/DFlash2 1-slot engine, that is pure prefill cost (100k tokens → 103–129 s TTFT per README §6) that buys a selector the model will often get wrong.

**The architectural resolution (the key insight):** **The AST is a harness-side *symbol→node resolver*, not a model-facing interface.** The model talks in **symbols** it already knows — function names, file paths, "the return type of `compute` in `algo.mjs`." The **harness** deterministically resolves symbol → unique AST node (name lookup in the file's parsed tree) → applies the edit → parse-gates the result. The model **never sees the selector taxonomy.** This eliminates both prompt bloat (no taxonomy in the prompt) and selector hallucination (the harness, not the model, picks the node). It is the same "harness resolves, model intends" pattern the existing `avo_propose_candidate` already uses (the model gives a `hypothesis` + `files_to_modify`, the harness does the snapshotting).

### 2.3 Graceful fallback when AST matching fails (the ladder the FYP must specify)

The FYP says "mandatory parse validation" but does **not** specify what happens when the *match* fails. The correct ladder, tried in order, all protected by the AVO snapshot:

1. **AST node edit** — *if* (a) the grammar covers the file, (b) the symbol resolves to **exactly one** node, and (c) the re-serialized result **parses**. → commit.
2. **Ambiguous match (N>1 nodes)** — do **not** guess. Return the candidate nodes with `file:line` to the model and require a more specific symbol. (Guessing here is how you corrupt the wrong overload.)
3. **Zero matches / grammar doesn't cover the construct** → fall back to **exact-text search-and-replace** (the current `edit_file`). This is the safe, always-available rung.
4. **Edit produces a parse-invalid result** → **reject**, return the parse error to the model, **do not write to disk**. (Gate, not precondition — §2.1.1.)
5. **Full-file rewrite** — last resort, highest risk, only when the model explicitly requests it.

Each rung is independently AVO-snapshotted, so a bad rung-1 edit is rolled back to the rung-3 state deterministically. The fallback ladder is what makes M3 *robust* rather than *brittle* — and it is the part the FYP's "controlled factorial" framing (which assumes the AST path always works) does not address.

**Verdict §2:** M3 is sound **only** in the harness-resolved form (model emits symbols, harness resolves to nodes, parse-gate, 5-rung fallback). Model-emitted raw AST selectors are a dead end on a 27B model. The current exact-text `edit_file` is the correct *fallback rung*, not the thing to replace wholesale.

---

## 3. Adversarial Attack on Structural Retrieval (M1–M2 — RepoGraph / CodeKG / LSP)

### 3.0 Current baseline

`search_code` (`sandbox_fs.js:189-238`) is `git grep -n -I --max-count N` with a raw-text walk fallback. **No graph, no PPR, no LSP, no symbol resolution.** This is the "unstructured grep" Patchwork criticizes — and it is the baseline M1–M2 must beat.

### 3.1 CPU / RAM / latency of a Tree-sitter property graph on 50k–200k LOC in a tight AVO loop

Decompose the cost honestly — the FYP conflates three different costs:

- **Tree-sitter *parsing* is cheap.** ~1–10 MB/s/core; 200k LOC (~6–10 MB) parses in well under a second single-threaded, a few hundred ms multi-threaded. **Not the bottleneck.**
- **Reference *resolution* is the real cost.** Building the property graph (nodes = functions/classes, edges = calls/imports/inheritance) requires **resolving** each call `foo()` to the definition of `foo` — a whole-repo symbol table. For 200k LOC / ~50k functions, the call graph can have **millions of edges** → **hundreds of MB to GBs of RAM**.
- **PPR is an iterative power method**, O(iterations × E). For a multi-million-edge graph, each query is tens of ms to a few hundred ms. Fine for a one-shot; **not** fine if re-run on *every* AVO iteration.
- **The killer is the *update*, not the build.** In a tight AVO loop you mutate a file, then re-query. If you **rebuild the whole graph** after every mutation, that's O(repo) per iteration — 50k–200k LOC re-parsed + re-resolved + re-PPR'd, dozens of times. The FYP **must** do **incremental** updates (re-parse only the changed file, re-resolve only affected symbols, local PPR update). Incremental tree-sitter is easy; **incremental PPR is hard** (re-run the power method or use a local approximation).
- **The 9p-I/O wrinkle the FYP ignores.** This workspace is a **9p-mounted Windows drive** (`/mnt/d`) from WSL. The audit's entire DrvFs-stall concern (`DEEPSEEK_AVO_PROGRESS.md` §1, `AUDIT_2026-09-05.md` §3.1) is that **reading many small files over 9p is slow**. If the CodeKG indexer runs in WSL reading from `/mnt/d`, **I/O is the bottleneck, not parsing.** If it runs on the Windows side (native NTFS, fast), the graph lives in a Windows process and the AVO loop is in… where? The FYP does not address *where* the indexer runs relative to the 9p boundary.

### 3.2 Does PPR compete with Qwen's 245K context / DFlash2 throughput?

- **Not directly.** PPR is a **CPU-side** graph computation; it does not touch the GPU or the KV cache. It runs on the CPU while the GPU is idle (mutate phase) or busy (evaluate phase). **No VRAM contention.**
- **But there is an *indirect* competition, and it is the real one.** PPR subgraph extraction produces a **set of code slices injected into the model's prompt**. If PPR returns a 50k-token subgraph, that's 50k tokens of **prefill** on a 1-slot engine with a 268k KV pool. At 100k tokens, **TTFT is 103–129 s** (README §6 measured table). So a **fat PPR subgraph directly inflates TTFT and eats the KV pool**, competing with DFlash2 decode. The FYP's M4 "30-token context slices" is the right instinct — but PPR's *value* is returning a **rich, ranked** subgraph; truncating to 30 tokens throws away most of the ranking. **The tension is real: PPR wants a rich subgraph; the 245K/DFlash2 constraint wants a tiny one.**
- **The resolution:** PPR (or a cheaper centrality) **ranks**, but you inject only the **top-K node *signatures*** (name + file:line + one-line summary), **not full bodies** — a **map, not a territory**. The model then does targeted `read_file` on the specific nodes it cares about. *This* is the "semantic navigation" the FYP wants: PPR gives the **map** (which functions are relevant, ranked); the model **walks the map** with cheap reads. It keeps the injected context small (a few hundred tokens of signatures) while preserving the navigation benefit.

### 3.3 In-process module vs. external stdio MCP vs. on-demand slicing

| Option | Latency | Isolation | Memory | Fit for this stack |
|---|---|---|---|---|
| **In-process** (`@ast-grep/napi` / `web-tree-sitter`) | Lowest (no IPC) | **None** — a native-parser crash takes down the whole MCP server (the `EADDRINUSE`-crash class in `NOTES.md`) | Graph in the MCP server's heap → **unbounded growth** over a long session | Good for cheap per-file ops; dangerous for a persistent whole-repo graph |
| **External stdio MCP** (`code-graph-mcp`, `mcp-language-server`) | **stdio IPC per query** — the *exact* IPC tax §1 argues against | Good (parser crash isolated) | Graph in a separate process | **Self-defeating**: reintroduces the two-process-tree + IPC problem we left dsh to avoid |
| **On-demand AST slicing** (no persistent graph) | Low | Good | **Lowest** (parse the specific file on demand) | Loses cross-file callers/callees — the whole point of CodeKG |

**My recommendation — a hybrid that fits the deployment:**
- **In-process `@ast-grep/napi`** for the cheap per-file operations (parse, find-node-by-name, extract-slice). The NAPI binding is stable; per-file parsing is fast; no persistent graph in the heap.
- **NO persistent whole-repo property graph in the hot path.** Instead: a **lazily-built, incrementally-updated symbol index** — a small **JSON file on disk** (`file → [symbols]`, `symbol → [def sites, ref sites]`) built once per session and updated on file writes.
- **Approximate the call graph** with a **text-level reference index** (grep the symbol name, filter to call/def sites with a light AST check) rather than a fully-resolved property graph. This gives **~80% of CodeKG's navigation value at ~10% of the memory/update cost**, and it **survives the 9p-I/O constraint** because the index is a small JSON file, not a multi-GB in-memory graph.
- **Replace PPR** with a simpler **O(V) centrality heuristic** (in-degree + name-relevance to the hypothesis). PPR's marginal ranking benefit does not justify its O(iterations×E) cost and incremental-update complexity on this stack.

**Verdict §3:** The FYP's full CodeKG+PPR is a **research artifact** that does not fit a single-GPU, 9p-I/O, 1-slot local stack. The *navigation value* is real and worth capturing, but via a **lazy incremental symbol index + on-demand AST slicing + O(V) centrality**, not a persistent property graph + PPR. The external-stdio-MCP option is **self-defeating** (reintroduces the IPC tax). Build the symbol-index baseline first and **measure it against raw `git grep` on SWE-rebench before** investing in anything heavier.

---

## 4. Adversarial Attack on Structural Repair (M4 — TraceCoder / SHERLOC)

### 4.0 Current baseline (what we're attacking)

`evaluator.js` (`parseMetrics`, 58-111) **regex-parses** pytest (`"X passed, Y failed"`), jest (`"Tests: …"`), and go (`--- PASS/FAIL:`), then `calculateFitness` (116-139) produces a scalar. `evaluate()` (30-53) slices `stdout`/`stderr` to **8000/8000** chars; `avo_operator.evaluateCandidate` (131-132) re-slices to **2000/2000**. **There is no traceback→frame mapping, no third-party-frame filtering, no localized AST slice.** The model gets raw stderr. This is the "noisy tracebacks" Patchwork criticizes — and it is the baseline M4 must beat.

### 4.1 Failure modes of parsing pytest/unittest tracebacks

1. **pytest-xdist mangled stdout.** With `-n auto`, output is **interleaved across workers**; `--tb=short`/`--tb=long`/`--tb=line` produce different shapes; the "short test summary info" section is **separated** from the full tracebacks. A regex that matches the *first* "Traceback" grabs the **wrong frame**. The current `evaluator.js` does not handle xdist at all. (The SWE-rebench `test_cmd` uses `--tb=line` — see `sample_2026_03_50.jsonl` — so the *grading* path is already in the fragile `--tb=line` format.)
2. **Assertions inside third-party libs / fixtures.** The **top** frame of a pytest traceback is often in `site-packages` (a library) or a `conftest.py` **fixture**, **not** the user's code. The FYP's "30-token localized slice" must **skip library frames** and find the **first frame in the user's repo**. Naively taking the top frame injects 30 tokens of `numpy`/`pandas` internals, **not** the user's bug. The current `evaluator.js` does **no** frame filtering — it slices raw stderr.
3. **Recursion limits / huge tracebacks.** A `RecursionError` or deep call produces a **2000-frame** traceback. Slicing to 2000 chars gets the *last* or *first* 2000 chars — neither is necessarily the useful frame. You need the **"interesting" frame**: the first user-code frame from the top, or the frame where the exception was *raised* (the bottom of the user-code span), not the top of the library span.
4. **Silent hangs without tracebacks.** The wedge-repro and the 2026-08-28 incident are **exactly this**: the process hangs, **no traceback**, just silence. TraceCoder **cannot parse a traceback that does not exist.** The current `evaluator.js` handles it via the timeout (exit 124) but **conflates it with test failure** (E3 in `QWEN_AVO_AUDIT.md`: "timeout is conflated with test failure… indistinguishable in the DAG"). A **hang** and a **failed test** need **different** repair strategies: hang → "your code has an infinite loop / deadlock; here's the last function entered"; failed test → "here's the assertion that failed + the 30-token slice."
5. **Non-pytest runners.** The harness runs `npm test`, `pytest`, `go test`, `node test.js`. Each has a different failure format. The current regexes cover pytest/jest/go; a "structural" TraceCoder needs a **parser per runner**, and the FYP's 2×2×2 is presumably **pytest-only**.

### 4.2 Bounding the repair-prompt token budget without starving the evolutionary search

- The FYP's "30-token slice" is a good target for the **localized slice**. But the repair prompt also needs: the failing test name, the assertion message, expected-vs-actual, and the 30-token slice → **~100–200 tokens total**. That is fine *in isolation*.
- **The starvation risk is accumulation.** If you inject the repair context into the **same** prompt that carries the lineage history + hypothesis + system prompt, **every** AVO iteration, the context **grows monotonically**. This is R2 in `QWEN_AVO_AUDIT.md` ("unbounded message history → context overflow"). On a 245K/DFlash2 1-slot engine, a 100k-token prompt has **103–129 s TTFT** and eats the 268k KV pool.
- **The budget rules:**
  1. **Localized slice ≤ 200 tokens** (30-token slice + test name + assertion + expected/actual).
  2. **Keep only the last N (e.g. 3) repair contexts**; **summarize** older ones into a one-line "previous failures" list.
  3. **The repair context is a SEPARATE, SHORT message**, **not** appended to the growing conversation. The AVO loop should **reset/compact** the conversation each generation (fresh session per candidate, or a two-message prompt: compacted "lineage brief" + "current repair"). This is the **session branching** `event_logger.branch()` (`event_logger.js:111-125`) provides but the AVO operator **never wires** (A5 in the audit: "session branching is not wired to AVO — there is no true parallel-candidate path").
  4. **Distinguish hang vs. failure** (E3): a hang gets a *different*, *shorter* repair prompt (no traceback to slice; just "last function entered" from the event ledger) and a **distinct DAG status** (`timed_out`, not `failed`).

**Verdict §4:** M4's value is real, but the FYP's "take the top frame, slice 30 tokens" is wrong on all four failure modes (xdist, third-party top frames, recursion, silent hangs). The correct design: **filter to the first user-code frame**, **distinguish hang from failure**, **bound the repair context to ≤200 tokens as a separate evicted message**, and **wire the existing session-branching** so the repair context doesn't accumulate into the 1-slot KV pool. The current `evaluator.js` does none of this — it is the raw-traceback baseline M4 must replace.

---

## 5. Concrete Recommendations & Implementation Architecture

### 5.1 Exact extensions / MCPs / tools to expose

**Add to the Cordis kernel (in-process, `mcp-qwen/src/harness/`):**

| New module | Tools it registers | Replaces / augments |
|---|---|---|
| `services/code_index.js` (M1–M2) | `find_symbol` (name→def sites), `get_callers` (symbol→call sites, O(V) centrality-ranked), `get_callees`, `get_type_definition`, `list_module_symbols` | Augments `search_code` (keep `git grep` as the raw fallback). **No** persistent property graph; a lazy JSON symbol index on disk. |
| `services/ast_edit.js` (M3) | `ast_edit` (symbol + intent → harness-resolved node edit, parse-gated, 5-rung fallback) | Augments `edit_file` (keep exact-text as rung 3). In-process `@ast-grep/napi`. |
| `avo/trace_repair.js` (M4) | (internal, not a model tool) — a **parser** the `evaluator` calls: `parseTraceback(stderr, runner) → {userFrames[], interestingFrame, isHang, localizedSlice(≤200tok)}` | Replaces the raw-stderr slice in `evaluator.js`. |

**Do NOT add:** an external `code-graph-mcp` / `mcp-language-server` stdio server (reintroduces the IPC tax, §3.3). Do **not** add a model-facing "emit an ast-grep selector" tool (§2.2).

**New `qwen_coworker` parameters** (in `tools.js`): `use_structural: "auto" | "ast" | "text"` (default `auto` = the 5-rung ladder), and `repair_context_budget: int` (default 200 tokens). These make the 2×2×2 factorial **dispatchable** from the Lead Architect without code changes.

### 5.2 Phase-by-phase implementation plan (each phase independently A/B-testable)

- **Phase 0 — Close the preconditions (BLOCKER for everything else).**
  - Fix **H1**: `spawn(..., {detached:true})` + `child.unref()`-free group kill on POSIX (`process.kill(-pid)`); pass a **session tag** into the WSL command and kill by tag (the `killProcessTree(child, sessionId)` path that is currently dead in `execute()`).
  - **Confirm** the wedge detector in `src/server_lifecycle.js` fully supersedes `de01aa9`'s deletion; update `AUDIT_2026-09-05.md` §4.1 + README §4 to match.
  - *Gate:* `test_deepseek_avo.js` 6/6 + a new "orphaned grandchild on timeout" test (spawn `bash -c 'sleep 300 & wait'`, timeout, assert no `sleep` survives).
- **Phase 1 — M4 first (cheapest, highest signal, no new deps).**
  - Implement