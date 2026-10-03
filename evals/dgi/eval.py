#!/usr/bin/env python3
"""
evals/dgi/eval.py — Evaluation and stress test runner for DGI Gatekeeper.

Evaluates the 110-prompt cross-domain dataset (Research, Coding across languages,
Writing/Documentation, Adversarial Edge Cases) against the DGI classification rules.
"""

import json
import os
import re
import sys
import time

DATASET_PATH = (
    sys.argv[1]
    if len(sys.argv) > 1
    else os.path.join(os.path.dirname(__file__), "dataset.json")
)

# ---------------------------------------------------------------------------
# Repo-Agnostic Feature Extraction & Rule Engine
# ---------------------------------------------------------------------------

EXTENSIONS = [
    r"rs", r"py", r"go", r"ts", r"tsx", r"js", r"mjs",
    r"c", r"cpp", r"h", r"sql", r"toml", r"json", r"md", r"sh"
]
EXT_PATTERN = "|".join(EXTENSIONS)

FILE_REGEX = re.compile(
    rf"\b([a-zA-Z0-9_\-./]+(?:\.[a-zA-Z0-9_\-]+)*\.(?:{EXT_PATTERN}))\b"
)

READ_REGEX = re.compile(
    r"\b(read|inspect|check|audit|examine|reference|review|see|from)\b",
    re.IGNORECASE
)
WRITE_REGEX = re.compile(
    r"\b(write|create|edit|modify|patch|implement|port|replace|author|complete|extend|build|add|wire|serve|register)\b",
    re.IGNORECASE
)
DIRECTIVE_REGEX = re.compile(
    r"\b(also|and then|next|additionally|furthermore|after that|plus)\b",
    re.IGNORECASE
)
DATA_TABLE_REGEX = re.compile(
    r"^[\s|:-]{5,}$",
    re.MULTILINE
)

def is_test_file(path: str) -> bool:
    p = path.lower()
    return bool(
        "test" in p
        or "tests/" in p
        or "evals/" in p
        or p.endswith("_test.go")
        or p.endswith("_test.rs")
        or p.endswith("_test.py")
        or ".test." in p
        or ".spec." in p
    )

def normalize_tail(path: str) -> str:
    parts = [p for p in path.split("/") if p and p != "."]
    if len(parts) >= 2 and parts[0] in ("castor", "mcp-castor"):
        parts = parts[1:]
    return "/".join(parts)

def extract_subsystem(norm_path: str) -> str:
    parts = [p for p in norm_path.split("/") if p]
    if not parts:
        return "root"
    if parts[0] == "src" and len(parts) >= 2:
        return parts[1]
    if len(parts) >= 2 and parts[0] not in ("tests", "evals", "docs", "scripts", ".scratch"):
        return parts[0]
    return "root"

def extract_features(prompt: str):
    matches = list(FILE_REGEX.finditer(prompt))
    all_files = []
    write_targets = []
    
    last_role = "plain"
    last_end = 0
    
    for m in matches:
        raw_path = m.group(1)
        norm_path = normalize_tail(raw_path)
        start, end = m.start(), m.end()
        
        # Check chaining
        chain_window = prompt[last_end:start]
        is_chained = bool(re.search(r"[,+]\s*$|\b(and|then)\s*$", chain_window.strip(), re.IGNORECASE))
        
        # Context window before match
        before_window = prompt[max(0, start - 45):start]
        has_write = bool(WRITE_REGEX.search(before_window))
        has_read = bool(READ_REGEX.search(before_window))
        
        # Suffix window after match
        after_window = prompt[end:min(len(prompt), end + 5)]
        has_colon = ":" in after_window
        
        if is_test_file(raw_path):
            role = "test"
        elif has_colon:
            role = "target"
        elif has_read and not has_write:
            role = "read"
        elif has_write:
            role = "target"
        elif is_chained and last_role == "target":
            role = "target"
        else:
            role = "plain"
            
        last_role = role
        last_end = end
        
        all_files.append((norm_path, role))
        if role == "target":
            write_targets.append(norm_path)
            
    # Deduplicate
    unique_files = list(dict.fromkeys([f[0] for f in all_files]))
    unique_targets = list(dict.fromkeys(write_targets))
    
    # Subsystems
    target_subs = {extract_subsystem(f) for f in unique_targets if not is_test_file(f)}
    target_subs.discard("root")
    
    # Table rows
    table_lines = len(DATA_TABLE_REGEX.findall(prompt))
    pipe_lines = len([line for line in prompt.splitlines() if line.count("|") >= 3])
    table_row_count = max(table_lines, pipe_lines)
    
    # Directives
    directive_count = len(DIRECTIVE_REGEX.findall(prompt))
    
    return {
        "char_len": len(prompt),
        "files_count": len(unique_files),
        "target_count": len(unique_targets),
        "target_subs_count": len(target_subs),
        "table_row_count": table_row_count,
        "directive_count": directive_count,
        "is_read_only": bool(re.search(r"\b(read-only|plan mode: no file writes|audit slice)\b", prompt, re.IGNORECASE))
    }

