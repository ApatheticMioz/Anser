//! DGI Gatekeeper — Decomposition Granularity Index (calibration study v2, repo-agnostic).
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
//!     - H2: inlined table/vector bloat (>= 100 named entries) AND a multi-target / multi-subsystem bundle
//!     - H3: a NAMED JS sub-subsystem source (`src/harness/<sub>/`) wired into >= 2 distinct Rust subsystems
//!
//! This is a faithful port of the validated repo-agnostic extractor
//! `.scratch/verify_refined_dgi.py` (which replaced `.scratch/test_dgi.py`'s
//! castor-bound rules): the same regex semantics, the same feature names,
//! and the same scoring tiers — now generalized so the gate is meaningful
//! beyond the Castor repo itself.
//!
//! Calibration (7 audit-verified anchors, fixture in `dgi_anchors.json`):
//! all 4 legitimate false positives (m1, m2c, m3a, m3b) are ADMITted and
//! all 3 genuine monoliths (rustplan_inv, m7a, m10_opt) are REJECTed,
//! giving precision = recall = 1.0 on the anchor set — versus the legacy
//! gate, which rejected all 4 FPs and missed #95 (1398 < 1500 cap).
//! The repo-agnostic generalization (broad file regex, path-tail dedup,
//! `from` read-context, enumeration-chain propagation, state-placeholder
//! filtering, write-target subsystem breadth) is verified lossless on the
//! full 77-dispatch session corpus (0 new false rejects) and 103/110 on the
//! cross-domain stress set.

use std::collections::{HashMap, HashSet};

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
    /// Repo-agnostic relative source/doc path with a recognized extension.
    /// Matches `dir/dir/.../file.rs` (>= 1 path segment before the file),
    /// generalizing the legacy `castor/**` / `mcp-castor/**` special cases.
    file: Regex,
    /// Test-file coordinates (excluded from subsystem coupling).
    test: Regex,
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
            r"\b(?:[A-Za-z0-9_\-]+/)+[A-Za-z0-9_\-]+\.(?:rs|py|go|ts|tsx|js|mjs|c|cc|cpp|h|sql|toml|json|jsonl|yaml|yml|md|sh)\b",
        )
        .expect("static pattern"),
        test: Regex::new(
            r"\.test\.(?:js|ts)$|/tests?/|_test\.(?:rs|js|ts|go|py)$|tests?/[^.]*$|EVALS\.md",
        )
        .expect("static pattern"),
        // `(?i)` mirrors Python `re.I`; these match the original-case context
        // window (not the lowercased prompt).
        build: Regex::new(
            r"(?i)\b(?:write|create|implement|replace|complete|extend|build|add|port|serve|register|author|wire|update|refactor|fix)\b[^.]*$",
        )
        .expect("static pattern"),
        // `from` is a read-context marker ("Port semantics from mcp-castor/..."),
        // mirroring the validated reference.
        read: Regex::new(
            r"(?i)\b(?:read once|read each|read|reference|references|existing|consum|reus|extract|see|from)\b[^.]*$",
        )
        .expect("static pattern"),
        table: Regex::new(r"\b(\d{2,4})\s*(?:[-\s]?(?:vector|blocked|allowed))\b")
            .expect("static pattern"),
        gate: Regex::new(r"\bgate\s*[:\-]").expect("static pattern"),
        tfam: Regex::new(
            r"cargo\s+test|npm\s+test|npm\s+run\s+test|pytest|go\s+test|\.test\.(?:js|ts)\b",
        )
        .expect("static pattern"),
        dverb: Regex::new(
            r"\b(implement|write|author|create|build|port|wire|replace|extend|add|register|serve|update|refactor|fix)\b",
        )
        .expect("static pattern"),
        readonly: Regex::new(r"read-only|plan mode|no file writes|strictly read")
            .expect("static pattern"),
    }
}

