#!/usr/bin/env bash
# init.sh — Quick health check for CodeGraph + CodeSearch indexes.
#
# Exit codes:
#   0  All indexes healthy → agent may proceed
#   1  Tools missing → agent should ask user to install + run setup.sh
#   2  Indexes not ready → agent should ask user to run setup.sh
set -euo pipefail

PROJECT_DIR="${1:-$(pwd)}"
cd "$PROJECT_DIR"

SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
SETUP_PATH="$SCRIPT_DIR/setup.sh"

if ! command -v codegraph &>/dev/null || ! command -v codesearch &>/dev/null; then
	echo "=== Missing tools ===" >&2
	echo "Install them:" >&2
	echo "  npm install -g @colbymchenry/codegraph" >&2
	echo "  cargo install --git https://github.com/flupkede/codesearch codesearch" >&2
	echo "" >&2
	echo "Then initialize indexes by copying this command into Pi's chat prompt:" >&2
	echo "  !$SETUP_PATH" >&2
	echo "(The \"!\" prefix tells Pi to run the script as a shell command.)" >&2
	echo "WARNING: On large repos, CodeSearch indexing can take an hour+." >&2
	exit 1
fi

ALL_HEALTHY=true

# --- CodeGraph health ---
if [ -d .codegraph ] && codegraph status . >/dev/null 2>&1; then
	echo "CodeGraph: ✓ initialized"
else
	echo "CodeGraph: ✗ not initialized" >&2
	ALL_HEALTHY=false
fi

# --- CodeSearch health ---
if [ -d .codesearch.db ] && codesearch stats . 2>/dev/null | grep -q "Indexed:.*✅"; then
	echo "CodeSearch: ✓ initialized"
else
	echo "CodeSearch: ✗ not initialized" >&2
	ALL_HEALTHY=false
fi

if [ "$ALL_HEALTHY" = false ]; then
	echo "---" >&2
	echo "Initialize indexes by copying this command into Pi's chat prompt:" >&2
	echo "  !$SETUP_PATH" >&2
	echo "(The \"!\" prefix tells Pi to run the script as a shell command.)" >&2
	echo "WARNING: On large repos, CodeSearch indexing can take an hour+." >&2
	echo "" >&2
	echo "⚠ Agent: skip CodeSearch/CodeGraph tools this round (indexes not ready)." >&2
	exit 2
fi

echo "All indexes healthy"