def decide(feats: dict) -> tuple[str, list[str]]:
    hard_rejects = []
    
    # H1: Character ceiling
    if feats["char_len"] > 2500:
        hard_rejects.append(f"H1_PROMPT_TOO_LARGE({feats['char_len']}>2500)")
        
    # H2: Target count
    if feats["target_count"] >= 5 and not feats["is_read_only"]:
        hard_rejects.append(f"H2_TOO_MANY_TARGETS({feats['target_count']}>=5)")
        
    # H3: Multi-subsystem sprawl
    if feats["target_subs_count"] >= 3 and not feats["is_read_only"]:
        hard_rejects.append(f"H3_CROSS_SUBSYSTEM_SPRAWL({feats['target_subs_count']}>=3)")
        
    # H4: Inlined data table bloat
    if feats["table_row_count"] >= 35:
        hard_rejects.append(f"H4_DATA_TABLE_BLOAT({feats['table_row_count']}>=35)")
        
    if hard_rejects:
        return "REJECT", hard_rejects
        
    # Soft scoring
    score = 0
    if feats["char_len"] > 1500:
        score += 1
    if feats["target_subs_count"] >= 2 and not feats["is_read_only"]:
        score += 1
    if feats["directive_count"] >= 4:
        score += 1
    if feats["table_row_count"] >= 15:
        score += 1
        
    if score >= 2:
        return "REVIEW", [f"SCORE_{score}"]
        
    return "ADMIT", []

# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------

def run_eval():
    if not os.path.exists(DATASET_PATH):
        print(f"Error: dataset not found at {DATASET_PATH}")
        sys.exit(1)
        
    with open(DATASET_PATH, "r", encoding="utf-8") as f:
        dataset = json.load(f)
        
    print(f"Loaded {len(dataset)} prompts from {DATASET_PATH}")
    print("=" * 70)
    
    start_time = time.perf_counter()
    results = []
    
    domain_stats = {}
    
    for item in dataset:
        p_id = item["id"]
        domain = item.get("domain", "unknown")
        expected = item["expected"]
        prompt = item["prompt"]
        
        t0 = time.perf_counter()
        feats = extract_features(prompt)
        verdict, reasons = decide(feats)
        latency_us = (time.perf_counter() - t0) * 1_000_000
        
        # Concordance: ADMIT == ADMIT, REJECT == REJECT. REVIEW is acceptable for borderlines.
        match = (verdict == expected) or (expected == "REVIEW" and verdict in ("REVIEW", "ADMIT"))
        
        if domain not in domain_stats:
            domain_stats[domain] = {"total": 0, "match": 0, "admit": 0, "review": 0, "reject": 0}
            
        stats = domain_stats[domain]
        stats["total"] += 1
        if match:
            stats["match"] += 1
        stats[verdict.lower()] += 1
        
        results.append({
            "id": p_id,
            "domain": domain,
            "expected": expected,
            "verdict": verdict,
            "reasons": reasons,
            "match": match,
            "latency_us": latency_us,
        })
        
    total_time = (time.perf_counter() - start_time) * 1000
    
    total_prompts = len(results)
    total_matches = sum(1 for r in results if r["match"])
    accuracy = (total_matches / total_prompts) * 100
    avg_latency_us = sum(r["latency_us"] for r in results) / total_prompts
    
    print(f"{'Domain':<22} | {'Count':<6} | {'Concordance':<12} | {'Admit':<6} | {'Review':<6} | {'Reject':<6}")
    print("-" * 70)
    for domain, s in domain_stats.items():
        rate = (s["match"] / s["total"]) * 100
        print(f"{domain:<22} | {s['total']:<6} | {rate:>10.1f}% | {s['admit']:<6} | {s['review']:<6} | {s['reject']:<6}")
    print("-" * 70)
    print(f"Overall Concordance: {total_matches}/{total_prompts} ({accuracy:.1f}%)")
    print(f"Avg Classification Latency: {avg_latency_us:.1f} µs ({avg_latency_us/1000:.3f} ms)")
    print(f"Total Benchmark Time: {total_time:.2f} ms")
    print("=" * 70)
    
    mismatches = [r for r in results if not r["match"]]
    if mismatches:
        print(f"\nMismatches ({len(mismatches)}):")
        for m in mismatches[:10]:
            print(f"  [{m['id']}] Domain: {m['domain']}, Expected: {m['expected']}, Got: {m['verdict']} ({', '.join(m['reasons'])})")
    else:
        print("\nAll prompts matched expected classifications perfectly!")

if __name__ == "__main__":
    run_eval()
