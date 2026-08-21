/**
 * Discover the three browser platforms the surface suite runs on:
 * Playwright (in-repo), Puppeteer / puppeteer-core, and the agent-browser CLI.
 *
 * Each platform is optional at discovery time. The runner fails with an
 * actionable error only when you ask to drive one that is missing.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { discoverChrome } from './chrome.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
export const DRIVER_NAMES = ['playwright', 'puppeteer', 'agent-browser'];

function requireFromRoot() {
  return createRequire(join(ROOT, 'package.json'));
}

function resolvePackage(name) {
  try {
    const require = requireFromRoot();
    const pkgJson = require.resolve(`${name}/package.json`);
    const pkg = JSON.parse(readFileSync(pkgJson, 'utf8'));
    return { name, version: pkg.version, path: pkgJson };
  } catch {
    return null;
  }
}

function resolveBin(name) {
  const local = join(ROOT, 'node_modules/.bin', name);
  if (existsSync(local)) return local;
  const which = spawnSync('command', ['-v', name], { encoding: 'utf8', shell: true });
  const path = which.status === 0 ? which.stdout.trim() : '';
  return path || null;
}

function binVersion(bin, args = ['--version']) {
  if (!bin) return null;
  const result = spawnSync(bin, args, { encoding: 'utf8' });
  if (result.status !== 0) return null;
  return (result.stdout || result.stderr).trim().split('\n')[0] ?? null;
}

export function discoverDrivers({ env = process.env, root = ROOT } = {}) {
  const chrome = discoverChrome({ env, requireFrom: root });
  const playwright = resolvePackage('playwright');
  const puppeteerCore = resolvePackage('puppeteer-core');
  const puppeteer = resolvePackage('puppeteer');
  const puppeteerPkg = puppeteerCore ?? puppeteer;
  const agentBin = resolveBin('agent-browser');

  return {
    chrome,
    drivers: {
      playwright: {
        name: 'playwright',
        available: Boolean(playwright),
        version: playwright?.version ?? null,
        detail: playwright
          ? `playwright@${playwright.version}`
          : 'not in node_modules (npm install)',
        executable: chrome.playwright,
        uses: chrome.override ? 'CHROMIUM_PATH override' : 'bundled chromium unless CHROMIUM_PATH is set',
      },
      puppeteer: {
        name: 'puppeteer',
        available: Boolean(puppeteerPkg),
        version: puppeteerPkg?.version ?? null,
        detail: puppeteerPkg
          ? `${puppeteerPkg.name}@${puppeteerPkg.version}`
          : 'not in node_modules (npm install -D puppeteer-core)',
        executable: chrome.automation,
        uses: 'system Chrome via puppeteer-core (no browser download)',
        flavor: puppeteerCore ? 'puppeteer-core' : puppeteer ? 'puppeteer' : null,
      },
      'agent-browser': {
        name: 'agent-browser',
        available: Boolean(agentBin),
        version: binVersion(agentBin),
        detail: agentBin ? agentBin : 'not on PATH or in node_modules/.bin',
        executable: chrome.automation,
        uses: 'CLI over CDP; Chrome launched with the shared no-sandbox args',
        bin: agentBin,
      },
    },
  };
}

export function missingDriverHelp(name, report) {
  const chrome = report.chrome.automation ?? '(none found — set CHROMIUM_PATH)';
  if (name === 'playwright') {
    return [
      'playwright is not installed.',
      '  looked for: playwright in this repo\'s node_modules',
      `  chrome: ${chrome}`,
      '  install: npm install -D playwright && npx playwright install chromium',
    ].join('\n');
  }
  if (name === 'puppeteer') {
    return [
      'puppeteer is not installed.',
      '  looked for: puppeteer-core, then puppeteer',
      `  chrome: ${chrome}`,
      '  install: npm install -D puppeteer-core',
      '  PUPPETEER_SKIP_DOWNLOAD is assumed; the harness points at system Chrome.',
    ].join('\n');
  }
  return [
    'agent-browser is not installed.',
    '  looked for: node_modules/.bin/agent-browser, then PATH',
    `  chrome: ${chrome}`,
    '  install: npm install -D agent-browser',
    '  do not run `agent-browser install` when system Chrome is already present.',
  ].join('\n');
}
