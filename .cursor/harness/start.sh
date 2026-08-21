#!/usr/bin/env bash
# Per-boot startup for the browser harnesses (environment.json `start`).
#
# 1. Build the CGNAT namespaces (idempotent).
# 2. Bring up each harness's hot Chrome in the background if not already up, so
#    all three browsers are hot the moment the environment loads — even if the
#    platform does not run the `terminals` entries. The harness terminals then
#    simply attach to these already-hot browsers to surface their logs.
#
# Best-effort: harness problems are logged but never fail the boot, so the
# marks dev server still comes up.
set -uo pipefail
HARNESS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ "$(id -u)" -eq 0 ] || { echo "start: must run as root (use sudo)" >&2; exit 0; }

echo "harness start: building CGNAT namespaces"
bash "$HARNESS_DIR/net-setup.sh" || echo "harness start: WARN net-setup failed (harnesses may be unavailable)"

for row in "playwright cg-playwright 9222" "puppeteer cg-puppeteer 9223" "agent cg-agent 9224"; do
  read -r name ns port <<<"$row"
  ip netns list | grep -qw "$ns" || { echo "harness start: WARN $ns missing, skipping $name"; continue; }
  if ip netns exec "$ns" curl -s --max-time 3 "http://127.0.0.1:${port}/json/version" >/dev/null 2>&1; then
    echo "harness start: $name already hot on :$port"
    continue
  fi
  echo "harness start: launching hot Chrome for $name on :$port"
  # launch-harness.sh owns /tmp/harness-<name>.log via its own tee; keep this
  # background invocation's stdio off that file to avoid an owner clash.
  nohup bash "$HARNESS_DIR/launch-harness.sh" "$name" >/dev/null 2>&1 &
done

# agent-browser drives Chrome through a background daemon whose unix socket
# lives under $HOME/.agent-browser and is namespace-agnostic. Pin a dedicated
# HOME (/home/ubuntu/.cache/harness/agent-home) that is only ever used inside
# cg-agent so the daemon is always co-located with the in-namespace Chrome,
# then seed it so agent-browser is genuinely hot.
if ip netns exec cg-agent curl -s --max-time 3 http://127.0.0.1:9224/json/version >/dev/null 2>&1; then
  ip netns exec cg-agent runuser -u ubuntu -- bash -lc \
    "cd '$HARNESS_DIR' && export HOME=/home/ubuntu/.cache/harness/agent-home && mkdir -p \"\$HOME\" && ./node_modules/.bin/agent-browser --cdp 9224 open about:blank >/dev/null 2>&1 || true"
fi

# Give the browsers a moment to open their CDP sockets, then report (bounded).
for _ in $(seq 1 15); do
  up=0
  for row in "cg-playwright 9222" "cg-puppeteer 9223" "cg-agent 9224"; do
    read -r ns port <<<"$row"
    ip netns exec "$ns" curl -s --max-time 2 "http://127.0.0.1:${port}/json/version" >/dev/null 2>&1 && up=$((up+1))
  done
  [ "$up" -eq 3 ] && break
  sleep 1
done

echo "harness start: ${up:-0}/3 hot browsers ready"
bash "$HARNESS_DIR/status.sh" || true
exit 0
