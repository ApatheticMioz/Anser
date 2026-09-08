#!/bin/bash
# Sets up symlinks in WSL pointing directly to the tracked scripts in this repo.
# The repo root is derived from this script's own location (portable across
# drives/users); the Windows-side user home is overridable via WIN_HOME.
set -e

# Repo root: this script lives at <repo>/scripts/wsl/setup_links.sh, so the
# repo root is two levels up. Derived at runtime (symlink-resolved) - no
# hardcoded drive/path.
SCRIPT_PATH="$(readlink -f "${BASH_SOURCE[0]}")"
REPO_ROOT="$(cd "$(dirname "$SCRIPT_PATH")/../.." && pwd)"
SOURCE_DIR="$REPO_ROOT/scripts/wsl"

# Windows-side user home (the Windows master .gemini). NTFS is case-insensitive,
# so the WSL username resolves to the Windows profile dir. Overridable.
WIN_HOME="${WIN_HOME:-/mnt/c/Users/$(whoami)}"

if [ ! -d "$SOURCE_DIR" ]; then
  echo "Error: $SOURCE_DIR not found. Is the Windows drive mounted?" >&2
  exit 1
fi

mkdir -p ~/qwen-serving/launchers

# Link launchers
ln -sf "$SOURCE_DIR/start_huge.sh" ~/qwen-serving/launchers/start_huge.sh
ln -sf "$SOURCE_DIR/start_fast.sh" ~/qwen-serving/launchers/start_fast.sh
ln -sf "$SOURCE_DIR/status.sh" ~/qwen-serving/launchers/status.sh
ln -sf "$SOURCE_DIR/stop_server.sh" ~/qwen-serving/launchers/stop_server.sh
ln -sf "$REPO_ROOT/mcp-qwen/stream_proxy.js" ~/qwen-serving/stream_proxy.js

# Link home helpers
ln -sf "$SOURCE_DIR/wait_ready.sh" ~/wait_ready.sh
ln -sf "$SOURCE_DIR/run_qb.sh" ~/run_qb.sh
ln -sf "$SOURCE_DIR/wait_qb.sh" ~/wait_qb.sh

# Link global Antigravity & Claude configuration
mkdir -p ~/.gemini/config ~/.claude ~/.gemini/antigravity-ide/mcp
ln -sf "$REPO_ROOT/GEMINI.md" ~/.gemini/GEMINI.md
ln -sf "$REPO_ROOT/CLAUDE.md" ~/.claude/CLAUDE.md

# Symlink Antigravity IDE lazy MCP schemas & instructions from Windows canonical master
rm -rf ~/.gemini/antigravity-ide/mcp/qwen38-local
ln -sfn "$WIN_HOME/.gemini/antigravity-ide/mcp/qwen38-local" ~/.gemini/antigravity-ide/mcp/qwen38-local

# WSL-specific MCP config pointing to POSIX index.js (break any symlink to Windows master)
rm -f ~/.gemini/config/mcp_config.json
cat << EOF > ~/.gemini/config/mcp_config.json
{
  "mcpServers": {
    "qwen38-local": {
      "command": "node",
      "args": ["$REPO_ROOT/mcp-qwen/index.js"],
      "env": {
        "QWEN_RACE_MS": "150000"
      }
    }
  }
}
EOF

# Make executable
chmod +x "$SOURCE_DIR"/*.sh

echo "All WSL symlinks and MCP configurations successfully initialized."
