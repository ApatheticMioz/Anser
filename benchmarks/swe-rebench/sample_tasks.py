#!/usr/bin/env python3
"""Sample N tasks from a SWE-rebench-leaderboard monthly split.

Writes sampled instance_ids (+ the fields the solve step needs) to
predictions/sample_<split>_<n>.jsonl. Deterministic given --seed, so the same
sample can be re-solved or re-graded without re-drawing.

Usage:
    venv/bin/python sample_tasks.py --split 2026_03 --n 50 --seed 20260824
"""
import argparse
import json
import random
from pathlib import Path

from datasets import load_dataset

HERE = Path(__file__).resolve().parent


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--split", default="2026_03",
                     help="Monthly split name, e.g. 2026_03. This is the most "
                          "recent split published to nebius/SWE-rebench-leaderboard "
                          "as of 2026-08-24 - check availability before assuming "
                          "a newer one exists (get_dataset_config_names lists only "
                          "'default'; splits are discovered via the dataset's own "
                          "error message or the HF dataset viewer).")
    ap.add_argument("--n", type=int, default=50)
    ap.add_argument("--seed", type=int, default=20260824)
    ap.add_argument("--out", default=None,
                     help="Output path; defaults to predictions/sample_<split>_<n>.jsonl")
    args = ap.parse_args()

    ds = load_dataset("nebius/SWE-rebench-leaderboard", split=args.split)
    n_available = len(ds)
    if args.n > n_available:
        raise SystemExit(f"Requested {args.n} tasks but split {args.split} only has {n_available}")

    rng = random.Random(args.seed)
    indices = rng.sample(range(n_available), args.n)

    out_path = Path(args.out) if args.out else HERE / "predictions" / f"sample_{args.split}_{args.n}.jsonl"
    out_path.parent.mkdir(parents=True, exist_ok=True)

    with out_path.open("w", encoding="utf-8") as f:
        for i in indices:
            row = ds[i]
            f.write(json.dumps({
                "instance_id": row["instance_id"],
                "repo": row["repo"],
                "base_commit": row["base_commit"],
                "problem_statement": row["problem_statement"],
                "docker_image": row.get("docker_image") or row.get("image_name"),
                "install_config": row["install_config"],
                # test_patch/FAIL_TO_PASS/PASS_TO_PASS deliberately NOT written here -
                # the solve step must never see them. The grading step reads them
                # straight from the HF dataset by instance_id instead.
            }, ensure_ascii=False) + "\n")

    print(f"Sampled {args.n} of {n_available} tasks from split {args.split} -> {out_path}")
    print("Repos touched:", sorted({json.loads(l)["repo"] for l in out_path.read_text(encoding='utf-8').splitlines()}))


if __name__ == "__main__":
    main()
