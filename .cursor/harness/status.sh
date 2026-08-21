#!/usr/bin/env bash
# Report each harness's CGNAT identity and whether its hot Chrome is reachable.
set -uo pipefail

rows=(
  "playwright cg-playwright 9222"
  "puppeteer  cg-puppeteer  9223"
  "agent      cg-agent      9224"
)

[ "$(id -u)" -eq 0 ] || { echo "status: must run as root (use sudo)" >&2; exit 1; }

printf '%-11s %-13s %-16s %-16s %-8s %s\n' HARNESS NETNS "LOCAL(CGNAT)" EGRESS CDP BROWSER
for row in "${rows[@]}"; do
  read -r name ns port <<<"$row"
  if ! ip netns list | grep -qw "$ns"; then
    printf '%-11s %-13s %-16s %-16s %-8s %s\n' "$name" "$ns" "-" "-" "-" "namespace missing"
    continue
  fi
  local_ip="$(ip -n "$ns" -4 addr show 2>/dev/null | awk '/inet 100\./{print $2; exit}')"
  egress_ip="$(ip netns exec "$ns" curl -s --max-time 8 https://api.ipify.org 2>/dev/null || echo '-')"
  ver="$(ip netns exec "$ns" curl -s --max-time 5 "http://127.0.0.1:${port}/json/version" 2>/dev/null)"
  if [ -n "$ver" ]; then
    cdp="up"
    browser="$(printf '%s' "$ver" | grep -o '"Browser": *"[^"]*"' | grep -o '"[^"]*"$' | tr -d '"')"
  else
    cdp="down"; browser="(not hot)"
  fi
  printf '%-11s %-13s %-16s %-16s %-8s %s\n' "$name" "$ns" "${local_ip:--}" "$egress_ip" "$cdp" "$browser"
done
