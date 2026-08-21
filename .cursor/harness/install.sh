#!/usr/bin/env bash
# Install the three browser harnesses and a Chrome for each, plus the system
# tools needed to build the CGNAT namespaces. Idempotent; safe to re-run.
set -euo pipefail
cd "$(dirname "$0")"

# System tools for network namespaces + NAT (absent from the default image).
sudo apt-get update -qq
sudo apt-get install -y -qq iproute2 iptables

# Harness JS deps. Puppeteer downloads its own Chrome for Testing on install.
npm install

# Playwright's browser (shared ~/.cache/ms-playwright cache; no-op if present).
npx --yes playwright install chromium

# agent-browser's own Chrome for Testing (downloaded to ~/.agent-browser).
./node_modules/.bin/agent-browser install

echo "harness install: playwright + puppeteer + agent-browser ready"
