#!/bin/bash
# Canonical Emergency Task Killer: Cancel in-flight tasks, kill goose workers, and clear slot leases.
set -e

echo "[kill_all_tasks] Notifying status coordinator (:18021)..."
curl -s -X POST http://127.0.0.1:18021/tasks/cancel_all >/dev/null 2>&1 || true

echo "[kill_all_tasks] Terminating running goose processes..."
pkill -9 -f 'goose run' 2>/dev/null || true
pkill -9 -f 'avo_runner.py' 2>/dev/null || true

echo "[kill_all_tasks] Purging stale goose slot leases..."
rm -f ~/.qwen/tasks/goose_slots/*.json 2>/dev/null || true
rm -f /mnt/c/Users/Apath/.qwen/tasks/goose_slots/*.json 2>/dev/null || true

echo "[kill_all_tasks] Done. All tasks cancelled and GPU idled."
