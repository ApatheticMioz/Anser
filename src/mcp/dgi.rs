//! DGI Gatekeeper — Decomposition Granularity Index (calibration study v1).
//!
//! Deterministic, sub-250ms replacement for the legacy static
//! `prompt.len() > 1500` ceiling. It extracts structural features from a
//! dispatch prompt (file coordinates, target roles, subsystem coupling,
//! data-table bloat, directive verbs, verifier bounds) and decides:
//!
//!   * `Admit` — bounded single-concern spec, proceed.
//!   * `Review(u32)` — advisory DGI score >= 2; proceed with a decomposition note.
//!   * `Reject(Vec)` — a calibrated hard "monolith" signature fired:
//!     - H1: absolute length > 2500 chars
//!     - H2: inlined table/vector bloat (>= 100 named entries) AND a multi-target / multi-Rust-subsystem bundle
//!     - H3: a NAMED JS sub-subsystem source (`src/harness/<sub>/`) wired into >= 2 distinct Rust subsystems
//!
//! Calibration (7 audit-verified anchors, fixture in `dgi_anchors.json`):
//! all 4 legitimate false positives (m1, m2c, m3a, m3b) are ADMITted and
//! all 3 genuine monoliths (rustplan_inv, m7a, m10_opt) are REJECTed,
//! giving precision = recall = 1.0 on the anchor set — versus the legacy
//! gate, which rejected all 4 FPs and missed #95 (1398 < 1500 cap).
//!
//! The extraction rules are a faithful port of `.scratch/test_dgi.py`
//! (same regex semantics, same feature names, same scoring tiers).

use std::collections::HashSet;

use regex::Regex;

/// Verdict of the DGI Gatekeeper for a dispatch prompt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DgiVerdict {
    /// Bounded single-concern spec: proceed without commentary.
    Admit,
    /// Advisory DGI score (>= 2): proceed, but flag for decomposition.
    Review(u32),
    /// A hard monolith signature fired: fail fast, listing the signatures.
    Reject(Vec<String>),
}

impl DgiVerdict {
    /// True when the dispatch must be refused (hard signature).
    pub fn is_reject(&self) -> bool {
        matches!(self, Self::Reject(_))
    }

    /// The advisory score when this is a `Review`, else `None`.
    pub fn score(&self) -> Option<u32> {
        match self {
            Self::Review(s) => Some(*s),
            _ => None,
        }
    }
}

/// Precompiled feature-extraction regexes (Python `re` semantics: `\b`,
/// `(?i)` inline flags, and `re.I` for case-insensitive patterns).
struct DgiRx {
    /// Source-file coordinates: `castor/**.{rs,toml,json,jsonl}` or
    /// `mcp-castor/**.{js,ts,mjs,json,jsonl,txt}`.
    file: Regex,
    /// Test-file coordinates (excluded from subsystem coupling).
    test: Regex,
    /// `mcp-castor/src/harness/<sub>[/ <subsub>]/` sub-subsystem.
    js_subsub: Regex,
    /// `mcp-castor/src/<sub>/` subsystem.
    js_sub: Regex,
    /// `mcp-castor` `tests?/` directory.
    js_tests: Regex,
    /// `castor/src/<sub>/` Rust subsystem.
    rust_sub: Regex,
    /// Bare repo-root Rust file (`castor/<n>.rs` or `castor/src/<n>.rs`).
    rust_root: Regex,
    /// `castor/Cargo.toml`.
    rust_cargo: Regex,
    /// Trailing build-verb context (marks a file as a write target).
    build: Regex,
    /// Trailing read/reference context (marks a file as a reference).
    read: Regex,
    /// Inlined data-table/vector entry count, e.g. "137-vector table".
    table: Regex,
    /// Explicit verification-gate marker (`gate: ...` / `gate - ...`).
    gate: Regex,
    /// Test-framework families (verifier set).
    tfam: Regex,
    /// Directive verbs (implement, write, author, ...).
    dverb: Regex,
    /// Read-only / no-write intent markers.
    readonly: Regex,
}

