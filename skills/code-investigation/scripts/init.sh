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

had_cg=false; [ -d .codegraph ] && had_cg=true
had_cs=false; [ -d .codesearch.db ] && had_cs=true

# --- CodeGraph ---
if [ -d .codegraph ] && codegraph status . >/dev/null 2>&1; then
	echo "CodeGraph: already initialized"
else
	echo "CodeGraph: initializing..."
	codegraph init --index .
	echo "CodeGraph: done"
fi

# --- CodeSearch ---
MODEL="jina-code"
CURRENT_MODEL=""
if [ -f .codesearch.db/file_meta.json ]; then
	CURRENT_MODEL=$(python3 -c "import json; print(json.load(open('.codesearch.db/file_meta.json')).get('model_name',''))" 2>/dev/null || true)
fi

if [ -n "$CURRENT_MODEL" ] && [ "$CURRENT_MODEL" != "$MODEL" ]; then
	echo "CodeSearch: switching model $CURRENT_MODEL → $MODEL, reindexing..."
	rm -rf .codesearch.db
	had_cs=false
fi

echo "CodeSearch: syncing ($MODEL)..."
codesearch setup --model "$MODEL" 2>/dev/null
codesearch index --model "$MODEL" .

if ! codesearch stats . 2>/dev/null | grep -q "Indexed:.*✅"; then
	echo "CodeSearch: index not built yet, rebuilding..."
	codesearch index --force --model "$MODEL" .
fi

echo "CodeSearch: done"

# --- .gitignore (only when a new DB was created) ---
if [ "$had_cg" = false ] || [ "$had_cs" = false ]; then
	if [ -f .gitignore ]; then
		for entry in .codegraph/ .codesearch.db/; do
			if ! grep -qFx "$entry" .gitignore 2>/dev/null; then
				echo "$entry" >> .gitignore
				echo "Added $entry to .gitignore"
			fi
		done
	fi
fi
