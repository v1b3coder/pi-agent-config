#!/usr/bin/env bash
# setup.sh — One-time setup for CodeGraph + CodeSearch indexes.
# Run this when init.sh tells you to, or after installing tools from scratch.
# Idempotent — safe to re-run.
#
# CodeSearch indexing embeds the entire codebase — on large projects this can
# take hours. To survive agent tool-call timeouts, the indexer is launched as
# a detached background process (via disown). A lockfile protocol tracks
# state: lockfile present = busy or broken; no lockfile = stable.
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

# =====================================================
# CodeGraph — fast enough to run in foreground
# =====================================================
if [ -d .codegraph ] && codegraph status . >/dev/null 2>&1; then
	echo "CodeGraph: already initialized"
else
	echo "CodeGraph: initializing..."
	codegraph init --index .
	echo "CodeGraph: done"
fi

# =====================================================
# CodeSearch — embedding can take HOURS on large repos
#
# Protocol: a single lockfile (init.lock) signals state.
#   present + PID alive  → worker running, wait
#   present + PID dead   → worker finished/crashed — verify DB health
#   absent               → stable (externally indexed, or worker completed)
#
# The worker writes its PID to init.lock on start, removes it on exit.
# A brief race exists where the worker finishes between our "read PID"
# and "kill -0" — resolved by checking actual DB health in that path.
# =====================================================
MODEL="bge-small-q"
CS_DIR=".codesearch.db"
LOCKFILE="$CS_DIR/init.lock"
LOGFILE="$CS_DIR/init.log"

# --- model-switch detection (wipe & restart if model changed) ---
if [ -f "$CS_DIR/file_meta.json" ]; then
	CURRENT_MODEL=$(python3 -c "import json; print(json.load(open('$CS_DIR/file_meta.json')).get('model_name',''))" 2>/dev/null || true)
	if [ -n "$CURRENT_MODEL" ] && [ "$CURRENT_MODEL" != "$MODEL" ]; then
		echo "CodeSearch: model $CURRENT_MODEL → $MODEL, wiping stale index..."
		rm -rf "$CS_DIR"
		had_cs=false
	fi
fi

# --- state machine ---
if [ -f "$LOCKFILE" ]; then
	LOCK_PID=$(cat "$LOCKFILE" 2>/dev/null || echo "")

	if [ -n "$LOCK_PID" ] && kill -0 "$LOCK_PID" 2>/dev/null; then
		# Worker is still running — wait for it
		echo "CodeSearch: background index in progress (PID $LOCK_PID), waiting..."
		tail -3 "$LOGFILE" 2>/dev/null | sed 's/^/  │ /'
		SECONDS=0
		while kill -0 "$LOCK_PID" 2>/dev/null; do
			if [ $((SECONDS % 60)) -eq 0 ]; then
				printf "  … waiting %dm — last line: " $((SECONDS / 60))
				tail -1 "$LOGFILE" 2>/dev/null
			fi
			sleep 10
		done
		# Worker exited — it should have removed the lockfile by now
		if [ -f "$LOCKFILE" ]; then
			# Worker died without cleaning up lockfile
			rm -f "$LOCKFILE"
		fi
		echo "CodeSearch: background indexing $(codesearch stats . 2>/dev/null | grep -q 'Indexed:.*✅' && echo 'completed' || echo 'FAILED — run setup.sh again to retry')"

	elif [ -d "$CS_DIR" ]; then
		# Lockfile present but PID dead. Two possibilities:
		#   a) Worker just finished (removed lockfile would follow, but we read it first)
		#   b) Worker crashed (stale lock from timeout / OOM / reboot)
		# Disambiguate by checking actual DB health.
		if codesearch stats . 2>/dev/null | grep -q "Indexed:.*✅"; then
			rm -f "$LOCKFILE"
			echo "CodeSearch: already initialized (background indexing completed)"
		else
			echo "CodeSearch: previous index was interrupted (stale lock), reindexing..."
			rm -f "$LOCKFILE"
			rm -rf "$CS_DIR"
			had_cs=false
		fi
	else
		# Lockfile but no .codesearch.db at all — truly stale
		echo "CodeSearch: previous index was interrupted (stale lock), reindexing..."
		rm -f "$LOCKFILE"
		had_cs=false
	fi
fi

# --- launch background indexer if lockfile is gone (stable state) ---
if [ ! -f "$LOCKFILE" ]; then
	if [ -d "$CS_DIR" ] && codesearch stats . 2>/dev/null | grep -q "Indexed:.*✅"; then
		# Database exists and is healthy — externally indexed, or worker completed earlier
		echo "CodeSearch: already initialized"
	else
		mkdir -p "$CS_DIR"

		echo "CodeSearch: launching background indexer (this can take a long time)..."
		echo "  PID file: $LOCKFILE"
		echo "  Log file: $LOGFILE"
		echo "  The indexer will keep running even if the agent times out."
		echo "  Next 'setup.sh' call will detect and wait for completion."

		(
			# Isolate: own PID, own signal mask — survive parent death
			echo "$$" > "$LOCKFILE"
			trap '' HUP INT TERM PIPE

			cd "$PROJECT_DIR"

			codesearch setup --model "$MODEL" 2>/dev/null
			codesearch index --model "$MODEL" . 2>&1

			# Verify — if still not healthy, force full rebuild
			if ! codesearch stats . 2>/dev/null | grep -q "Indexed:.*✅"; then
				echo "[setup.sh worker] index not healthy after first pass, forcing full rebuild..." >&2
				codesearch index --force --model "$MODEL" . 2>&1
			fi

			if codesearch stats . 2>/dev/null | grep -q "Indexed:.*✅"; then
				echo "[setup.sh worker] indexing completed successfully" >&2
			else
				echo "[setup.sh worker] FATAL: index still not healthy after rebuild" >&2
			fi

			rm -f "$LOCKFILE"
		) >> "$LOGFILE" 2>&1 &

		BG_PID=$!
		# disown "$BG_PID" 2>/dev/null || true

		# Brief pause to catch immediate failures (missing model, disk error, …)
		sleep 3
		if [ -f "$LOCKFILE" ] && kill -0 "$(cat "$LOCKFILE" 2>/dev/null)" 2>/dev/null; then
			echo "  → PID $(cat "$LOCKFILE") is running"
		elif [ ! -f "$LOCKFILE" ]; then
			if grep -q "FATAL" "$LOGFILE" 2>/dev/null; then
				echo "  → failed immediately — check $LOGFILE"
			else
				echo "  → completed instantly"
			fi
		else
			echo "  → check $LOGFILE for errors"
		fi
	fi
fi

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

echo "Setup complete (CodeSearch may still be indexing in background)"
