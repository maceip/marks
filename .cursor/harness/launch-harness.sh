#!/usr/bin/env bash
# Bring up (or attach to) one harness's own Chrome inside its CGNAT namespace.
#
# Idempotent: if the harness's CDP port is already serving (the hot browser is
# up, e.g. started by start.sh on boot), this prints the identity banner and
# then tails the browser log so an environment.json `terminals` entry stays
# resident with visible logs. Otherwise it launches that harness's own Chrome
# in the foreground. Either way the browser is that harness's own Chrome,
# exposing a CDP endpoint on 127.0.0.1:<port> inside the namespace.
set -uo pipefail

name="${1:-}"
case "$name" in
  playwright) ns=cg-playwright; port=9222 ;;
  puppeteer)  ns=cg-puppeteer;  port=9223 ;;
  agent)      ns=cg-agent;      port=9224 ;;
  *) echo "usage: launch-harness.sh {playwright|puppeteer|agent}" >&2; exit 2 ;;
esac

resolve_chrome() { ls -1 $1 2>/dev/null | sort -V | tail -1; }
case "$name" in
  playwright) chrome="$(resolve_chrome '/home/ubuntu/.cache/ms-playwright/chromium-*/chrome-linux64/chrome')" ;;
  puppeteer)  chrome="$(resolve_chrome '/home/ubuntu/.cache/puppeteer/chrome/linux-*/chrome-linux64/chrome')" ;;
  agent)      chrome="$(resolve_chrome '/home/ubuntu/.agent-browser/browsers/chrome-*/chrome')" ;;
esac

[ "$(id -u)" -eq 0 ] || { echo "launch-harness: must run as root (use sudo)" >&2; exit 1; }
ip netns list | grep -qw "$ns" || { echo "launch-harness: namespace $ns missing; run net-setup.sh first" >&2; exit 1; }

log="/tmp/harness-${name}.log"
cdp_up() { ip netns exec "$ns" curl -s --max-time 3 "http://127.0.0.1:${port}/json/version" >/dev/null 2>&1; }

banner() {
  local local_ip egress
  local_ip="$(ip -n "$ns" -4 addr show 2>/dev/null | awk '/inet 100\./{print $2; exit}')"
  egress="$(ip netns exec "$ns" curl -s --max-time 10 https://api.ipify.org 2>/dev/null || echo '(offline)')"
  cat <<EOF
==================================================================
 harness : ${name}
 chrome  : ${chrome:-<none>}
 netns   : ${ns}
 local IP: ${local_ip}   (RFC 6598 CGNAT)
 egress  : ${egress}  (public IP after source-NAT)
 CDP     : http://127.0.0.1:${port}  (inside ${ns})
==================================================================
EOF
}

if cdp_up; then
  echo "launch-harness: ${name} already hot on :${port}; attaching to logs"
  banner
  touch "$log"
  exec tail -n +1 -F "$log"
fi

[ -n "$chrome" ] && [ -x "$chrome" ] || { echo "launch-harness: no Chrome found for $name" >&2; exit 1; }
udd="/home/ubuntu/.cache/harness/${name}"
ip netns exec "$ns" runuser -u ubuntu -- mkdir -p "$udd"
rm -f "$log" 2>/dev/null || true
banner | tee "$log"

# Foreground so the terminal keeps the browser hot; logs also go to $log so a
# later attach (or start.sh's background launch) shares the same file.
ip netns exec "$ns" runuser -u ubuntu -- \
  "$chrome" \
    --headless=new \
    --no-sandbox \
    --disable-gpu \
    --disable-dev-shm-usage \
    --no-first-run \
    --no-default-browser-check \
    --user-data-dir="$udd" \
    --remote-debugging-address=127.0.0.1 \
    --remote-debugging-port="$port" \
    about:blank 2>&1 | tee -a "$log"
