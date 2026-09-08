#!/usr/bin/env python3
"""Deterministic wedge-reproduction harness for the KVarN engine livelock.

Drives vLLM at localhost:18020 in the exact shape that wedges the engine in
production: T1 = long synthetic prompt (chunked prefill, length swept across
residues mod 128 - prefix-match-unit is 128), T2/T3 = follow-ups that hit the
prefix cache (same message prefix). Health-checked between iterations with a
1-token canary (30s abort). On wedge: py-spy dump of EngineCore (sudo -S),
engine log tail, restart the engine under the same arm env, continue.

Usage (from Windows Python):
    python repro.py --arm full       --iters 30
    python repro.py --arm piecewise  --iters 30
    python repro.py --arm maxq4096   --iters 30

Arm env mapping (boot + restart):
    full       : (nothing - current config, FULL captured verify)
    piecewise  : CUDAGRAPH_MODE=PIECEWISE      (start_qwen.sh l.326)
    maxq4096   : KVARN_FUSED_VERIFY_MAXQ=4096  (routes continuations off the
                                                materialize route)

Writes results to logs/<arm>/iter_NNN.jsonl + logs/<arm>/summary.json.
Deterministic: the synthetic corpus is seeded - T1 prefixes are identical
across arms, so prefix-cache behaviour matches.
"""
import argparse
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

BASE = "http://localhost:18020"
WSL_DISTRO = "Ubuntu"
# Sudo password for the py-spy dump, read from the environment (never
# hardcoded). If unset, the dump step prompts the operator interactively
# (see _sudo_pass()) so the value is never written to a tracked file.
SUDO_PASS = os.environ.get("SUDO_PASS", "")
REPRO_DIR = Path(__file__).parent

ARM_ENV = {
    "full": {},
    "piecewise": {"CUDAGRAPH_MODE": "PIECEWISE"},
    "maxq4096": {"KVARN_FUSED_VERIFY_MAXQ": "4096"},
}

# ~4 chars/token in this corpus family; 30k tokens ~= 120k chars. Swept in
# ~1.3k-char (few-hundred-token) steps so residues mod 128 vary per iteration.
CORPUS_BASE_TOKENS = 24000
CORPUS_STEP_TOKENS = 317  # deliberately not a multiple of anything


def wsl(cmd: str, timeout: int = 120) -> str:
    """Run a bash command inside WSL Ubuntu, return stdout."""
    r = subprocess.run(
        ["wsl.exe", "-d", WSL_DISTRO, "--", "bash", "-c", cmd],
        capture_output=True, text=True, timeout=timeout,
        errors="replace",
    )
    return (r.stdout or "") + (r.stderr or "")


def http_post(url: str, payload: dict, timeout: float) -> dict:
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read())


def chat(messages: list, max_tokens: int, timeout: float, temperature: float = 1.0) -> dict:
    return http_post(
        f"{BASE}/v1/chat/completions",
        {"model": "qwen3.8-27b", "messages": messages, "max_tokens": max_tokens,
         "temperature": temperature},
        timeout=timeout,
    )


def canary(timeout: float = 30.0) -> bool:
    """True = engine healthy (tokens produced within timeout)."""
    try:
        j = chat([{"role": "user", "content": "Reply with: ok"}], 8, timeout)
        return (j.get("usage", {}).get("completion_tokens", 0) >= 1)
    except Exception:
        return False


def engine_pids() -> dict:
    out = wsl("ps aux | grep -E 'vllm serve|EngineCore' | grep -v grep "
              "| awk '{print $2\":\"$11\" \"$12}'")
    pids = {}
    for line in out.splitlines():
        line = line.strip()
        if ":" not in line:
            continue
        pid, rest = line.split(":", 1)
        if "EngineCore" in rest:
            pids["engine_core"] = pid.strip()
        else:
            pids["api"] = pid.strip()
    return pids


def wait_engine_ready(boot_timeout: float = 600) -> bool:
    t0 = time.time()
    while time.time() - t0 < boot_timeout:
        try:
            with urllib.request.urlopen(f"{BASE}/v1/models", timeout=3) as r:
                if r.status == 200:
                    return True
        except Exception:
            pass
        time.sleep(5)
    return False


def stop_engine():
    wsl("pkill -9 -f 'vllm serve'; pkill -9 -f EngineCore; sleep 3", timeout=60)


