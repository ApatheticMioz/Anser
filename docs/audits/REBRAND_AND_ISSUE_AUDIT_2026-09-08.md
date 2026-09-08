# Rebrand & Issue Adjudication Audit — Open-Source Readiness (Anser)

- **Scope**: Naming/identity scan (`LLM_Ecosystem` → `Anser`), private-machine-path & obsolete-artifact leak check, Issue #8 & #9 adjudication, and adversarial open-source-readiness critique.
- **Method**: Ground truth via `git grep` / `git ls-files` / `git log` / `gh issue view` / direct file reads, plus a **live `npm test` run** (exit 0). No source file was mutated this turn; this report is the sole new artifact.
- **Repo state at audit**: `origin = https://github.com/ApatheticMioz/LLM_Ecosystem.git` (**PRIVATE**), branch `main`, working tree **clean**.
- **Severity scale**: `BLOCKER` > `HIGH` > `MEDIUM` > `LOW` > `NOTE`.

---

## Executive Summary

| Area | Verdict |
|---|---|
| **Naming** | `LLM_Ecosystem` appears in **25 tracked files**. ~10 are true *identity* references that must become `Anser`; ~15 are *local-folder / GitHub-URL* artifacts (machine-specific absolute paths) that must be **parameterized or removed**, not renamed. |
| **Private-path leaks** | **Confirmed** in tracked files: `C:\Users\Apath`, `/home/apath`, full `PATH` env dumps (benchmark JSON), and a **hardcoded `SUDO_PASS = "1234"`** in `benchmarks/wedge-repro/repro.py`. Must be scrubbed before public. |
| **Obsolete temp artifacts** | `.evo/`, `.avo/`, `mcp-qwen/.evo/`, `mcp-qwen/.avo/`, `mcp-qwen/.t1.log`, `mcp-qwen/.t_security.log`, `.webui_secret_key`, `scripts/__pycache__/` are all **untracked + gitignored** (not a leak). One **dangling reference**: `benchmarks/wedge-repro/ISSUE_DRAFT.md` is cited in `NOTES.md:979` but does not exist. |
| **Test-gate truth** | On-disk `.test.js` = **36**. `npm test` = **31** (verified **green**, exit 0). `npm run test:all` = **33**. README claims "26/26 / 26-suite / 23 offline" and mcp-qwen/README claims "33-suite / 28 (25+3)" — **all stale**. The two *newest* guard suites (`search_code_guard`, `protocol_sync`) are in `npm test` but **not** in `test:all`. |
| **Issue #8** | **CLOSE** — adjudicated: Codex `apply_patch` adopted + hardened; bespoke `edit_file` retained + auto-normalized; Aider SEARCH/REPLACE rejected. 31-suite gate green. |
| **Issue #9** | **CLOSE** — superseded by the 4-slice adversarial audit (`a7c75dd` + `a8f0d7a`): 15/15 findings resolved, 31-suite gate green. Residual open-source blockers (rebrand, path scrub, live smoke, owner go) re-tracked here. |
| **Open-source readiness** | **NOT ready.** 14 concrete obstacles (see §4), headlined by: repo still private + misnamed, non-portable hardcoded paths in every quickstart, private-identity leaks, stale test counts, and **no CI**. |

---

## 1. Naming & Identity Scan

### 1.1 `LLM_Ecosystem` occurrences — 25 tracked files, 3 categories

`git grep -l "LLM_Ecosystem"` returns exactly these 25 tracked files. They fall into three distinct classes with **different** remediation:

#### Class A — True identity / branding (rename → `Anser`)
These name the *product* and must become `Anser`:

