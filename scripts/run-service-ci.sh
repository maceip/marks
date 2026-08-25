#!/usr/bin/env bash
# Start (or attach to) marks-server, prove the service-mode UI, then prove
# two native ESBT peers converge on that document.
#
# Examples:
#   scripts/run-service-ci.sh --bin target/debug/marks-server --static-dir client/dist
#   scripts/run-service-ci.sh --url http://127.0.0.1:3000
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/run-service-ci.sh --bin <marks-server> --static-dir <client/dist>
  scripts/run-service-ci.sh --url http://127.0.0.1:3000

Prove service-mode artifact identity, durable edit/reload/offline workflows,
and multi-peer room convergence against a live marks-server. The browser must
be a VITE_MARKS_DATA_MODE=service build.

Options:
  --bin PATH           marks-server binary to start
  --static-dir PATH    MARKS_STATIC_DIR for the started binary
  --listen ADDR        bind address (default: 127.0.0.1:3000)
  --url URL            use an already-running server (do not start --bin)
  --receipt PATH       UI receipt JSON (default: a temp file)
  --browser NAME       chromium, firefox, or webkit (default: chromium)
  --skip-ui            skip Playwright; rust peers create their own document
  --skip-collab        skip the native two-peer test
  --help               show this help

Examples:
  cargo build -p marks-server
  VITE_MARKS_DATA_MODE=service npm run build
  scripts/run-service-ci.sh --bin target/debug/marks-server --static-dir client/dist
EOF
}

BIN=""
STATIC_DIR=""
LISTEN="127.0.0.1:3000"
LISTEN_SET=0
URL=""
RECEIPT="${MARKS_CI_RECEIPT:-}"
SKIP_UI=0
SKIP_COLLAB=0
BROWSER="${MARKS_BROWSER:-chromium}"

while [ $# -gt 0 ]; do
  case "$1" in
    --help|-h)
      usage
      exit 0
      ;;
    --bin)
      BIN=${2:?Error: --bin needs a path.
  scripts/run-service-ci.sh --bin target/debug/marks-server --static-dir client/dist}
      shift 2
      ;;
    --static-dir)
      STATIC_DIR=${2:?Error: --static-dir needs a path.
  scripts/run-service-ci.sh --bin target/debug/marks-server --static-dir client/dist}
      shift 2
      ;;
    --listen)
      LISTEN=${2:?Error: --listen needs host:port.
  scripts/run-service-ci.sh --bin target/debug/marks-server --listen 127.0.0.1:3000 --static-dir client/dist}
      LISTEN_SET=1
      shift 2
      ;;
    --url)
      URL=${2:?Error: --url needs an origin.
  scripts/run-service-ci.sh --url http://127.0.0.1:3000}
      shift 2
      ;;
    --receipt)
      RECEIPT=${2:?Error: --receipt needs a path.
  scripts/run-service-ci.sh --url http://127.0.0.1:3000 --receipt /tmp/marks-ci-receipt.json}
      shift 2
      ;;
    --browser)
      BROWSER=${2:?Error: --browser needs chromium, firefox, or webkit.}
      shift 2
      ;;
    --skip-ui)
      SKIP_UI=1
      shift
      ;;
    --skip-collab)
      SKIP_COLLAB=1
      shift
      ;;
    *)
      echo "Error: unknown argument $1" >&2
      echo "  scripts/run-service-ci.sh --help" >&2
      exit 2
      ;;
  esac
done

case "$BROWSER" in
  chromium|firefox|webkit) ;;
  *)
    echo "Error: --browser must be chromium, firefox, or webkit (got $BROWSER)." >&2
    exit 2
    ;;
esac

if [ -z "$URL" ] && [ -z "$BIN" ]; then
  echo "Error: provide --bin to start marks-server, or --url for a running one." >&2
  echo "  scripts/run-service-ci.sh --bin target/debug/marks-server --static-dir client/dist" >&2
  exit 2
fi

if [ -n "$URL" ] && { [ -n "$BIN" ] || [ -n "$STATIC_DIR" ] || [ "$LISTEN_SET" -eq 1 ]; }; then
  echo "Error: --url cannot be combined with --bin, --static-dir, or --listen." >&2
  echo "  Choose an attached server (--url) or a process started by this harness (--bin)." >&2
  exit 2
fi

