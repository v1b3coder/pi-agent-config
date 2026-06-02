#!/usr/bin/env bash
# init.sh — Initialize CodeGraph + CodeSearch for the current project.
# Idempotent: safe to call repeatedly. Prints install help if tools missing.
set -euo pipefail

PROJECT_DIR="${1:-$(pwd)}"
cd "$PROJECT_DIR"

did_init=false

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
	did_init=true
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
fi

DB_OK=false
if [ -d .codesearch.db ] && codesearch stats . >/dev/null 2>&1; then
	# Verify the search index is actually usable (not interrupted mid-index)
	if codesearch search --compact --json "__init_healthcheck" 2>/dev/null | grep -q "results"; then
		echo "CodeSearch: already initialized ($MODEL)"
		DB_OK=true
	fi
fi

if [ "$DB_OK" != true ]; then
	if [ -d .codesearch.db ]; then
		echo "CodeSearch: database broken or incomplete, reindexing..."
		rm -rf .codesearch.db
	fi
	echo "CodeSearch: setting up $MODEL model (code-specific)..."
	codesearch setup --model "$MODEL" 2>/dev/null
	echo "CodeSearch: indexing..."
	codesearch index --model "$MODEL" .
	did_init=true
	echo "CodeSearch: done"
fi

# --- .gitignore (only if something was actually initialized) ---
if [ "$did_init" = true ] && [ -f .gitignore ]; then
	for entry in .codegraph/ .codesearch.db/; do
		if ! grep -qFx "$entry" .gitignore 2>/dev/null; then
			echo "$entry" >> .gitignore
			echo "Added $entry to .gitignore"
		fi
	done
fi