def start_engine(arm: str):
    env_prefix = " ".join(f"{k}={v}" for k, v in ARM_ENV[arm].items())
    # start_qwen.sh reads CUDAGRAPH_MODE / KVARN_FUSED_VERIFY_MAXQ directly from
    # the environment (verified at l.326 / kvarn_attn.py:2485), and env vars
    # propagate through the bash exec chain inside WSL.
    wsl(
        "cd ~/qwen-serving && "
        f"env {env_prefix} nohup bash launchers/start_huge.sh "
        # sleep keeps the wsl.exe session alive long enough for the nohup'd
        # process to fully detach - exiting instantly lets WSL tear down the
        # whole process tree (observed: 0-byte boot log, no engine).
        "> /tmp/mcp_launch_huge.log 2>&1 < /dev/null & disown; sleep 3; echo started",
        timeout=60,
    )


def _sudo_pass() -> str:
    """Return the sudo password for the py-spy dump.

    Read from the SUDO_PASS environment variable; if it is not set, prompt
    the operator interactively (hidden input) so the value is never stored
    in a tracked file. Returns "" if the operator declines, in which case
    the caller skips the privileged dump.
    """
    if SUDO_PASS:
        return SUDO_PASS
    try:
        import getpass
        return getpass.getpass(
            "SUDO_PASS not set - enter sudo password for py-spy dump (blank to skip): "
        )
    except (EOFError, KeyboardInterrupt):
        return ""


def capture_wedge_evidence(arm: str, it: int, logdir: Path):
    pids = engine_pids()
    core = pids.get("engine_core")
    ts = time.strftime("%H%M%S")
    if core:
        # py-spy lives in the WSL user's home; $HOME expands to the running
        # user's home (no hardcoded username). The sudo password comes from
        # the environment / interactive prompt, never a hardcoded constant.
        sp = _sudo_pass()
        if sp:
            dump = wsl(
                f"echo {sp} | sudo -S $HOME/qwen-serving/venv/bin/py-spy "
                f"dump --pid {core} 2>&1",
                timeout=120,
            )
            (logdir / f"wedge_{it:03d}_{ts}_pyspy.txt").write_text(dump, encoding="utf-8")
        else:
            print("  (SUDO_PASS not set - skipping privileged py-spy dump)", file=sys.stderr)
    tail = wsl("tail -c 20000 /tmp/mcp_launch_huge.log | tr '\\r' '\\n' | tail -60",
               timeout=60)
    (logdir / f"wedge_{it:03d}_{ts}_englog.txt").write_text(tail, encoding="utf-8")


def make_corpus(tokens: int) -> str:
    """Deterministic pseudo-prose of ~tokens tokens. Seeded -> identical
    prefixes across arms and runs."""
    words = [
        "alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf",
        "hotel", "india", "juliet", "kilo", "lima", "mike", "november",
        "oscar", "papa", "quebec", "romeo", "sierra", "tango", "uniform",
        "victor", "whiskey", "xray", "yankee", "zulu",
    ]
    n_words = int(tokens * 1.35)  # ~1.35 words/token for this word list
    parts = []
    for i in range(n_words):
        # xorshift-ish deterministic PRNG, no imports needed for determinism
        h = (i * 2654435761 + 1013904223) & 0xFFFFFFFF
        parts.append(words[h % len(words)])
        if i % 12 == 11:
            parts.append(".")
        if i % 24 == 23:
            parts.append("\n")
    return " ".join(parts)


