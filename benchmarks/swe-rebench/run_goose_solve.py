#!/usr/bin/env python3
"""Drive Goose+Qwen against a sampled SWE-rebench task set. GPU-INTENSIVE - not
run as part of setup; run manually once the sample and grading steps are
approved.

Runs on the WINDOWS side (not WSL) - Goose here is goose.exe
(%USERPROFILE%\\.local\\bin\\goose.exe), a Windows binary, matching how
mcp-qwen/index.js drives it. Repos are cloned to a Windows scratch directory
and Goose talks to vLLM over http://localhost:18020, same env-var contract
as mcp-qwen/index.js's goose spawn (GOOSE_PROVIDER/GOOSE_MODEL/
OPENAI_BASE_URL/OPENAI_API_KEY - kept in sync with index.js; if its env
contract ever changes, mirror the change in goose_env() below).

For each task: clone the repo at base_commit, run Goose (--no-session, one
fresh process per task, no cross-task memory) with only problem_statement as
the prompt - never test_patch/FAIL_TO_PASS/PASS_TO_PASS, which stay held out
for grading - let it edit files, then capture `git diff` as the model_patch.
Appends one line per task to a predictions JSONL in the format
swebench.harness.run_evaluation expects:
    {"instance_id": ..., "model_name_or_path": ..., "model_patch": ...}

Resumable: skips any instance_id already present in --out, so a killed/timed-out
run can just be re-invoked.

Usage (from a Windows Python, e.g. `py -3.11`):
    python run_goose_solve.py ^
        --tasks predictions\\sample_2026_03_50.jsonl ^
        --out predictions\\goose_qwen_2026_03_50.jsonl ^
        --workdir %USERPROFILE%\\AppData\\Local\\Temp\\swe-rebench-scratch ^
        --timeout 900
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

# User profile dir: USERPROFILE on Windows, $HOME elsewhere. Derived at
# runtime so no personal username is hardcoded in this file.
_USERPROFILE = os.environ.get("USERPROFILE") or os.path.expanduser("~")

# Goose is a Windows binary; locate it under the user's profile dir
# (override with the GOOSE_EXE env var if it lives elsewhere).
GOOSE_EXE = os.environ.get(
    "GOOSE_EXE",
    os.path.join(_USERPROFILE, ".local", "bin", "goose.exe"),
)
MODEL_NAME_OR_PATH = "qwen3.8-27b-goose-huge"  # CTX=huge/DFlash2/KVarN - this repo's default config
VLLM_PORT = 18020


def goose_env(cwd):
    import os
    # Mirrors mcp-qwen/index.js's goose env contract exactly (verified
    # config-less on native goose.exe 1.39.0, 2026-08-29): OPENAI_BASE_URL,
    # not the older OPENAI_HOST/OPENAI_BASE_PATH pair this script used before.
    # vLLM does not authenticate, so the key is the same "dummy" placeholder
    # the server sends.
    env = os.environ.copy()
    env.update({
        "GOOSE_WORKING_DIR": str(cwd),
        "GOOSE_PROVIDER": "openai",
        "GOOSE_MODEL": "qwen3.8-27b",
        "OPENAI_BASE_URL": f"http://localhost:{VLLM_PORT}/v1",
        "OPENAI_API_KEY": "dummy",
    })
    return env


def load_tasks(path):
    with open(path, encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def already_done(out_path):
    if not Path(out_path).exists():
        return set()
    done = set()
    with open(out_path, encoding="utf-8") as f:
        for line in f:
            if line.strip():
                done.add(json.loads(line)["instance_id"])
    return done


def solve_one(task, workdir, timeout_s):
    import tempfile
    inst = task["instance_id"]
    Path(workdir).mkdir(parents=True, exist_ok=True)
    # A fresh unique dir per attempt, not workdir/instance_id - a prior crashed
    # run can leave a locked/undeletable directory behind on Windows (observed:
    # WinError 183 on mkdir after rmtree silently no-oped on a locked .git
    # internal file), and git clone refuses a non-empty target either way.
    repo_dir = Path(tempfile.mkdtemp(prefix=f"{inst}_", dir=workdir))
    try:
        repo_url = f"https://github.com/{task['repo']}.git"
        subprocess.run(["git", "clone", "--quiet", repo_url, str(repo_dir)], check=True, timeout=600)
        subprocess.run(["git", "checkout", "--quiet", task["base_commit"]], cwd=repo_dir, check=True, timeout=60)

        prompt = (
            f"You are working in the repository at {repo_dir} (already checked out "
            f"at the correct base commit - do not run git checkout/pull/fetch).\n\n"
            f"Problem to fix:\n{task['problem_statement']}\n\n"
            f"Make the minimal code change(s) needed to fix this. Do not write or "
            f"modify test files - only fix the underlying issue. Do not run any "
            f"build, typecheck, lint, or test commands; do not attempt to verify "
            f"your fix by running the test suite. When you believe the fix is "
            f"complete, stop."
        )

        rc, stderr_tail = None, ""
        try:
            result = subprocess.run(
                [GOOSE_EXE, "run", "--no-session", "-t", prompt],
                cwd=repo_dir,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=timeout_s,
                env=goose_env(repo_dir),
            )
            rc, stderr_tail = result.returncode, (result.stderr or "")[-2000:]
        except subprocess.TimeoutExpired:
            # subprocess.run's own timeout already killed the goose.exe child,
            # but any files it wrote before being killed are still on disk -
            # capture git diff anyway instead of discarding real partial work.
            # Caller distinguishes this from a real success via rc=-1/"TIMEOUT".
            rc, stderr_tail = -1, "TIMEOUT"

        diff = subprocess.run(
            ["git", "diff"], cwd=repo_dir, capture_output=True, text=True,
            encoding="utf-8", errors="replace", check=True,
        ).stdout

        return diff, rc, stderr_tail
    finally:
        # best-effort - a locked file (goose.exe/git process not fully exited,
        # AV scan) just leaves an orphaned dir under --workdir, harmless beyond
        # disk space; does not block the next task since each gets a fresh
        # mkdtemp dir now.
        shutil.rmtree(repo_dir, ignore_errors=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tasks", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--workdir",
                    default=os.path.join(_USERPROFILE, "AppData", "Local", "Temp", "swe-rebench-scratch"))
    ap.add_argument("--timeout", type=int, default=900,
                     help="Per-task Goose timeout in seconds. Matches this repo's "
                          "own 900s ceiling for extension-bearing delegate calls "
                          "(mcp-qwen/index.js DELEGATE_TIMEOUT_MS + "
                          "EXTENSION_TIMEOUT_BONUS_MS); real SWE tasks may need more - "
                          "raise this if early runs show frequent timeouts rather than "
                          "genuine failures.")
    args = ap.parse_args()

    tasks = load_tasks(args.tasks)
    done = already_done(args.out)
    todo = [t for t in tasks if t["instance_id"] not in done]
    print(f"{len(done)} already done, {len(todo)} remaining of {len(tasks)}")

    Path(args.workdir).mkdir(parents=True, exist_ok=True)

    with open(args.out, "a", encoding="utf-8") as out_f:
        for i, task in enumerate(todo, 1):
            inst = task["instance_id"]
            print(f"[{i}/{len(todo)}] {inst} ({task['repo']}) ...", file=sys.stderr)
            try:
                diff, rc, stderr_tail = solve_one(task, args.workdir, args.timeout)
            except subprocess.TimeoutExpired:
                print(f"  TIMEOUT after {args.timeout}s", file=sys.stderr)
                diff, rc, stderr_tail = "", -1, "TIMEOUT"
            except Exception as e:
                print(f"  ERROR: {e}", file=sys.stderr)
                diff, rc, stderr_tail = "", -1, str(e)

            out_f.write(json.dumps({
                "instance_id": inst,
                "model_name_or_path": MODEL_NAME_OR_PATH,
                "model_patch": diff,
                "_goose_returncode": rc,
                "_goose_stderr_tail": stderr_tail,
            }, ensure_ascii=False) + "\n")
            out_f.flush()

    print(f"Done. Predictions in {args.out}")


if __name__ == "__main__":
    main()
