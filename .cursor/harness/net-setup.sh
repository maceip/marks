#!/usr/bin/env bash
# Create one CGNAT-style network namespace per browser harness.
#
# Each harness gets its own /24 inside the RFC 6598 shared-address space
# (100.64.0.0/10) and reaches the internet only through source-NAT on the host,
# so a browser running inside the namespace sees a 100.64.x.y address and
# believes it sits behind carrier-grade NAT. The three namespaces are mutually
# isolated: they share no subnet and cannot see each other's traffic.
#
# Runtime kernel state (namespaces, veths, iptables) does not survive a reboot
# or a snapshot restore, so this runs on every boot from environment.json
# `start`. It is fully idempotent and safe to run repeatedly.
set -euo pipefail

# name  netns          subnet(/24)   host-veth   ns-veth
HARNESSES=(
  "playwright cg-playwright 100.64.10 cg-pw-h cg-pw-n"
  "puppeteer  cg-puppeteer  100.64.20 cg-pp-h cg-pp-n"
  "agent      cg-agent      100.64.30 cg-ab-h cg-ab-n"
)

CGNAT_CIDR="100.64.0.0/10"
UPLINK="$(ip route show default 2>/dev/null | awk '/default/{print $5; exit}')"
[ -n "${UPLINK:-}" ] || { echo "net-setup: could not determine uplink interface" >&2; exit 1; }

need_root() { [ "$(id -u)" -eq 0 ] || { echo "net-setup: must run as root (use sudo)" >&2; exit 1; }; }
need_root

echo "net-setup: uplink=$UPLINK cgnat=$CGNAT_CIDR"

# --- host-wide forwarding + NAT (idempotent) -------------------------------
sysctl -wq net.ipv4.ip_forward=1

# Source-NAT everything leaving the CGNAT range out the uplink (nft backend).
if ! iptables -t nat -C POSTROUTING -s "$CGNAT_CIDR" -o "$UPLINK" -j MASQUERADE 2>/dev/null; then
  iptables -t nat -A POSTROUTING -s "$CGNAT_CIDR" -o "$UPLINK" -j MASQUERADE
fi

# Docker installs a legacy-iptables FORWARD chain whose policy is DROP; without
# an explicit allow our forwarded CGNAT packets are silently dropped. Insert the
# allow into DOCKER-USER, which Docker guarantees runs first in FORWARD.
if command -v iptables-legacy >/dev/null 2>&1 && iptables-legacy -L DOCKER-USER >/dev/null 2>&1; then
  for spec in "-s $CGNAT_CIDR" "-d $CGNAT_CIDR"; do
    # shellcheck disable=SC2086
    if ! iptables-legacy -C DOCKER-USER $spec -j ACCEPT 2>/dev/null; then
      # shellcheck disable=SC2086
      iptables-legacy -I DOCKER-USER $spec -j ACCEPT
    fi
  done
fi

# --- per-harness namespaces ------------------------------------------------
for row in "${HARNESSES[@]}"; do
  read -r name ns net hveth nveth <<<"$row"
  host_ip="${net}.1"
  ns_ip="${net}.2"

  ip netns list | grep -qw "$ns" || ip netns add "$ns"

  # veth pair: recreate only if missing (deleting a live pair would drop Chrome)
  if ! ip link show "$hveth" >/dev/null 2>&1; then
    ip link add "$hveth" type veth peer name "$nveth"
    ip link set "$nveth" netns "$ns"
  fi

  # host side
  ip addr replace "${host_ip}/24" dev "$hveth"
  ip link set "$hveth" up

  # namespace side
  ip -n "$ns" addr replace "${ns_ip}/24" dev "$nveth"
  ip -n "$ns" link set "$nveth" up
  ip -n "$ns" link set lo up
  ip -n "$ns" route replace default via "$host_ip"

  # DNS for the namespace (host resolver is systemd-resolved on loopback, which
  # a namespace cannot reach; use public resolvers).
  mkdir -p "/etc/netns/${ns}"
  printf 'nameserver 8.8.8.8\nnameserver 1.1.1.1\n' >"/etc/netns/${ns}/resolv.conf"

  echo "net-setup: ${name} -> ns=${ns} subnet=${net}.0/24 host=${host_ip} browser=${ns_ip}"
done

echo "net-setup: done"
