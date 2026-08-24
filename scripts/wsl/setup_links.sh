#!/bin/bash
# Sets up symlinks in WSL pointing directly to the tracked scripts in /mnt/d/LLM_Ecosystem
set -e

SOURCE_DIR="/mnt/d/LLM_Ecosystem/scripts/wsl"

if [ ! -d "$SOURCE_DIR" ]; then
  echo "Error: $SOURCE_DIR not found. Is /mnt/d mounted?" >&2
  exit 1
fi

mkdir -p ~/qwen-serving/launchers

# Link launchers
ln -sf "$SOURCE_DIR/start_huge.sh" ~/qwen-serving/launchers/start_huge.sh
ln -sf "$SOURCE_DIR/start_fast.sh" ~/qwen-serving/launchers/start_fast.sh
ln -sf "$SOURCE_DIR/status.sh" ~/qwen-serving/launchers/status.sh
ln -sf "$SOURCE_DIR/stop_server.sh" ~/qwen-serving/launchers/stop_server.sh

# Link home helpers
ln -sf "$SOURCE_DIR/wait_ready.sh" ~/wait_ready.sh
ln -sf "$SOURCE_DIR/run_qb.sh" ~/run_qb.sh
ln -sf "$SOURCE_DIR/wait_qb.sh" ~/wait_qb.sh

# Make executable
chmod +x "$SOURCE_DIR"/*.sh

echo "All WSL symlinks successfully created and pointing to $SOURCE_DIR."