/// A file coordinate extracted from a prompt, with its byte spans in the
/// original prompt (used for the before/after context windows and for
/// enumeration-chain propagation).
struct FileMatch {
    text: String,
    start: usize,
    end: usize,
    role: String,
}

/// The `n` characters immediately *before* a byte offset (Python
/// `p[max(0, start - n):start]`). The regex engine indexes by byte but the
/// Python reference indexes by code point, so the byte offset is translated to
/// a char offset. The window deliberately *excludes* the matched text so a
/// trailing `[^.]*$` context regex can look past any dots in the path itself
/// (a window that included the match would be truncated by them).
fn before_window(p: &str, start: usize, n: usize) -> String {
    let start_chars = p[..start].chars().count();
    let skip = start_chars.saturating_sub(n);
    let take = start_chars - skip;
    p.chars().skip(skip).take(take).collect()
}

/// Collapse path aliases so `castor/src/foo.rs` and `src/foo.rs` (and the
/// `mcp-castor` / `mcp_castor` spellings) normalize to the same tail.
fn normalize_tail(path: &str) -> String {
    let mut parts: Vec<&str> = path.split('/').collect();
    if let Some(first) = parts.first()
        && matches!(first.to_ascii_lowercase().as_str(), "castor" | "mcp-castor" | "mcp_castor")
    {
        parts.remove(0);
    }
    parts.join("/")
}

/// Map a source-file coordinate to its subsystem node.
///
/// `mcp-castor/**` paths keep their legacy JS node naming (the H3
/// cross-repo coupling signal), so the m10_opt anchor still resolves its
/// harness sub-subsystem. Every other path is normalized through
/// [`normalize_tail`] and its first segment (skipping a leading `src`)
/// is the named subsystem; a top-level file is `"root"`.
fn subsystem(f: &str) -> String {
    if f.contains("mcp-castor/") {
        let rel = f
            .split("mcp-castor/")
            .nth(1)
            .unwrap_or_default();
        let re_ha =
            Regex::new(r"^src/harness/([a-z_]+(?:/[a-z_]+)?)/").expect("static pattern");
        if let Some(m) = re_ha.captures(rel) {
            return format!("js/ha/{}", m.get(1).unwrap().as_str());
        }
        let re_sub = Regex::new(r"^src/([a-z_\-]+)/").expect("static pattern");
        if let Some(m) = re_sub.captures(rel) {
            return format!("js/{}", m.get(1).unwrap().as_str());
        }
        if rel.starts_with("tests/") || rel.starts_with("test/") {
            return "js/tests".to_string();
        }
        return "js/root".to_string();
    }
    let norm = normalize_tail(f);
    let mut segs: Vec<&str> = norm.split('/').collect();
    if segs.first().copied() == Some("src") {
        segs.remove(0);
    }
    if segs.len() <= 1 {
        return "root".to_string();
    }
    match segs[0] {
        "tests" | "test" => "tests".to_string(),
        other => other.to_string(),
    }
}

/// DGI features extracted from a dispatch prompt (faithful port of
/// `verify_refined_dgi.py::extract_features`).
#[derive(Debug, Clone, Default)]
struct Features {
    nchars: usize,
    ntargets: usize,
    /// Distinct non-test source-file coordinates.
    nfiles: usize,
    /// All distinct named subsystems (write or read), repo-agnostic.
    subsystems: Vec<String>,
    nsubs: usize,
    /// Distinct subsystems that have at least one write-target file.
    n_target_subs: usize,
    /// Distinct non-JS subsystems (the Rust-side of the H3 coupling signal).
    nrust: usize,
    /// NAMED JS sub-subsystems only (`src/harness/<sub>/`): the strict H3
    /// cross-repo coupling signal.
    js_ha_subsubs: Vec<String>,
    /// Max inlined table/vector entry count mentioned.
    vbl: u32,
    gate: bool,
    single_verifier: bool,
    dverb: usize,
    readonly: bool,
}