fn rx() -> DgiRx {
    DgiRx {
        file: Regex::new(
            r"\b(?:castor/[A-Za-z0-9_\-./]*\.(?:rs|toml|json|jsonl)|mcp-?castor/[A-Za-z0-9_\-./]*\.(?:js|ts|mjs|json|jsonl|txt))\b",
        )
        .expect("static pattern"),
        test: Regex::new(r"\.test\.(js|ts)$|/tests?/|_test\.(rs|js|ts)$|EVALS\.md")
            .expect("static pattern"),
        js_subsub: Regex::new(r"^src/harness/([a-z_]+(?:/[a-z_]+)?)/")
            .expect("static pattern"),
        js_sub: Regex::new(r"^src/([a-z_\-]+)/").expect("static pattern"),
        js_tests: Regex::new(r"^tests?/").expect("static pattern"),
        rust_sub: Regex::new(r"^castor/src/([a-z_]+)/").expect("static pattern"),
        rust_root: Regex::new(r"^castor/[A-Za-z_]+\.rs$|^castor/src/[A-Za-z_]+\.rs$")
            .expect("static pattern"),
        rust_cargo: Regex::new(r"^castor/Cargo\.toml$").expect("static pattern"),
        // `(?i)` mirrors Python `re.I`; these match the original-case context
        // window (not the lowercased prompt).
        build: Regex::new(
            r"(?i)\b(?:write|create|implement|replace|complete|extend|build|add|port|serve|register|author|wire)\b[^.]*$",
        )
        .expect("static pattern"),
        read: Regex::new(
            r"(?i)\b(?:read once|read each|read|reference|references|existing|consum|reus|extract|see)\b[^.]*$",
        )
        .expect("static pattern"),
        table: Regex::new(r"\b(\d{2,4})\s*(?:[-\s]?(?:vector|blocked|allowed))\b")
            .expect("static pattern"),
        gate: Regex::new(r"\bgate\s*[:\-]").expect("static pattern"),
        tfam: Regex::new(
            r"cargo\s+test|npm\s+test|npm\s+run\s+test|pytest|go\s+test|\.test\.(js|ts)\b",
        )
        .expect("static pattern"),
        dverb: Regex::new(
            r"\b(implement|write|author|create|build|port|wire|replace|extend|add|register|serve)\b",
        )
        .expect("static pattern"),
        readonly: Regex::new(r"read-only|plan mode|no file writes|strictly read")
            .expect("static pattern"),
    }
}

/// DGI features extracted from a prompt (faithful port of `test_dgi.py::features`).
#[derive(Debug, Clone, Default)]
struct Features {
    nchars: usize,
    ntargets: usize,
    /// Distinct non-test source-file coordinates.
    nfiles: usize,
    /// Named Rust subsystems (`<sub>` under `castor/src/`).
    rust: Vec<String>,
    nrust: usize,
    /// NAMED JS sub-subsystems only (`js/ha/<sub>` = `src/harness/<sub>/`);
    /// the strict H3 coupling signal.
    njs_subsub: usize,
    js_subsub: Vec<String>,
    /// Max inlined table/vector entry count mentioned.
    vbl: u32,
    gate: bool,
    single_verifier: bool,
    dverb: usize,
    readonly: bool,
}

/// Map a source-file coordinate to its (repo, subsystem) node string.
fn node(rx: &DgiRx, f: &str) -> String {
    if f.contains("mcp-castor/") {
        // Python `f.split("mcp-castor/")[-1]`; the marker appears at most once,
        // so the segment after the first occurrence is the same.
        let rel = f
            .split("mcp-castor/")
            .nth(1)
            .map(str::to_owned)
            .unwrap_or_default();
        if let Some(m) = rx.js_subsub.captures(&rel) {
            return format!("js/ha/{}", m.get(1).unwrap().as_str());
        }
        if let Some(m) = rx.js_sub.captures(&rel) {
            return format!("js/{}", m.get(1).unwrap().as_str());
        }
        if rx.js_tests.is_match(&rel) {
            return "js/tests".to_string();
        }
        return "js/root".to_string();
    }
    if let Some(m) = rx.rust_sub.captures(f) {
        return format!("rust/{}", m.get(1).unwrap().as_str());
    }
    if rx.rust_root.is_match(f) {
        return "rust/root".to_string();
    }
    if rx.rust_cargo.is_match(f) {
        return "rust/cargo".to_string();
    }
    "rust/??".to_string()
}

