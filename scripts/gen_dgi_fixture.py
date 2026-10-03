#!/usr/bin/env python3
"""
gen_dgi_fixture.py — Regenerate src/mcp/dgi_anchors.json.

Dumps the 7 calibration-anchor prompts from `.scratch/claude_session_dispatches.json`
(the DGI Gatekeeper calibration dataset) into a git-tracked fixture file that the
Rust unit tests in src/mcp/dgi.rs load via include_str!.

Run:  python3 scripts/gen_dgi_fixture.py
"""

import json

DATA = ".scratch/claude_session_dispatches.json"

# Anchor index -> (expected class, expected prompt length in chars).
#   FP  = legitimate bounded single-concern spec (must be ADMITTED)
#   MON = genuine monolith (must be REJECTED)
ANCHORS = {
    21: ("FP", "castor_m1", 1503),
    27: ("FP", "castor_m2c", 1523),
    32: ("FP", "castor_m3a", 1506),
    35: ("FP", "castor_m3b", 1571),
    11: ("MON", "rustplan_inv", 2995),
    56: ("MON", "castor_m7a", 1581),
    95: ("MON", "castor_m10_opt", 1398),
}

OUT = "src/mcp/dgi_anchors.json"


def main():
    data = json.load(open(DATA))
    out = {
        "description": (
            "DGI Gatekeeper calibration anchors: 4 audit-verified false positives "
            "(bounded single-concern specs that must be ADMITted) and 3 genuine "
            "monoliths (coupled multi-subsystem sprawl that must be REJECTed). "
            "Prompts are verbatim from .scratch/claude_session_dispatches.json; "
            "regenerate with scripts/gen_dgi_fixture.py."
        ),
        "anchors": {
            str(i): {
                "class": cls,
                "name": name,
                "expected_len": exp_len,
                "prompt": data[i]["input"]["prompt"],
            }
            for i, (cls, name, exp_len) in sorted(ANCHORS.items())
        },
    }
    with open(OUT, "w") as fh:
        json.dump(out, fh, indent=2)
        fh.write("\n")
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
