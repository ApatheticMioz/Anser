#!/bin/bash
# Canonical Emergency Task Killer: Cancel in-flight tasks, kill workers, and clear slot leases.
# Note: do NOT use 'set -e' so all cleanup steps execute unconditionally.

echo "[kill_all_tasks:wsl] 1. Notifying status coordinator..."
# Try localhost:18021 (if coordinator is running in WSL)
curl -s -m 2 -X POST http://127.0.0.1:18021/tasks/cancel_all >/dev/null 2>&1 || true

# Also try Windows host IP from /etc/resolv.conf (if coordinator is on Windows host)
WIN_HOST_IP=$(grep nameserver /etc/resolv.conf 2>/dev/null | awk '{print $2}' || true)
if [ -n "$WIN_HOST_IP" ] && [ "$WIN_HOST_IP" != "127.0.0.1" ]; then
  curl -s -m 2 -X POST "http://$WIN_HOST_IP:18021/tasks/cancel_all" >/dev/null 2>&1 || true
fi

echo "[kill_all_tasks:wsl] 2. Terminating running worker processes..."
pkill -9 -f 'goose run' 2>/dev/null || true
pkill -9 -f 'avo_runner.py' 2>/dev/null || true
pkill -9 -f 'tests/canary.test.js' 2>/dev/null || true
pkill -9 -f 'tests/avo.test.js' 2>/dev/null || true

echo "[kill_all_tasks:wsl] 3. Purging slot leases..."
rm -f ~/.qwen/tasks/goose_slots/*.json 2>/dev/null || true
for user_qwen in /mnt/c/Users/*/.qwen/tasks/goose_slots; do
  if [ -d "$user_qwen" ]; then
    rm -f "$user_qwen"/*.json 2>/dev/null || true
  fi
done

echo "[kill_all_tasks:wsl] 4. Updating in-flight task records on disk..."
python3 - << 'PYEOF' 2>/dev/null || true
import json, glob, os, time

task_dirs = [os.path.expanduser("~/.qwen/tasks")]
for p in glob.glob("/mnt/c/Users/*/.qwen/tasks"):
    task_dirs.append(p)

for d in task_dirs:
    if not os.path.isdir(d):
        continue
    for f in glob.glob(os.path.join(d, "task_*.json")):
        try:
            with open(f, "r", encoding="utf-8") as fp:
                data = json.load(fp)
            if not data.get("done", False):
                data["status"] = "cancelled"
                data["done"] = True
                data["isError"] = True
                data["finishedAt"] = int(time.time() * 1000)
                data["result"] = {"isError": True, "text": "Task cancelled by emergency task killer."}
                with open(f, "w", encoding="utf-8") as fp:
                    json.dump(data, fp, indent=2)
                print(f"   -> Cancelled disk task: {os.path.basename(f)}")
        except Exception:
            pass
PYEOF

echo "[kill_all_tasks:wsl] Done. All worker processes stopped and leases cleared."