if [ "$SKIP_UI" -eq 1 ] && [ "$SKIP_COLLAB" -eq 1 ]; then
  echo "Error: --skip-ui and --skip-collab would run no proof." >&2
  exit 2
fi

ROOT=$(cd "$(dirname "$0")/.." && pwd)
SERVER_PID=""
SERVER_LOG=""
RUN_SUCCEEDED=0
cleanup() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  if [ "$RUN_SUCCEEDED" -ne 1 ] && [ -n "$RECEIPT" ]; then
    rm -f -- "$RECEIPT"
  fi
}
trap cleanup EXIT

if [ -z "$URL" ]; then
  if [ ! -x "$BIN" ]; then
    echo "Error: marks-server binary is not executable: $BIN" >&2
    echo "  cargo build -p marks-server" >&2
    exit 2
  fi
  if [ -z "$STATIC_DIR" ]; then
    echo "Error: --static-dir is required when starting --bin." >&2
    echo "  VITE_MARKS_DATA_MODE=service npm run build" >&2
    echo "  scripts/run-service-ci.sh --bin $BIN --static-dir client/dist" >&2
    exit 2
  fi
  if [ ! -f "$STATIC_DIR/index.html" ]; then
    echo "Error: $STATIC_DIR/index.html is missing (need a service-mode client build)." >&2
    echo "  VITE_MARKS_DATA_MODE=service npm run build" >&2
    exit 2
  fi
  URL="http://${LISTEN}"
  DB_DIR=$(mktemp -d "${TMPDIR:-/tmp}/marks-ci-db.XXXXXX")
  SERVER_LOG=$(mktemp "${TMPDIR:-/tmp}/marks-ci-server.XXXXXX")
  echo "starting $BIN on $LISTEN (db=$DB_DIR/marks.db3, log=$SERVER_LOG)"
  MARKS_LISTEN="$LISTEN" \
  MARKS_ORIGIN="$URL" \
  MARKS_DB="$DB_DIR/marks.db3" \
  MARKS_STATIC_DIR="$STATIC_DIR" \
    "$BIN" >"$SERVER_LOG" 2>&1 &
  SERVER_PID=$!
fi

# Read liveness is insufficient for a workflow that immediately creates and
# journals documents. /readyz proves the process's FULL-sync SQLite writer has
# completed a recent commit. Apply the same deadline to attached --url runs.
bash "$ROOT/scripts/wait-for-server.sh" "$URL/readyz" "$SERVER_PID" 60 "$SERVER_LOG"

if [ -z "$RECEIPT" ]; then
  RECEIPT=$(mktemp "${TMPDIR:-/tmp}/marks-ci-receipt.XXXXXX")
fi

if [ "$SKIP_UI" -eq 0 ]; then
  echo "service-mode UI against $URL"
  node "$ROOT/scripts/ci-service-ui.mjs" --url "$URL" --browser "$BROWSER" --receipt "$RECEIPT"
  UI_RESULT="passed"
else
  echo "skipping service-mode UI"
  rm -f "$RECEIPT"
  RECEIPT=""
  UI_RESULT="skipped"
fi

if [ "$SKIP_UI" -eq 0 ] && [ "$BROWSER" = "chromium" ]; then
  echo "welcome recovery UI against $URL"
  node "$ROOT/scripts/ci-welcome-ui.mjs" --url "$URL"
  WELCOME_RESULT="passed"
elif [ "$SKIP_UI" -eq 1 ]; then
  echo "skipping welcome recovery UI with service-mode UI"
  WELCOME_RESULT="skipped"
else
  echo "welcome recovery UI is covered by the Chromium lane"
  WELCOME_RESULT="not-applicable"
fi

if [ "$SKIP_COLLAB" -eq 0 ]; then
  echo "native two-peer room against $URL"
  if [ -n "$RECEIPT" ] && [ -f "$RECEIPT" ]; then
    export MARKS_CI_RECEIPT="$RECEIPT"
  else
    unset MARKS_CI_RECEIPT || true
  fi
  (
    cd "$ROOT"
    MARKS_URL="$URL" cargo test -p marks-server --test live_service --locked -- --ignored --nocapture
  )
  COLLAB_RESULT="passed"
else
  echo "skipping native two-peer room"
  COLLAB_RESULT="skipped"
fi

RUN_SUCCEEDED=1
echo "service CI checks passed against $URL (ui=$UI_RESULT, welcome=$WELCOME_RESULT, native-collab=$COLLAB_RESULT)"