/// Extract all DGI features from a dispatch prompt.
fn features(p: &str) -> Features {
    let rx = rx();
    let lower = p.to_ascii_lowercase();

    // (file, role) with the Python role rules:
    //   target  — immediately followed by ":", or a trailing build verb
    //             with no read-context in the preceding 55 chars;
    //   ref     — read/reference context, or a test-file coordinate;
    //   plain   — everything else.
    // Python indexes `p` by code point; the regex engine indexes by byte.
    // Match byte boundaries are always code-point boundaries, so we map the
    // 55-char "before" window and 3-char "after" window onto code points.
    let files: Vec<(&str, &str)> = rx
        .file
        .find_iter(p)
        .map(|m| {
            let before_chars = p[..m.start()].chars().count();
            let before: String = p
                .chars()
                .skip(before_chars.saturating_sub(55))
                .take(55)
                .collect();
            let after: String = p
                .chars()
                .skip(p[..m.end()].chars().count())
                .take(3)
                .collect();
            let bverb = rx.build.is_match(&before);
            let readctx = rx.read.is_match(&before);
            let f = m.as_str();
            let role = if after.trim_start().starts_with(':')
                || (bverb && !readctx)
            {
                "target"
            } else if readctx || rx.test.is_match(f) {
                "ref"
            } else {
                "plain"
            };
            (f, role)
        })
        .collect();

    // Non-test source-file coordinates (sorted, deduped).
    let src: Vec<&str> = {
        let mut s: Vec<&str> = files
            .iter()
            .map(|(f, _)| *f)
            .filter(|f| !rx.test.is_match(f))
            .collect();
        s.sort();
        s.dedup();
        s
    };

    // (repo, subsystem) nodes for each non-test source file, deduped/sorted.
    let mut allnodes: Vec<String> = src
        .iter()
        .map(|f| node(&rx, f))
        .collect();
    allnodes.sort();
    allnodes.dedup();

    // "named" = a real subsystem directory, NOT repo-root files / tests / Cargo.toml.
    let rust_named: Vec<String> = allnodes
        .iter()
        .filter(|n| n.starts_with("rust") && !matches!(n.as_str(), "rust/root" | "rust/cargo"))
        .cloned()
        .collect();

    // Distinct named Rust subsystems (`rust/<sub>` -> `<sub>`).
    let mut rust: Vec<String> = rust_named
        .iter()
        .map(|n| n.split('/').nth(1).unwrap_or_default().to_string())
        .collect();
    rust.sort();
    rust.dedup();

    // The stricter H3 signal uses ONLY named sub-subsystem JS sources
    // (src/harness/<sub>/), so a root-level JS file ported into >= 2 Rust
    // modules is *not* a monolith signature.
    let js_subsub: Vec<String> = allnodes
        .iter()
        .filter(|n| n.starts_with("js/ha/"))
        .cloned()
        .collect();

    // Data-table / vector bloat: named table of >= 2-digit entry count.
    let mut vbl: u32 = 0;
    for caps in rx.table.captures_iter(&lower) {
        if let Some(n) = caps
            .get(1)
            .and_then(|s| s.as_str().parse().ok())
        {
            vbl = vbl.max(n);
        }
    }

    let gate = rx.gate.is_match(&lower);
    // Python `re.findall` returns the capture-group text for alternatives that
    // contain a group (e.g. `.test.(js|ts)` -> "js"/"ts") and the full match for
    // the group-less alternatives. The verifier-family *set size* drives
    // `single_verifier`, so we mirror that group-aware behaviour exactly.
    let mut tfams: HashSet<String> = HashSet::new();
    for caps in rx.tfam.captures_iter(&lower) {
        // Mirror `re.findall`: an alternative that lacks the capture group
        // contributes the empty string, so several group-less families
        // collapse to a single distinct family (e.g. `cargo test` + `npm run
        // test` -> {""} size 1, keeping `single_verifier` true).
        let val = caps.get(1).map(|s| s.as_str().to_string()).unwrap_or_default();
        tfams.insert(val);
    }
    let mut dverbs: HashSet<&str> = HashSet::new();
    for m in rx.dverb.find_iter(&lower) {
        dverbs.insert(m.as_str());
    }
    let readonly = rx.readonly.is_match(&lower);

    let nrust = rust.len();
    let njs_subsub = js_subsub.len();

    Features {
        nchars: p.chars().count(),
        ntargets: files.iter().filter(|(_, r)| *r == "target").count(),
        nfiles: src.len(),
        rust,
        nrust,
        njs_subsub,
        js_subsub,
        vbl,
        gate,
        single_verifier: gate && tfams.len() <= 1,
        dverb: dverbs.len(),
        readonly,
    }
}

/// The 3 calibrated hard-reject "monolith" signatures.
fn hard_signatures(f: &Features) -> Vec<String> {
    let mut sigs = Vec::new();
    if f.nchars > 2500 {
        sigs.push("H1:length>2500".to_string());
    }
    if f.vbl >= 100 && (f.ntargets >= 2 || f.nrust >= 2) {
        sigs.push(format!("H2:data-table>=100+multi(vbl={})", f.vbl));
    }
    if f.njs_subsub >= 1 && f.nrust >= 2 {
        let subsubs: Vec<&str> = f
            .js_subsub
            .iter()
            .map(|n| n.split('/').nth(2).unwrap_or_default())
            .collect();
        sigs.push(format!(
            "H3:js[{}]->rust[{}]",
            subsubs.join("/"),
            f.nrust
        ));
    }
    sigs
}