def run_iteration(it: int, t1_tokens: int, max_tokens: int) -> dict:
    corpus = make_corpus(t1_tokens)
    sys_msg = "You are a careful reading assistant. Answer strictly from the document."
    user_q = "Summarize the overall structure of the document in two sentences."
    msgs1 = [
        {"role": "system", "content": sys_msg},
        {"role": "user", "content": f"Document:\n{corpus}\n\n{user_q}"},
    ]
    rec = {"iter": it, "t1_tokens": t1_tokens, "residue": t1_tokens % 128,
           "t1_ok": False, "t2_ok": False, "t3_ok": False,
           "t1_s": None, "t2_s": None, "t1_gen_tps": None}

    t0 = time.time()
    try:
        j1 = chat(msgs1, max_tokens=max_tokens, timeout=PROMPT_TIMEOUT)
        rec["t1_s"] = round(time.time() - t0, 1)
        usage = j1.get("usage", {})
        if usage.get("completion_tokens", 0) >= 1:
            rec["t1_ok"] = True
            if rec["t1_s"] and usage.get("completion_tokens"):
                # decode-rate estimate ignores prefill; conservative
                rec["t1_gen_tps"] = round(
                    usage["completion_tokens"] / max(rec["t1_s"] - 2, 0.1), 1)
        rec["assistant"] = (j1["choices"][0]["message"].get("content") or "")[:200]
    except Exception as e:
        rec["t1_err"] = str(e)[:200]
        return rec

    # T2/T3: same prefix + assistant turn + short question -> prefix-cache hit
    answer = (j1["choices"][0]["message"].get("content") or "ok")
    msgs2 = msgs1 + [
        {"role": "assistant", "content": answer},
        {"role": "user", "content": "How many sections did the document appear to have?"},
    ]
    t0 = time.time()
    try:
        j2 = chat(msgs2, max_tokens=64, timeout=PROMPT_TIMEOUT)
        rec["t2_s"] = round(time.time() - t0, 1)
        rec["t2_ok"] = j2.get("usage", {}).get("completion_tokens", 0) >= 1
    except Exception as e:
        rec["t2_err"] = str(e)[:200]
    return rec


PROMPT_TIMEOUT = 240.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--arm", choices=list(ARM_ENV), required=True)
    ap.add_argument("--iters", type=int, default=30)
    ap.add_argument("--max-tokens", type=int, default=48)
    ap.add_argument("--no-boot", action="store_true",
                    help="use the already-running engine (env must match arm)")
    args = ap.parse_args()

    logdir = REPRO_DIR / "logs" / args.arm
    logdir.mkdir(parents=True, exist_ok=True)
    results = []

    if not args.no_boot:
        print(f"[{args.arm}] stopping + booting engine with env {ARM_ENV[args.arm]} ...")
        stop_engine()
        start_engine(args.arm)
        if not wait_engine_ready():
            print("FATAL: engine did not come up", file=sys.stderr)
            sys.exit(1)
        # graph capture may lag the API port; small canary delay
        time.sleep(10)
    else:
        assert canary(), "engine not healthy at start (--no-boot)"

    wedges = 0
    for it in range(1, args.iters + 1):
        t1_tokens = CORPUS_BASE_TOKENS + (it - 1) * CORPUS_STEP_TOKENS
        print(f"[{args.arm}] iter {it}/{args.iters}: T1~{t1_tokens} tokens "
              f"(residue {t1_tokens % 128}) ...", flush=True)
        rec = run_iteration(it, t1_tokens, args.max_tokens)
        rec["canary_ok"] = canary()
        # Wedge = ENGINE-level stall (canary cannot get tokens), not a slow T1:
        # the first big-prompt request after a cold boot legitimately JITs
        # several Triton kernels (measured: minutes), which a 240s T1 timeout
        # would otherwise misclassify.
        rec["wedge"] = not rec["canary_ok"]
        if not rec["t1_ok"] and rec["canary_ok"]:
            rec["t1_timeout_engine_healthy"] = True
        if rec["wedge"]:
            wedges += 1
            print(f"  !! WEDGE #{wedges} at iter {it} (t1_ok={rec['t1_ok']} "
                  f"canary_ok={rec['canary_ok']}) - capturing evidence + restart")
            capture_wedge_evidence(args.arm, it, logdir)
            stop_engine()
            start_engine(args.arm)
            if not wait_engine_ready():
                print("FATAL: engine did not come back", file=sys.stderr)
                sys.exit(2)
            time.sleep(10)
        results.append(rec)
        with open(logdir / "iterations.jsonl", "a", encoding="utf-8") as f:
            f.write(json.dumps(rec) + "\n")
        print(f"  -> t1_ok={rec['t1_ok']} t2_ok={rec['t2_ok']} "
              f"t1_s={rec['t1_s']} tps={rec['t1_gen_tps']} wedge={rec['wedge']}",
              flush=True)

    gen_tps = [r["t1_gen_tps"] for r in results if r.get("t1_gen_tps")]
    summary = {
        "arm": args.arm,
        "iters": args.iters,
        "wedges": wedges,
        "t1_ok": sum(1 for r in results if r["t1_ok"]),
        "t2_ok": sum(1 for r in results if r["t2_ok"]),
        "mean_gen_tps": round(sum(gen_tps) / len(gen_tps), 1) if gen_tps else None,
        "env": ARM_ENV[args.arm],
    }
    (logdir / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