/// Extract all DGI features from a dispatch prompt.
fn features(p: &str) -> Features {
    let rx = rx();
    let lower = p.to_ascii_lowercase();

    // 1. Repo-agnostic file coordinates, deduplicated by normalized path
    //    tail, keeping the longest (most-qualified) match for each tail.
    let mut by_tail: HashMap<String, (String, usize, usize)> = HashMap::new();
    for m in rx.file.find_iter(p) {
        let text = m.as_str().to_string();
        let start = m.start();
        let end = m.end();
        let tail = normalize_tail(&text);
        let is_better = match by_tail.get(&tail) {
            Some(existing) => text.len() > existing.0.len(),
            None => true,
        };
        if is_better {
            by_tail.insert(tail, (text, start, end));
        }
    }

    let mut matches: Vec<FileMatch> = by_tail
        .into_iter()
        .map(|(_, (text, start, end))| FileMatch {
            role: "plain".to_string(),
            text,
            start,
            end,
        })
        .collect();

    // 2. Initial role assignment (Python `re.search` == Regex::is_match on
    //    the before/after windows).
    for f in &mut matches {
        let before = before_window(p, f.start, 55);
        let after: String = p
            .chars()
            .skip(p[..f.end].chars().count())
            .take(3)
            .collect();
        let bverb = rx.build.is_match(&before);
        let readctx = rx.read.is_match(&before);
        f.role = if after.trim_start().starts_with(':') || (bverb && !readctx) {
            "target".to_string()
        } else if readctx || rx.test.is_match(&f.text) {
            "ref".to_string()
        } else {
            "plain".to_string()
        };
    }

    // 3. Enumeration-chain propagation: a target role propagates across
    //    `and` / `,` / `+` / `then` separators within the same sentence.
    //    Drive the walk through a start-ordered index list so the owned
    //    matches can be mutated in place.
    let mut order: Vec<usize> = (0..matches.len()).collect();
    order.sort_by_key(|&i| matches[i].start);
    let re_sep =
        Regex::new(r"^\s*(?:and|then|plus|&|\+|,)\s+").expect("static pattern");
    let re_word = Regex::new(r"\b(?:and|then|plus)\b").expect("static pattern");
    for i in 0..order.len() {
        if matches[order[i]].role != "target" {
            continue;
        }
        let mut e1 = matches[order[i]].end;
        for &idx in order.iter().skip(i + 1) {
            let cur = &mut matches[idx];
            if cur.role == "target" {
                // Python chain semantics: a consecutive run of already-target
                // files is skipped (no reassignment, no break).
                e1 = cur.end;
                continue;
            }
            let between = &p[e1..cur.start];
            let sep = re_sep.is_match(between)
                || (re_word.is_match(between) && !between.contains('.'));
            if sep {
                cur.role = "target".to_string();
                e1 = cur.end;
            } else {
                break;
            }
        }
    }

    // 4. Filter out state-placeholder / non-source artifacts (paths written
    //    as `<state>/...`, `~/.castor/...`, or `/tmp/...`).
    let mut files: Vec<(String, String)> = Vec::new();
    for f in &matches {
        let before = before_window(p, f.start, 15);
        if before.contains("<state>")
            || before.contains("~/.castor")
            || before.contains("/tmp/")
        {
            continue;
        }
        files.push((f.text.clone(), f.role.clone()));
    }

    // Distinct non-test source-file coordinates.
    let src_files: Vec<String> = {
        let mut s: Vec<String> = files
            .iter()
            .map(|(f, _)| f.clone())
            .filter(|f| !rx.test.is_match(f))
            .collect();
        s.sort();
        s.dedup();
        s
    };

    // Subsystem partitioning.
    let mut all_sub: HashSet<String> = HashSet::new();
    let mut target_sub: HashSet<String> = HashSet::new();
    for (f, role) in &files {
        if rx.test.is_match(f) {
            continue;
        }
        let sub = subsystem(f);
        if matches!(
            sub.as_str(),
            "root" | "tests" | "js/root" | "js/tests" | "rust/root" | "rust/cargo"
        ) {
            continue;
        }
        all_sub.insert(sub.clone());
        if *role == "target" {
            target_sub.insert(sub);
        }
    }
    let mut named_subsystems: Vec<String> = all_sub.iter().cloned().collect();
    named_subsystems.sort();
    let mut js_ha_subsubs: Vec<String> =
        named_subsystems.iter().filter(|s| s.starts_with("js/ha/")).cloned().collect();
    js_ha_subsubs.sort();
    let nrust = named_subsystems
        .iter()
        .filter(|s| !s.starts_with("js/"))
        .count();

    // Data-table / vector bloat: max named table with >= 2-digit entry count.
    let mut vbl: u32 = 0;
    for caps in rx.table.captures_iter(&lower) {
        if let Some(n) = caps.get(1).and_then(|s| s.as_str().parse().ok()) {
            vbl = vbl.max(n);
        }
    }

    let gate = rx.gate.is_match(&lower);
    // The verifier-family *set size* drives `single_verifier`. The `tfam`
    // pattern has no capturing groups (the validated reference uses
    // `\.test\.(?:js|ts)\b`), so Python `re.findall` yields the FULL match
    // per hit — e.g. `["cargo test", ".test.js"]` — and we mirror that by
    // inserting the whole match (not a group), so two families stay distinct.
    let mut tfams: HashSet<String> = HashSet::new();
    for m in rx.tfam.find_iter(&lower) {
        tfams.insert(m.as_str().to_string());
    }
    let mut dverbs: HashSet<&str> = HashSet::new();
    for m in rx.dverb.find_iter(&lower) {
        dverbs.insert(m.as_str());
    }
    let readonly = rx.readonly.is_match(&lower);

    let ntargets = files
        .iter()
        .filter(|(_, r)| *r == "target")
        .count();
    let n_target_subs = target_sub.len();
    let nsubs = named_subsystems.len();
    let nchars = p.chars().count();

    Features {
        nchars,
        ntargets,
        nfiles: src_files.len(),
        subsystems: named_subsystems,
        nsubs,
        n_target_subs,
        nrust,
        js_ha_subsubs,
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
    if f.vbl >= 100 && (f.ntargets >= 2 || f.nsubs >= 2) {
        sigs.push(format!("H2:data-table>={}+multi", f.vbl));
    }
    if !f.js_ha_subsubs.is_empty() && f.nrust >= 2 {
        let subsubs: Vec<&str> = f
            .js_ha_subsubs
            .iter()
            .map(|n| n.split('/').nth(2).unwrap_or_default())
            .collect();
        sigs.push(format!(
            "H3:js_ha[{}]->rust[{}]",
            subsubs.join(","),
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
    // Subsystem breadth advisory, driven by WRITE-TARGET subsystems: the
    // more distinct subsystems a dispatch writes to, the more it spans.
    if f.n_target_subs >= 3 {
        s += 2;
    } else if f.n_target_subs >= 2 {
        s += 1;
    }
    if f.dverb >= 4 {
        s += 1;
    }
    if f.vbl >= 100 && (f.ntargets >= 2 || f.nsubs >= 2) {
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
    // Full calibration: all 7 anchors at once (parity with the Python
    // harness). 4 MON must REJECT, 4 FP must NOT reject (Admit/Review).
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
    // Synthetic feature-level checks (no fixture needed) — these verify the
    // repo-agnostic generalizations the legacy castor-bound gate could not
    // express.
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
        // Two distinct subsystems, both write-targets (": " after path).
        p.push_str("Implement castor/src/tools/sandbox.rs: port the policy.\n");
        p.push_str("Implement castor/src/runner/mod.rs: wire the executor.\n");
        // An inlined 137-entry vector table.
        p.push_str("Include the 137-vector blocklist from the JS harness.\n");
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
    fn single_subsystem_owning_one_big_table_is_not_h2() {
        // The decomposed m7_table slice: one subsystem OWNS the one
        // 137-vector table. vbl >= 100 but ntargets < 2 and nsubs < 2,
        // so H2 must NOT fire (and H1 doesn't: it's short).
        let p = "\
Implement src/tables/blocklist.rs: inline the 137-vector blocklist \
table exactly as shipped by the JS harness. Single file, single concern.
";
        let v = evaluate(p);
        assert!(!v.is_reject(), "single-subsystem table owner must not be rejected: {v:?}");
    }

    #[test]
    fn review_tier_when_advisory_score_reaches_two() {
        // dverb >= 4 and no single verifier, >2000 chars, one subsystem,
        // multiple write-target files: advisory >= 2 -> Review.
        let mut p = String::new();
        p.push_str("Implement, write, author, and register the module: ");
        p.push_str("src/mcp/mod.rs: extend the server handler. ");
        p.push_str("src/mcp/worker.rs: extend the job spec. ");
        p.push_str("Read the existing docs for context. ");
        p.push_str(&"pad ".repeat(300));
        let v = evaluate(&p);
        assert_is_review(&v, "review-tier");
    }

    /// Repo-agnostic file coordinates (no `castor/` prefix) must be
    /// recognized and mapped to their subsystems.
    #[test]
    fn repo_agnostic_paths_are_recognized() {
        let p = "\
Implement src/alpha/mod.rs: wire the client. \
Implement src/beta/mod.rs: wire the store. \
Implement src/gamma/mod.rs: wire the cache.
";
        let f = features(p);
        // Three distinct named subsystems.
        assert_eq!(f.nsubs, 3, "expected 3 subsystems, got {:?}", f.subsystems);
        // All three are write-targets -> breadth term fires at the top tier.
        assert_eq!(f.n_target_subs, 3);
        // Advisory >= 2 (ntargets-1 + breadth) but no hard signature.
        assert!(f.vbl < 100, "no data table in this prompt, got vbl={}", f.vbl);
        assert!(!evaluate(p).is_reject(), "no hard signature should fire: {:?}", evaluate(p));
    }

    /// State-placeholder paths (`<state>/...`) must be excluded from
    /// subsystem counting and must not become write-targets.
    #[test]
    fn state_placeholder_paths_are_excluded() {
        let p = "\
Implement src/alpha/mod.rs: write the module. \
Also the disk mirror <state>/tasks/slots/slot_N.json is written per transition.
";
        let f = features(p);
        // Only `alpha` counts; the `<state>/...` placeholder is filtered.
        assert_eq!(f.subsystems, vec!["alpha".to_string()], "{:?}", f.subsystems);
        assert_eq!(f.n_target_subs, 1);
    }

    /// A write-target role propagates across an enumeration chain joined by
    /// `and` within the same sentence.
    #[test]
    fn enumeration_chain_propagates_target_role() {
        let p = "Implement a/one.rs and b/two.rs and c/three.rs: do the thing.";
        let f = features(p);
        assert_eq!(f.ntargets, 3, "chain should mark 3 targets, got {}", f.ntargets);
        assert_eq!(f.n_target_subs, 3);
    }

    /// A path followed by `from` is a read-context (reference), not a
    /// write-target: the referenced file contributes no write-target subsystem
    /// even though a build verb appears earlier in the same sentence.
    #[test]
    fn from_context_marks_reference_not_target() {
        // `src/legacy/util.js` is read ("from"); only `src/new/home.rs` is a
        // write-target. So the write-target subsystem breadth is 1, not 2.
        let p = "Port semantics from src/legacy/util.js and implement src/new/home.rs: write it.";
        let f = features(p);
        assert_eq!(
            f.n_target_subs, 1,
            "the `from` file must be a reference, not a target: n_target_subs={}",
            f.n_target_subs
        );
    }
}

