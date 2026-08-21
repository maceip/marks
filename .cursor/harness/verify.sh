#!/usr/bin/env bash
# End-to-end functional check: each harness attaches to its own hot Chrome,
# inside its own CGNAT namespace, and performs a real navigation.
set -uo pipefail

HARNESS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ "$(id -u)" -eq 0 ] || { echo "verify: must run as root (use sudo)" >&2; exit 1; }

TIMEOUT="${HARNESS_VERIFY_TIMEOUT:-45}"

run_node() { # ns port harness
  local ns="$1" port="$2" name="$3"
  timeout "$TIMEOUT" ip netns exec "$ns" runuser -u ubuntu -- bash -lc \
    "cd '$HARNESS_DIR' && node verify.mjs '$name' '$port'"
}

run_agent() { # ns port
  local ns="$1" port="$2"
  timeout "$TIMEOUT" ip netns exec "$ns" runuser -u ubuntu -- bash -lc "
    cd '$HARNESS_DIR' &&
    export HOME=/home/ubuntu/.cache/harness/agent-home && mkdir -p \"\$HOME\" &&
    ./node_modules/.bin/agent-browser --cdp '$port' open 'https://api.ipify.org?format=text' >/dev/null 2>&1 &&
    egress=\$(./node_modules/.bin/agent-browser --cdp '$port' get text body 2>/dev/null | tr -d '[:space:]') &&
    printf '{\"harness\":\"agent\",\"cdp\":\"http://127.0.0.1:%s\",\"ok\":true,\"egress\":\"%s\"}\n' '$port' \"\$egress\"
  "
}

rc=0
echo "== playwright =="; run_node cg-playwright 9222 playwright || rc=1
echo "== puppeteer  =="; run_node cg-puppeteer  9223 puppeteer  || rc=1
echo "== agent      =="; run_agent cg-agent     9224            || rc=1
exit $rc
