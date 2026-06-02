#!/usr/bin/env bash
# init.sh — Initialize CodeGraph + CodeSearch for the current project.
# Idempotent: safe to call repeatedly. Prints install help if tools missing.
set -euo pipefail

PROJECT_DIR="${1:-$(pwd)}"
cd "$PROJECT_DIR"

if ! command -v codegraph &>/dev/null || ! command -v codesearch &>/dev/null; then
	echo "=== Missing tools ===" >&2
	echo "Install them first:" >&2
	echo "  npm install -g @colbymchenry/codegraph" >&2
	echo "  cargo install --git https://github.com/flupkede/codesearch codesearch" >&2
	exit 1
fi

# --- CodeGraph ---
if [ -d .codegraph ] && codegraph status . >/dev/null 2>&1; then
	echo "CodeGraph: already initialized"
else
	echo "CodeGraph: initializing..."
	codegraph init --index .
	echo "CodeGraph: done"
fi

# --- CodeSearch ---
if codesearch stats . >/dev/null 2>&1; then
	echo "CodeSearch: already initialized"
else
	echo "CodeSearch: setting up model..."
	codesearch setup 2>/dev/null
	echo "CodeSearch: indexing..."
	codesearch index .
	echo "CodeSearch: done"
fi
