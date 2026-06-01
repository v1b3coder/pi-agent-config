#!/usr/bin/env bash
# codesearch-server.sh — ensure codesearch serve daemon is running
set -euo pipefail

CODESEARCH_PORT=${CODESEARCH_SERVE_PORT:-39725}
SERVE_PID=""

find_serve() {
	SERVE_PID=""
	local pid
	pid=$(lsof -ti :"$CODESEARCH_PORT" 2>/dev/null || true)
	if [ -n "$pid" ]; then
		if ps -p "$pid" -o comm= 2>/dev/null | grep -q codesearch; then
			SERVE_PID="$pid"
		fi
	fi
}

case "${1:-start}" in
start)
	find_serve
	if [ -n "$SERVE_PID" ]; then
		echo "codesearch serve already running (PID $SERVE_PID, port $CODESEARCH_PORT)"
	else
		echo "Starting codesearch serve on port $CODESEARCH_PORT..."
		nohup codesearch serve --no-tui >/dev/null 2>&1 &
		disown
		sleep 2
		find_serve
		if [ -n "$SERVE_PID" ]; then
			echo "Started (PID $SERVE_PID)"
		else
			echo "Failed to start — check ~/.codesearch/logs/" >&2
			exit 1
		fi
	fi
	;;
stop)
	find_serve
	if [ -n "$SERVE_PID" ]; then
		echo "Stopping codesearch serve (PID $SERVE_PID)..."
		kill "$SERVE_PID"
		echo "Stopped"
	else
		echo "Not running"
	fi
	;;
restart)
	"$0" stop
	sleep 1
	"$0" start
	;;
status)
	find_serve
	if [ -n "$SERVE_PID" ]; then
		echo "Running (PID $SERVE_PID, port $CODESEARCH_PORT)"
	else
		echo "Not running"
	fi
	;;
*)
	echo "Usage: $0 {start|stop|restart|status}"
	exit 1
	;;
esac
