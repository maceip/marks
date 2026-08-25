#!/usr/bin/env bash
# Wait until URL answers, or fail if PID dies / the deadline is hit.
# Usage: wait-for-server.sh <url> [pid] [timeout-seconds] [log-file]
set -euo pipefail

URL=${1:-http://127.0.0.1:3000}
PID=${2:-}
TIMEOUT=${3:-60}
LOG=${4:-}

if ! [[ "$TIMEOUT" =~ ^[0-9]+$ ]] || [ "$TIMEOUT" -le 0 ]; then
  echo "error: timeout must be a positive integer (seconds)" >&2
  echo "  bash scripts/wait-for-server.sh http://127.0.0.1:3000 <pid> 60 /tmp/server.log" >&2
  exit 1
fi

deadline=$((SECONDS + TIMEOUT))
while true; do
  if [ -n "$PID" ] && ! kill -0 "$PID" 2>/dev/null; then
    echo "error: process $PID exited before ${URL} was ready" >&2
    if [ -n "$LOG" ] && [ -f "$LOG" ]; then
      echo "----- server log -----" >&2
      cat "$LOG" >&2
    fi
    exit 1
  fi
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "error: timed out after ${TIMEOUT}s waiting for ${URL}" >&2
    if [ -n "$LOG" ] && [ -f "$LOG" ]; then
      echo "----- server log -----" >&2
      cat "$LOG" >&2
    fi
    exit 1
  fi
  remaining=$((deadline - SECONDS))
  request_timeout=2
  if [ "$remaining" -lt "$request_timeout" ]; then
    request_timeout=$remaining
  fi
  # A listener that accepts TCP but never returns bytes must not defeat the
  # outer startup deadline. Keep each curl attempt within the time remaining.
  if curl -sf \
    --connect-timeout "$request_timeout" \
    --max-time "$request_timeout" \
    "$URL" >/dev/null; then
    echo "ready: ${URL}"
    exit 0
  fi
  sleep 1
done