/// Advisory DGI score (gradient feeding the REVIEW tier).
fn dgi_score(f: &Features) -> u32 {
    let mut s: u32 = 0;
    if f.nchars > 2500 {
        s += 2;
    } else if f.nchars > 2000 {
        s += 1;
    }
    s += f.ntargets.saturating_sub(1) as u32;
    if f.njs_subsub >= 1 && f.nrust >= 2 {
        s += 2;
    }
    if f.dverb >= 4 {
        s += 1;
    }
    if f.vbl >= 100 && (f.ntargets >= 2 || f.nrust >= 2) {
        s += 2;
    }
    if !f.single_verifier && !f.readonly {
        s += 1;
    }
    s
}

/// Evaluate a dispatch prompt against the calibrated DGI gate.
///
/// Deterministic, no LLM, sub-250ms: any hard signature => `Reject`;
/// advisory score >= 2 => `Review(score)`; otherwise `Admit`.
pub fn evaluate(prompt: &str) -> DgiVerdict {
    let f = features(prompt);
    let sigs = hard_signatures(&f);
    if !sigs.is_empty() {
        return DgiVerdict::Reject(sigs);
    }
    let score = dgi_score(&f);
    if score >= 2 {
        return DgiVerdict::Review(score);
    }
    DgiVerdict::Admit
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The 7 calibration anchors, verbatim from the Claude-session dispatch
    /// corpus (`.scratch/claude_session_dispatches.json`; regenerated by
    /// `scripts/gen_dgi_fixture.py`). Keys: dispatch index.
    const ANCHORS: &str = include_str!("dgi_anchors.json");

    /// A small helper so tests read like the Python harness.
    fn anchor(idx: &str) -> (DgiVerdict, String) {
        let v: serde_json::Value = serde_json::from_str(ANCHORS).unwrap();
        let a = &v["anchors"][idx];
        let name = a["name"].as_str().unwrap().to_string();
        let prompt = a["prompt"].as_str().unwrap();
        (evaluate(prompt), name)
    }

    fn assert_is_admit(v: &DgiVerdict, name: &str) {
        assert!(
            matches!(v, DgiVerdict::Admit),
            "{name} must be ADMITted, got {v:?}"
        );
    }

    fn assert_is_review(v: &DgiVerdict, name: &str) {
        match v {
            DgiVerdict::Review(s) => assert!(
                *s >= 2,
                "{name} REVIEW score must be >= 2, got {s}"
            ),
            other => panic!("{name} expected Review, got {other:?}"),
        }
    }

    fn assert_is_reject(v: &DgiVerdict, name: &str, want_sig: &str) {
        match v {
            DgiVerdict::Reject(sigs) => {
                let s = sigs.join(" ");
                assert!(
                    sigs.iter().any(|x| x.starts_with(want_sig)),
                    "{name} must fire {want_sig}, got: {s}"
                );
            }
            other => panic!("{name} expected Reject, got {other:?}"),
        }
    }

    // ------------------------------------------------------------------
    // The 4 calibration false positives — bounded single-concern specs
    // that the legacy `len > 1500` gate wrongly rejected (all 1503–1571
    // chars) but the DGI must ADMIT.
    // ------------------------------------------------------------------

    #[test]
    fn fp_m1_state_dir_lockfile_admitted() {
        let (v, name) = anchor("21");
        assert_is_admit(&v, &name);
    }

    #[test]
    fn fp_m2c_rmcp_server_admitted() {
        let (v, name) = anchor("27");
        assert_is_admit(&v, &name);
    }

    #[test]
    fn fp_m3a_task_registry_semaphore_admitted() {
        let (v, name) = anchor("32");
        assert_is_admit(&v, &name);
    }

    #[test]
    fn fp_m3b_status_long_poll_admitted() {
        let (v, name) = anchor("35");
        assert_is_admit(&v, &name);
    }

    // ------------------------------------------------------------------
    // The 3 genuine monoliths — coupled multi-subsystem sprawl that the
    // DGI must REJECT (each via its own calibrated hard signature).
    // ------------------------------------------------------------------

    #[test]
    fn mon_rustplan_inv_rejected_by_h1_length() {
        let (v, name) = anchor("11");
        assert_is_reject(&v, &name, "H1");
    }

    #[test]
    fn mon_m7a_rejected_by_h2_table_bloat_multi_subsystem() {
        let (v, name) = anchor("56");
        assert_is_reject(&v, &name, "H2");
    }

    #[test]
    fn mon_m10_opt_rejected_by_h3_cross_repo_coupling() {
        let (v, name) = anchor("95");
        assert_is_reject(&v, &name, "H3");
    }

    // ------------------------------------------------------------------
    // Full calibration: all 7 anchors at once (parity with test_dgi.py).
    // ------------------------------------------------------------------

    #[test]
    fn all_seven_calibration_anchors() {
        let v: serde_json::Value = serde_json::from_str(ANCHORS).unwrap();
        let anchors = &v["anchors"];
        let mut ok = 0usize;
        for (idx, a) in anchors.as_object().unwrap() {
            let prompt = a["prompt"].as_str().unwrap();
            let name = a["name"].as_str().unwrap();
            let dec = evaluate(prompt);
            let is_mon = a["class"].as_str().unwrap() == "MON";
            let want = if is_mon { "REJECT" } else { "ADMIT/REVIEW" };
            let got_ok = if is_mon {
                dec.is_reject()
            } else {
                !dec.is_reject()
            };
            assert!(
                got_ok,
                "anchor #{idx} ({name}) expected {want}, got {dec:?}"
            );
            ok += 1;
        }
        assert_eq!(ok, 7, "calibration fixture must carry exactly 7 anchors");
    }

    // ------------------------------------------------------------------
    // Synthetic feature-level checks (no fixture needed).
    // ------------------------------------------------------------------

    #[test]
    fn short_prompt_admits() {
        let v = evaluate("Fix the off-by-one in castor/src/pruner.rs line 42.");
        assert_is_admit(&v, "short");
    }

    #[test]
    fn very_long_prompt_rejects_via_h1() {
        // A long prompt with no file coordinates at all: H1 alone must fire.
        let p = "x".repeat(3000);
        let v = evaluate(&p);
        assert_is_reject(&v, "long", "H1");
    }

    #[test]
    fn two_rust_subsystems_with_big_table_rejects_via_h2() {
        let mut p = String::new();
        // Two distinct Rust subsystems, both write-targets (": " after path).
        p.push_str("Implement castor/src/tools/sandbox.rs: port the policy.\n");
        p.push_str("Implement castor/src/runner/mod.rs: wire the executor.\n");
        // An inlined 137-entry vector table.
        p.push_str("Include the 137-vector blocklist from the JS harness.\n");
        // Padding so dverb/length don't accidentally push to H1 (>2500).
        let v = evaluate(&p);
        assert_is_reject(&v, "h2", "H2");
    }

    #[test]
    fn js_subsub_into_two_rust_modules_rejects_via_h3() {
        let p = "\
ONE file: castor/src/evo/optimizer.rs — the offline reflective optimizer. \
References (read once each): mcp-castor/src/harness/evo/evaluator.js + \
mcp-castor/src/harness/evo/operator.js (port their mechanics), \
castor/src/evals/runner.rs (the fitness scorer).
";
        let v = evaluate(p);
        assert_is_reject(&v, "h3", "H3");
    }

    #[test]
    fn single_rust_subsystem_owns_one_big_table_is_not_h2() {
        // The decomposed m7_table slice: one subsystem OWNS the one
        // 137-vector table. vbl >= 100 but ntargets < 2 and nrust < 2,
        // so H2 must NOT fire (and H1 doesn't: it's short).
        let p = "\
Implement castor/src/tables/blocklist.rs: inline the 137-vector blocklist \
table exactly as shipped by the JS harness. Single file, single concern.
";
        let v = evaluate(p);
        assert!(!v.is_reject(), "single-subsystem table owner must not be rejected: {v:?}");
    }

    #[test]
    fn review_tier_when_advisory_score_reaches_two() {
        // Build a prompt that trips the advisory tiers (dverb >= 4 and no
        // single verifier) but no hard signature: a single Rust subsystem,
        // multiple write-target files, >2000 chars.
        let mut p = String::new();
        p.push_str("Implement, write, author, and register the module: ");
        p.push_str("castor/src/mcp/mod.rs: extend the server handler. ");
        p.push_str("castor/src/mcp/worker.rs: extend the job spec. ");
        p.push_str("Read the existing docs for context. ");
        // Pad past 2000 with benign filler (no new file coordinates).
        p.push_str(&"pad ".repeat(300));
        let v = evaluate(&p);
        assert_is_review(&v, "review-tier");
    }
}