| File:Line | Current text | Action |
|---|---|---|
| `README.md:1` | `# LLM_Ecosystem & Anser Harness` | → `# Anser` (or `# Anser — Universal 245K Local Agent Microkernel & Harness`) |
| `README.md:14` | `**LLM_Ecosystem** is a production-grade, local-first multi-agent…` | → `**Anser** is …` |
| `README.md:3` | release badge `…/ApatheticMioz/LLM_Ecosystem?label=release` | → new repo name (post-rename) |
| `README.md:19` | legacy-goose branch URL `…/LLM_Ecosystem/tree/archive/legacy-goose` | → new repo name |
| `README.md:92` | repo tree root `LLM_Ecosystem/` | → `Anser/` |
| `CONTRIBUTING.md:1` | `# Contributing to LLM_Ecosystem` | → `# Contributing to Anser` |
| `CONTRIBUTING.md:3` | `contributing to **LLM_Ecosystem** and the **Anser** agent harness` | → `**Anser**` (drop the dual name) |
| `LICENSE:3` | `Copyright (c) 2026 LLM_Ecosystem Contributors` | → `Anser Contributors` |
| `docs/README.md:3` | `…for the **LLM_Ecosystem** and the **Anser** harness` | → `**Anser**` |
| `.gitignore:2` | `# LLM_Ecosystem .gitignore` (comment) | → `# Anser .gitignore` |

> **Note:** `CLAUDE.md`, `GEMINI.md`, `mcp-qwen/package.json`, `mcp-qwen/index.js`, `mcp-qwen/docs/DESIGN.md`, `docs/audits/PATCHWORK_ADVERSARIAL_AUDIT_2026-09-05.md`, `docs/audits/ANSER_PROGRESS.md`, `docs/audits/QWEN_EVO_AUDIT.md` are **already clean** (0 occurrences) — the `5d4ab2e "rebrand to Anser"` commit already did the deep rebrand; only the top-level identity strings above were missed.

