#!/bin/bash
# Validate a committed ref in an isolated temporary worktree. Logs are kept in a unique run directory.
# Usage: scripts/gate.sh [ref=HEAD] [output-parent=.gate]
# Requires npm ci first. No downloads or dependency installation occur during validation.
set -eu
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
exec node "$SCRIPT_DIR/gate.mjs" "$@"
