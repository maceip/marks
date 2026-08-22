#!/usr/bin/env bash
# Cross-browser marks test runtime.
#
# 1. Hosts the marks production server (SPA + API + collab WS) on :3100, bound
#    to 0.0.0.0 so it is reachable from every harness's CGNAT namespace via that
#    namespace's host-veth gateway (100.64.{10,20,30}.1).
# 2. Loads the marks web app in all three hot, network-isolated browsers.
# 3. Runs a real cross-browser collaboration test: Playwright types a unique
#    marker into a shared document; Puppeteer and agent-browser — each in its own
#    CGNAT namespace — must observe that edit sync in through the server. This
#    exercises all three browsers and the marks CRDT sync end to end.
#
# Idempotent and quick to re-run: reuses an already-running server and the
# already-hot browsers.
set -uo pipefail
HARNESS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HARNESS_DIR/../.." && pwd)"
PORT="${MARKS_TEST_PORT:-3100}"
DATA_DIR="${MARKS_TEST_DATA:-/tmp/marks-xbrowser}"
AB_HOME=/home/ubuntu/.cache/harness/agent-home
[ "$(id -u)" -eq 0 ] || { echo "run-marks-tests: must run as root (use sudo)" >&2; exit 1; }

log() { printf '\n=== %s ===\n' "$*"; }

# --- 1. build (if needed) + host the marks server ---------------------------
# node/npm come from nvm, which is only on PATH inside a login shell, so every
# node/npm invocation as ubuntu goes through `bash -lc` (matching the other
# harness scripts) rather than a bare `runuser` with a minimal PATH.
if [ ! -f "$REPO_ROOT/client/dist/index.html" ] || [ ! -f "$REPO_ROOT/server/dist/index.js" ]; then
  log "building marks"
  runuser -u ubuntu -- bash -lc "cd '$REPO_ROOT' && npm run build"
fi

SERVER_LOG=/tmp/marks-xbrowser-server.log
if ! curl -sf --max-time 3 "http://localhost:$PORT/api/health" >/dev/null 2>&1; then
  log "starting marks server on :$PORT (0.0.0.0)"
  mkdir -p "$DATA_DIR"; chown ubuntu:ubuntu "$DATA_DIR" 2>/dev/null || true
  rm -f "$SERVER_LOG" 2>/dev/null || true   # avoid a stale non-root-owned log clashing with the redirect
  nohup runuser -u ubuntu -- bash -lc \
    "PORT='$PORT' HOST=0.0.0.0 MARKS_DATA_DIR='$DATA_DIR' node '$REPO_ROOT/server/dist/index.js'" \
    >"$SERVER_LOG" 2>&1 &
  for _ in $(seq 1 30); do
    curl -sf --max-time 2 "http://localhost:$PORT/api/health" >/dev/null 2>&1 && break
    sleep 1
  done
fi
curl -sf --max-time 3 "http://localhost:$PORT/api/health" >/dev/null 2>&1 \
  || { echo "run-marks-tests: marks server not healthy on :$PORT" >&2; exit 1; }
echo "marks server healthy on :$PORT"

# --- 2. ensure CGNAT namespaces + hot browsers ------------------------------
need_start=false
ip netns list | grep -qw cg-playwright || need_start=true
for row in "cg-playwright 9222" "cg-puppeteer 9223" "cg-agent 9224"; do
  read -r ns p <<<"$row"
  ip netns exec "$ns" curl -s --max-time 3 "http://127.0.0.1:$p/json/version" >/dev/null 2>&1 || need_start=true
done
if [ "$need_start" = true ]; then
  log "bringing up namespaces + hot browsers"
  bash "$HARNESS_DIR/start.sh" >/dev/null
fi

# --- 3. create a fresh shared document --------------------------------------
log "creating a fresh shared marks document"
resp="$(curl -s -X POST "http://localhost:$PORT/api/documents" -H 'content-type: application/json' -d '{}')"
id="$(printf '%s' "$resp" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)"
[ -n "$id" ] || { echo "run-marks-tests: failed to create document: $resp" >&2; exit 1; }
docpath="/d/$id"
marker="XSYNC$(date +%s)${RANDOM}"
echo "document=$id  path=$docpath  marker=$marker"

# --- 4. drive all three browsers --------------------------------------------
log "Playwright (cg-playwright, 100.64.10.0/24) loads the app and types the marker"
pw="$(ip netns exec cg-playwright runuser -u ubuntu -- bash -lc \
  "cd '$HARNESS_DIR' && node xbrowser.mjs playwright 9222 http://100.64.10.1:$PORT '$docpath' type '$marker'")"
echo "$pw"; echo "$pw" | grep -q '"ok":true' && pw_ok=1 || pw_ok=0

sleep 2  # let the edit propagate through the server

log "Puppeteer (cg-puppeteer, 100.64.20.0/24) loads the app and waits for the marker to sync in"
pp="$(ip netns exec cg-puppeteer runuser -u ubuntu -- bash -lc \
  "cd '$HARNESS_DIR' && node xbrowser.mjs puppeteer 9223 http://100.64.20.1:$PORT '$docpath' read '$marker'")"
echo "$pp"; echo "$pp" | grep -q '"ok":true' && pp_ok=1 || pp_ok=0

log "agent-browser (cg-agent, 100.64.30.0/24) loads the app and waits for the marker to sync in"
ab="$(ip netns exec cg-agent runuser -u ubuntu -- bash -lc "
  cd '$HARNESS_DIR'; export HOME='$AB_HOME'; mkdir -p \"\$HOME\"
  ./node_modules/.bin/agent-browser --cdp 9224 open 'http://100.64.30.1:$PORT$docpath' >/dev/null 2>&1 || true
  ./node_modules/.bin/agent-browser --cdp 9224 set viewport 1440 900 >/dev/null 2>&1 || true
  for _ in \$(seq 1 20); do
    t=\"\$(./node_modules/.bin/agent-browser --cdp 9224 get text .marks-preview 2>/dev/null)\"
    if printf '%s' \"\$t\" | grep -q '$marker'; then echo '{\"engine\":\"agent\",\"ok\":true}'; exit 0; fi
    sleep 1
  done
  echo '{\"engine\":\"agent\",\"ok\":false}'
")"
echo "$ab"; echo "$ab" | grep -q '"ok":true' && ab_ok=1 || ab_ok=0

# --- 5. report ---------------------------------------------------------------
log "cross-browser result (shared doc $id via the hosted marks server)"
res() { [ "$1" = 1 ] && echo PASS || echo FAIL; }
printf '%-13s %-13s %-22s %s\n' BROWSER NAMESPACE ROLE RESULT
printf '%-13s %-13s %-22s %s\n' playwright cg-playwright "load+edit (source)"      "$(res "$pw_ok")"
printf '%-13s %-13s %-22s %s\n' puppeteer  cg-puppeteer  "load+observe sync"       "$(res "$pp_ok")"
printf '%-13s %-13s %-22s %s\n' agent      cg-agent      "load+observe sync"       "$(res "$ab_ok")"

if [ "$pw_ok" = 1 ] && [ "$pp_ok" = 1 ] && [ "$ab_ok" = 1 ]; then
  echo; echo "ALL THREE BROWSERS PASSED — marker '$marker' edited in Playwright converged to Puppeteer and agent-browser across isolated CGNAT namespaces."
  exit 0
fi
echo; echo "one or more browsers failed"; exit 1
