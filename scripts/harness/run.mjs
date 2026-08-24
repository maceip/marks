#!/usr/bin/env node
/**
 * Run the portable browser-surface suite on one or all platforms.
 *
 *   node scripts/harness/run.mjs --help
 *   node scripts/harness/run.mjs --list
 *   node scripts/harness/run.mjs --driver=playwright
 *   node scripts/harness/run.mjs --driver=all
 */
import { parseArgs } from 'node:util';
import { DRIVER_NAMES, discoverDrivers, missingDriverHelp } from './discover.mjs';
import { DEFAULT_URL } from './env.mjs';
import { runSurface } from './suites/surface.mjs';

const HELP = `Run the marks browser-surface suite against a live app.

Usage:
  node scripts/harness/run.mjs --driver=<playwright|puppeteer|agent-browser|all> [options]

Options:
  --driver <name>   Browser platform (default: playwright)
  --url <origin>    App origin (default: $MARKS_URL or http://localhost:3000)
  --headed          Show the browser window
  --list            Print discovered platforms and exit 0
  --help            Show this help

Examples:
  npm run harness:probe
  npm run smoke:surface
  npm run smoke:puppeteer
  npm run smoke:agent-browser
  npm run smoke:platforms

  MARKS_URL=http://127.0.0.1:3000 node scripts/harness/run.mjs --driver=all

The app must already be running. Vite on :5173 proxies /v1 and /collab to the
Rust marks-server (MARKS_SERVER, default http://localhost:3000). Do not start
a Node server workspace.
Deep browser collaboration and REST checks stay on Playwright: npm run ci:service
`;

function printHelp() {
  process.stdout.write(HELP);
}

async function loadDriver(name) {
  if (name === 'playwright') return import('./drivers/playwright.mjs');
  if (name === 'puppeteer') return import('./drivers/puppeteer.mjs');
  if (name === 'agent-browser') return import('./drivers/agent-browser.mjs');
  throw new Error(`unknown driver: ${name}`);
}

function createChecker(results, prefix) {
  return (name, pass, detail = '') => {
    results.push({ name, pass: Boolean(pass), detail });
    const label = prefix ? `${prefix} ${name}` : name;
    console.log(`${pass ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
  };
}

async function runOne(name, { url, headed, report }) {
  const info = report.drivers[name];
  if (!info?.available) {
    console.error(missingDriverHelp(name, report));
    return { driver: name, results: [], failed: true, skipped: true };
  }

  const driver = await loadDriver(name);
  const results = [];
  const check = createChecker(results, `[${name}]`);
  let session;
  console.log(`\n${name}  (${info.detail})`);
  try {
    session = await driver.launch({
      base: url,
      headless: !headed,
      chrome: report.chrome,
    });
    await runSurface(session, { check });
  } catch (error) {
    check('suite completed', false, error instanceof Error ? error.message : String(error));
  } finally {
    if (session) {
      try {
        await session.close();
      } catch {
        // ignore
      }
    }
  }

  const failed = results.some((item) => !item.pass);
  return { driver: name, results, failed, skipped: false };
}

const { values } = parseArgs({
  options: {
    driver: { type: 'string', default: 'playwright' },
    url: { type: 'string' },
    headed: { type: 'boolean', default: false },
    list: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
  allowPositionals: true,
});

if (values.help) {
  printHelp();
  process.exit(0);
}

const report = discoverDrivers();
const url = values.url ?? DEFAULT_URL;

if (values.list) {
  for (const name of DRIVER_NAMES) {
    const driver = report.drivers[name];
    console.log(`${driver.available ? 'ok' : 'missing'}  ${name}  ${driver.detail}`);
  }
  console.log(`chrome  ${report.chrome.automation ?? 'none'}  (${report.chrome.reason})`);
  process.exit(0);
}

const wanted = values.driver === 'all' ? DRIVER_NAMES : [values.driver];
for (const name of wanted) {
  if (!DRIVER_NAMES.includes(name)) {
    console.error(`unknown --driver=${name}`);
    console.error(`expected: ${DRIVER_NAMES.join(' | ')} | all`);
    process.exit(2);
  }
}

const summaries = [];
for (const name of wanted) {
  summaries.push(await runOne(name, { url, headed: values.headed, report }));
}

let failed = 0;
let passed = 0;
for (const summary of summaries) {
  for (const item of summary.results) {
    if (item.pass) passed += 1;
    else failed += 1;
  }
  if (summary.skipped) failed += 1;
}

console.log(`\n${passed}/${passed + failed} checks passed across ${wanted.join(', ')}`);
process.exit(failed === 0 ? 0 : 1);