#### Class B — Local-folder / GitHub-URL artifacts (parameterize or remove — do NOT rename)
These are **machine-specific absolute paths** that happen to contain the old folder name. Renaming them to `Anser` would be *wrong* (they'd still be non-portable). They must become **relative / env-driven** or be removed:

| File:Line | Current text | Problem |
|---|---|---|
| `README.md:175` | sandbox root `D:\LLM_Ecosystem` or `/mnt/d/LLM_Ecosystem` | hardcodes the author's D: drive |
| `README.md:368,375,396,409,417,433,467` | `D:/LLM_Ecosystem/…`, `D:\LLM_Ecosystem\mcp-qwen`, MCP `args` | quickstart + 3 MCP config examples all hardcode the path |
| `CONTRIBUTING.md:31,32,61` | `git clone …/LLM_Ecosystem.git`, `cd LLM_Ecosystem\mcp-qwen`, `wsl … /mnt/d/LLM_Ecosystem/mcp-qwen` | clone URL (private) + Windows path + WSL path |
| `mcp-qwen/README.md:20,78,81` | `node D:/LLM_Ecosystem/mcp-qwen/index.js`, `cwd="D:/LLM_Ecosystem/my-project"` | quickstart hardcodes path |
| `docs/README.md:23,27,36,40,48,49,50,51` | `file:///d:/LLM_Ecosystem/…` (8 links) | **Windows-only `file://` absolute links — broken for every external reader** |
| `benchmarks/swe-rebench/README.md:56,61,68` | `D:\LLM_Ecosystem\…` | hardcodes path |
| `scripts/main/kill_all_tasks.bat:31` | `wsl -d Ubuntu -- bash /mnt/d/LLM_Ecosystem/scripts/wsl/kill_all_tasks.sh` | hardcoded |
| `scripts/setup_links.ps1:66` | `wsl.exe -e bash -c "/mnt/d/LLM_Ecosystem/scripts/wsl/setup_links.sh"` | hardcoded |
| `scripts/uncensored/download_model.sh:5` | `wsl -d Ubuntu -- bash /mnt/d/LLM_Ecosystem/scripts/uncensored/download_model.sh` | hardcoded |
| `scripts/uncensored/start.bat:15`, `start_noreason.bat:5` | `"D:\LLM_Ecosystem\llama-cpp\llama-server.exe" -m "\\\\wsl.localhost\Ubuntu\home\apath\…"` | hardcoded path **and** `/home/apath` |
| `scripts/wsl/setup_links.sh:2,5,19,28,29,42` | `SOURCE_DIR="/mnt/d/LLM_Ecosystem/scripts/wsl"`, symlink targets, MCP `args` | hardcoded |
| `mcp-qwen/update_schemas.py:165,175` | `r"D:\LLM_Ecosystem\mcp-qwen\index.js"`, `"/mnt/d/LLM_Ecosystem/mcp-qwen/index.js"` | schema generator hardcodes path |
| `mcp-qwen/NOTES.md:5,686,691,1001,1038` | `D:\LLM_Ecosystem\…`, `/mnt/d/LLM_Ecosystem/…` | historical journal (see §1.3) |

**Recommended fix pattern**: derive the repo root at runtime (`path.resolve(__dirname, …)` / `import.meta.url`), or read a `QWEN_REPO_ROOT` env var, and document a *relative* quickstart (`cd <repo>/mcp-qwen`). Replace `file:///d:/…` doc links with **relative** markdown links (`[…](../audits/…)`).

#### Class C — Code comments / test fixtures (illustrative; low priority)
| File:Line | Note |
|---|---|
| `mcp-qwen/src/harness/services/sandbox_fs.js:208-209` | JSDoc example `D:\mnt\d\LLM_Ecosystem` / `D:\LLM_Ecosystem` — cosmetic; make generic (`D:\<repo>`) |
| `mcp-qwen/src/tools.js:130` | comment example — cosmetic |
| `mcp-qwen/src/wsl_bridge.js:49` | JSDoc example — cosmetic |
| `mcp-qwen/tests/canary.test.js:127,141,146,157` | fixture `rootdir: /mnt/d/LLM_Ecosystem` — **intentional test fixture**; keep or make a temp dir |
| `mcp-qwen/tests/fifo_queue.test.js:59,73` | `cwd: "D:/LLM_Ecosystem"` — fixture |
| `mcp-qwen/tests/platform.test.js:136,146,159` | `cwd: "D:\\LLM_Ecosystem\\mcp-qwen"` — fixture |
| `mcp-qwen/tests/{posix_routing,reaping,security}.test.js` | path fixtures — keep (they test the normalizer) |

### 1.2 Private-machine-path & credential leaks (tracked files) — **must scrub before public**

| File:Line | Leak | Severity |
|---|---|---|
| `benchmarks/wedge-repro/repro.py:37` | `SUDO_PASS = "1234"` (hardcoded sudo password, used at `:144` `echo {SUDO_PASS} \| sudo -S …`) | **HIGH** (credential in a public file) |
| `benchmarks/swe-rebench/results/session_20260824/server_config.json:80` | full `PATH=` env dump: `/mnt/c/Users/Apath/…`, `/home/apath/…`, Claude session UUIDs, plugin paths | **HIGH** (identity + machine fingerprint) |
| `benchmarks/swe-rebench/results/session_20260825/server_config.json:80` | same `PATH=` dump | **HIGH** |
| `benchmarks/swe-rebench/run_goose_solve.py:39` | `GOOSE_EXE = r"C:\Users\Apath\.local\bin\goose.exe"` | MEDIUM |
| `benchmarks/sessions/session_20260907/{server_config.json,vllm_engine.log,vllm_models.json}` | `/home/apath/qwen-serving/…` throughout | MEDIUM |
| `benchmarks/wedge-repro/logs/full/*.txt` (3 files) | `/home/apath/qwen-serving/venv/…` stack traces | MEDIUM |
| `mcp-qwen/NOTES.md:543,653-694,992` | `C:\Users\Apath\…`, `/home/apath/…` (Claude config, gemini config, node wrapper) | MEDIUM |
| `mcp-qwen/update_schemas.py:13,158` | `/mnt/c/Users/Apath/.gemini/…`, `C:\Users\Apath\.gemini\…` | MEDIUM (also non-portable) |
| `mcp-qwen/tests/schema_parity.test.js:98` | `/mnt/c/Users/Apath/.gemini/antigravity-ide/mcp/qwen38-local` | LOW (test fixture, but real username) |
| `scripts/wsl/setup_links.sh:33` | `ln -sfn /mnt/c/Users/Apath/.gemini/…` | MEDIUM |
| `README.md:450` | `QWEN_STATE_DIR … /mnt/c/Users/Apath/.qwen on WSL` | LOW (example) |
| `docs/audits/AUDIT_2026-09-05.md:4,25,26,31,48,57,61,74,101,143,175,194` | `C:\Users\Apath\…`, `/home/apath/…` (historical audit) | LOW (historical, but real username) |
| `mcp-qwen/tests/security.test.js:64,182,254,260,263` | `/mnt/c/Users/…` — **intentional attack vectors** (some use `testuser`/`otheruser`); the `Apath` ones at `:254` are historical comments | NOTE (keep as vectors, but the real-username comment at `:254` could be generalized) |

**Recommended scrub**: replace `Apath`/`apath` with a neutral placeholder (`<user>` / `alice`), redact the two `PATH=` dumps (replace with a truncated/annotated version), and **remove `SUDO_PASS`** (read from env or drop the sudo-py-spy step).

### 1.3 Obsolete temporary artifacts

| Artifact | Tracked? | Status |
|---|---|---|
| `.evo/`, `.avo/`, `mcp-qwen/.evo/`, `mcp-qwen/.avo/` (lineage DAGs + snapshots) | **No** (gitignored) | On disk; manifests embed `D:\LLM_Ecosystem` paths. Not a leak, but Issue #9 deferred item #5 flagged `.avo/` as "candidate for cleanup." |
| `mcp-qwen/.t1.log`, `mcp-qwen/.t_security.log` | **No** (gitignored) | 549 B scratch logs, 2026-09-06. Safe to delete. |
| `.webui_secret_key` (16 B) | **No** (gitignored, `.gitignore:16`) | Not tracked — **no leak**. |
| `scripts/__pycache__/avo_runner.cpython-311.pyc` | **No** | Stale bytecode; delete. |
| `benchmarks/wedge-repro/ISSUE_DRAFT.md` | **No** | **Dangling**: referenced by `mcp-qwen/NOTES.md:979` ("`ISSUE_DRAFT.md` is the draft") but the file does not exist. Either restore or fix the reference. |

**`NOTES.md` disposition** (Issue #9 deferred item #5, still open): `mcp-qwen/NOTES.md` is a **1,051-line** engineering journal containing many `/home/apath` / `C:\Users\Apath` paths (§1.2). Owner decision still pending: *ship as history / move to `docs/` / remove*. Recommendation: **move to `docs/audits/`** (it is historical, not operational) **and scrub** the private paths, or split into a scrubbed public version + a private appendix.

---

## 2. Issue #8 & Issue #9 — Review & Resolution Summaries

Both issues are **OPEN** with **no comments**. Both were filed 2026-09-08 (07:44 and 07:47 UTC). The 4-slice audit commits that resolve them landed **later the same day**: `a7c75dd` (18:07) and `a8f0d7a` (21:32).

### 2.1 Issue #8 — `ADJUDICATE: edit-format benchmark — edit_file vs Aider SEARCH/REPLACE vs Codex apply_patch`

**Issue's own acceptance criteria**: (1) published benchmark numbers for all 3 formats, (2) a decision recorded in the issue, (3) if a challenger wins → single-format implementation, old path deleted, suites green.

**What actually happened (evidence)**:
- **Decision made**: of the three *format families*, **Codex `apply_patch` (unified-diff) was ADOPTED** as a new tool (`a7c75dd` "adopt apply_patch"), the **bespoke `edit_file` was RETAINED** (kept as the exact-substring tool) and **auto-normalized**, and **Aider SEARCH/REPLACE was REJECTED** (stalled project; its fuzzy-match overlaps both survivors).
- **Hardening (4-slice audit, `a8f0d7a`)**:
  - `apply_patch`: `MAX_PATCH_SIZE = 2 MB` + `PatchTooLargeError` (F-5); dropped `--whitespace=fix` for byte-faithful apply (F-6); `_validatePatchPaths()` pre-validation of every in-patch path (F-10); non-git-dir behavior documented (F-11); **expanded `apply_patch.test.js` 3 → 12 tests** incl. traversal / absolute-path / symlink-escape / atomicity (F-13).
  - `edit_file`: `InvalidReplacementError` guard (F-3); **per-region** line-ending detection so mixed-ending files aren't corrupted (F-4); auto-normalization trade-off documented (F-14).
  - `search_code`: `-F`/`--fixed-strings` literal matching (F-1), `GitGrepError` fail-fast + `.env` excluded from fallback walk (F-2), unified total-cap semantics (F-12) → new `search_code_guard.test.js`.
  - Protocol: `protocol_sync.test.js` (8 tests) locks `GEMINI.md`/`CLAUDE.md` shared invariants byte-identical (F-7/F-8/F-9/F-15).
- **Gate**: `npm test` = **31 suites, exit 0 (green)** — verified live this audit.

**Doctrine note for the close comment**: the issue's header said "only the winner survives (no format dual-architecture)." The implementation kept **two** tools. This is defensible and should be stated explicitly in the close: `edit_file` (exact-substring, uniqueness-guarded) and `apply_patch` (unified-diff, multi-line/structural) are **complementary, not competing** — they occupy different edit shapes, and the *rejected* family (Aider) is the one that would have created a true redundant third fuzzy-matcher. Frame the close as "3 families → 2 complementary tools + 1 rejected."

**Proposed close comment (Issue #8)**:
> **ADJUDICATED — closed.** Of the three format families, **Codex `apply_patch` was adopted** (`a7c75dd`) and **hardened** (`a8f0d7a`: 2 MB cap + `PatchTooLargeError`, byte-faithful apply (no `--whitespace=fix`), `_validatePatchPaths()` pre-validation, 12 adversarial tests incl. traversal/absolute/symlink/atomicity). The **bespoke `edit_file` was retained** as the exact-substring tool and **auto-normalized** (`InvalidReplacementError` guard, per-region line-ending preservation). **Aider SEARCH/REPLACE was rejected** (stalled upstream; fuzzy-match redundant with both survivors). The two survivors are complementary (exact-substring vs unified-diff), not a competing dual-architecture. Verified: `npm test` **31/31 green** (exit 0). Revisit trigger (new Qwen major) stands.

### 2.2 Issue #9 — `Pre-open-source adversarial verification — final verdict: APPROVED conditional on live smoke + owner go`

**Issue's own verdict**: `APPROVED-FOR-OPEN-SOURCE, conditional on items 1–2` (live smoke after MCP restart; owner's explicit go + push + make public). It listed 6 deferred/open items.

**What happened after (evidence)**: the **4-slice adversarial audit** (`a7c75dd` + `a8f0d7a`, 2026-09-08, *after* this issue was filed) is the **final** verification pass. It produced `AUDIT_MANIFEST.md` with **15 findings (3 HIGH / 7 MEDIUM / 3 LOW / 2 NOTE), 15/15 RESOLVED and verified**, and a **31-suite green gate**. This supersedes the issue's earlier 7-commit fix ledger.

**Status of Issue #9's 6 deferred items (re-checked this audit)**:
1. **Live smoke pending MCP restart** — still pending (needs a running vLLM; not verifiable in this text-only turn).
2. **Push + public go** — **still not done**: repo is **PRIVATE** and still named `LLM_Ecosystem`.
3. **Engine dead-stream cause** — report-only, unchanged.
4. **Process findings** — report-only, unchanged.
5. **Hygiene (`.avo/` cleanup, `NOTES.md` private paths)** — **still open**: `.evo/`/`.avo/` still on disk; `NOTES.md` still carries `/home/apath` / `C:\Users\Apath` (§1.2/§1.3).
6. **Design questions (OQ1–OQ7)** — carried.

**Proposed close comment (Issue #9)**:
> **CLOSED — superseded & re-scoped.** The 4-slice adversarial audit (`a7c75dd` + `a8f0d7a`, 2026-09-08) is the final verification pass: **15/15 findings resolved and verified** (`AUDIT_MANIFEST.md`), **31-suite gate green** (exit 0). This subsumes the earlier 7-commit fix ledger. The two original conditions are re-tracked in `docs/audits/REBRAND_AND_ISSUE_AUDIT_2026-09-08.md`: **(a) live smoke** (needs a running vLLM — deferred to release), and **(b) owner go** (blocked on the rebrand: repo must be renamed `LLM_Ecosystem → Anser`, private paths/`SUDO_PASS` scrubbed, stale test counts fixed, and a CI gate added before it is pushed + made public). No blocking *code* defects remain; the remaining work is *release hygiene*.

---

## 3. Test-Gate Ground Truth (verified this audit)

| Command | Suites | Verified |
|---|---|---|
| `npm test` (offline gate) | **31** | **exit 0 — GREEN** (ran live) |
| `npm run test:all` | **33** | (adds `stream_proxy`, `utf8_proxy`, `benchmark`, `lifecycle_locks`, `signal_hardening`) |
| On-disk `.test.js` files | **36** | union of the two commands |

**Set differences (concrete, from `package.json`):**
- On disk but **not** in `npm test`: `benchmark`, `lifecycle_locks`, `signal_hardening`, `stream_proxy`, `utf8_proxy`.
- On disk but **not** in `test:all`: **`protocol_sync`, `search_code_guard`**, `utf8_proxy`.

> **Gate gap (MEDIUM):** the two *newest* security-guard suites from the 4-slice audit — `search_code_guard.test.js` and `protocol_sync.test.js` — are in `npm test` but **absent from `test:all`**. A contributor running only `npm run test:all` (the "full" gate per the READMEs) will **not** run the new search-integrity or protocol-sync guards. Fix: add both to `test:all` (and `utf8_proxy` for full 36 coverage), or document that `test:all` ≠ all suites.

**Stale counts to correct:**
- `README.md:4` badge `26/26 Suites Green`; `README.md:306` `26/26`; `README.md:464` "26-suite test gate"; `README.md:469` "23 offline suites"; `README.md:472` "all 26 suites" → should be **31** (offline) / **33** (`test:all`) / **36** (on disk).
- `mcp-qwen/README.md:13` "33-suite test gate"; `mcp-qwen/README.md:353` "npm test runs 28 suites (25 offline + 3 live/skip). test:all runs all 33" → `npm test` is **31**, not 28.

---

## 4. Adversarial Critique — Obstacles to a Smooth External Clone-and-Run

Ranked by friction to a first-time external contributor:

1. **`BLOCKER` — Repo is PRIVATE and misnamed.** `origin` is `…/ApatheticMioz/LLM_Ecosystem.git` with `visibility: PRIVATE`. No external contributor can clone at all until it is renamed to `Anser` **and** made public. Every clone URL in the docs points at the private name.
2. **`HIGH` — Non-portable hardcoded paths in every quickstart.** `README.md` §9, `CONTRIBUTING.md`, `mcp-qwen/README.md`, `scripts/**`, and `update_schemas.py` all hardcode `D:\LLM_Ecosystem`, `/mnt/d/LLM_Ecosystem`, `C:\Users\Apath`, `/home/apath`. A contributor on a different drive/user/OS must hand-edit a dozen files before `npm install` even makes sense. There is no `QWEN_REPO_ROOT`-style indirection.
3. **`HIGH` — Private-identity & credential leaks in tracked files** (§1.2): `SUDO_PASS = "1234"`, two full `PATH=` env dumps with the author's username + Claude session UUIDs, and `C:\Users\Apath`/`/home/apath` across scripts, `update_schemas.py`, `NOTES.md`, and benchmark logs. Publishing as-is leaks the author's machine identity (and a password).
4. **`HIGH` — Windows-only onboarding.** The entire "Getting Started" is Windows 11 + WSL2 + D: drive. The project markets "dual platform (Windows & WSL2)" but there is **no Linux/macOS path**, and the WSL steps assume the author's exact distro/user.
5. **`MEDIUM` — No CI.** There is no `.github/workflows/` (or equivalent). The "test gate" is a manual `npm test`. For an open-source repo, a CI job that runs the 31/33-suite gate on every PR is a major trust gap.
6. **`MEDIUM` — Stale test counts** (§3): README says 26/26, mcp-qwen/README says 28/33; reality is 31/33/36. First-time readers get wrong expectations, and the `test:all` gate silently omits the two newest guard suites.
7. **`MEDIUM` — `docs/README.md` uses `file:///d:/LLM_Ecosystem/…` links** (8 of them) — Windows-absolute `file://` URIs that are dead for anyone not on that machine. Must become relative links.
8. **`MEDIUM` — `update_schemas.py` hardcodes `C:\Users\Apath\.gemini\…`** — the Antigravity schema generator writes to the author's home; a contributor's run will target the wrong (nonexistent) path.
9. **`LOW` — No root `package.json`.** The MCP server lives in `mcp-qwen/`; a contributor must know to `cd mcp-qwen`. CONTRIBUTING.md says so, but the root README's quickstart buries it behind Windows paths.
10. **`LOW` — Dangling `implementation_plan.md`.** `CLAUDE.md`/`GEMINI.md` (F-15 resolution) reference `implementation_plan.md`, which **does not exist** in the repo.
11. **`LOW` — Dangling `ISSUE_DRAFT.md`** in `NOTES.md:979` (file absent).
12. **`LOW` — `NOTES.md` (1,051 lines) is an unscrubbed private journal** at the package root; undecided disposition (Issue #9 item #5).
13. **`NOTE` — Live-engine suites need a 24 GB GPU + vLLM.** 4 suites (`evo`, `mcp_client`, `fifo_queue`, `benchmark`) honestly skip when offline, but the README doesn't clearly tell a GPU-less contributor "you can run the 31-suite offline gate; the live 4 need hardware."
14. **`NOTE` — `.evo/`/`.avo/` runtime dirs on disk** (gitignored). Not a leak, but their manifests embed `D:\LLM_Ecosystem`; if ever force-added they'd leak. Add to the "do not commit" hygiene list.

### Gaps in `README.md`
- Title/branding still `LLM_Ecosystem` (§1.1 Class A).
- Stale test counts (26/26, 26-suite, 23 offline) — §3.
- Quickstart is Windows-path-specific; no relative/`QWEN_REPO_ROOT` form; no Linux/macOS section.
- No CI mention; no "run the offline gate without a GPU" note.
- `file:///d:/` links (in `docs/README.md`) are dead externally.

### Gaps in `CONTRIBUTING.md`
- Title/branding `LLM_Ecosystem`; clone URL = private repo; `cd LLM_Ecosystem\mcp-qwen` + `wsl … /mnt/d/LLM_Ecosystem/…` hardcoded.
- No explicit test-suite counts; no note that live suites need GPU/vLLM; no CI/PR checklist.
- "Reporting Vulnerabilities" says "report privately to the maintainers" but gives **no contact** (no email / security policy / `SECURITY.md`).

---

## 5. Recommended Action Plan (for the next, mutating turn)

**Phase 1 — Identity (rename to `Anser`)**
1. Rename the 10 Class-A identity strings (§1.1) to `Anser` (`README.md`, `CONTRIBUTING.md`, `LICENSE`, `docs/README.md`, `.gitignore`).
2. Rename the GitHub repo `LLM_Ecosystem → Anser` (owner action) and update the 3 URL references (`README.md:3,19`, `CONTRIBUTING.md:31`) + `git remote set-url`.

**Phase 2 — Portability (de-hardcode paths)**
3. Introduce a `QWEN_REPO_ROOT` env / `import.meta.url`-derived root; rewrite `scripts/**`, `update_schemas.py`, `mcp-qwen/README.md`, `README.md` §9, `CONTRIBUTING.md` to relative/env forms.
4. Convert `docs/README.md` `file:///d:/…` links → relative markdown links.
5. Add a Linux/macOS (WSL-optional) onboarding path to `README.md` §9.

**Phase 3 — Privacy scrub (before public)**
6. Remove `SUDO_PASS` from `repro.py` (env-driven or drop the sudo step).
7. Redact the two `PATH=` dumps in `benchmarks/swe-rebench/results/session_2026082{4,5}/server_config.json`; replace `Apath`/`apath` with `<user>`/`alice` across `NOTES.md`, `update_schemas.py`, `scripts/wsl/setup_links.sh`, `run_goose_solve.py`, benchmark logs, `schema_parity.test.js`.
8. Decide `NOTES.md` disposition (move to `docs/audits/` + scrub, or split public/private).
9. Delete stale scratch: `mcp-qwen/.t1.log`, `mcp-qwen/.t_security.log`, `scripts/__pycache__/`; fix or remove the `ISSUE_DRAFT.md` reference; create or de-reference `implementation_plan.md`.

**Phase 4 — Test-gate truth + CI**
10. Fix stale counts: README → 31/33/36; mcp-qwen/README → 31 (`npm test`) / 33 (`test:all`).
11. Add `search_code_guard` + `protocol_sync` (+ `utf8_proxy`) to `test:all` so the "full" gate runs all 36.
12. Add a `.github/workflows/ci.yml` running `npm test` (31 offline suites) on PR + push; document that the 4 live suites need a GPU.
13. Add a `SECURITY.md` with a real private-reporting contact; reference it from `CONTRIBUTING.md`.

**Phase 5 — Close issues & go public**
14. Post the close comments in §2.1 (Issue #8) and §2.2 (Issue #9) via `gh issue close 8 --comment …` / `gh issue close 9 --comment …`.
15. Owner's explicit go → push `main` → set repo **public** under `Anser`.

---

## Appendix — Raw Inventory

**25 tracked files containing `LLM_Ecosystem`** (from `git grep -l`):
`.gitignore`, `CONTRIBUTING.md`, `LICENSE`, `README.md`, `benchmarks/swe-rebench/README.md`, `docs/README.md`, `docs/audits/AUDIT_2026-09-05.md`, `mcp-qwen/NOTES.md`, `mcp-qwen/README.md`, `mcp-qwen/src/harness/services/sandbox_fs.js`, `mcp-qwen/src/tools.js`, `mcp-qwen/src/wsl_bridge.js`, `mcp-qwen/tests/canary.test.js`, `mcp-qwen/tests/fifo_queue.test.js`, `mcp-qwen/tests/platform.test.js`, `mcp-qwen/tests/posix_routing.test.js`, `mcp-qwen/tests/reaping.test.js`, `mcp-qwen/tests/security.test.js`, `mcp-qwen/update_schemas.py`, `scripts/main/kill_all_tasks.bat`, `scripts/setup_links.ps1`, `scripts/uncensored/download_model.sh`, `scripts/uncensored/start.bat`, `scripts/uncensored/start_noreason.bat`, `scripts/wsl/setup_links.sh`.

**Clean (0 occurrences, already rebranded):** `CLAUDE.md`, `GEMINI.md`, `mcp-qwen/package.json`, `mcp-qwen/index.js`, `mcp-qwen/docs/DESIGN.md`, `docs/audits/{ANSER_PROGRESS,PATCHWORK_ADVERSARIAL_AUDIT_2026-09-05,QWEN_EVO_AUDIT}.md`, `.gitattributes`, `.editorconfig`.

**4-slice audit commits:** `a7c75dd` (adopt `apply_patch`, auto-normalize `edit_file`) + `a8f0d7a` (harden search/edit/patch guards + `protocol_sync` gate; authored `AUDIT_MANIFEST.md`, 15/15 resolved).

**Open issues:** #6 (Landlock LSM), #7 (mcp_bridge → SDK Client), #8 (edit-format adjudication), #9 (pre-open-source verification).
