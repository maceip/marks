#!/usr/bin/env node
/**
 * Report which browser platforms this machine can drive.
 *
 *   node scripts/harness/probe.mjs
 *   node scripts/harness/probe.mjs --json
 *   node scripts/harness/probe.mjs --launch
 */
import { parseArgs } from 'node:util';
import { DRIVER_NAMES, discoverDrivers } from './discover.mjs';

const HELP = `Discover Playwright, Puppeteer, and agent-browser on this machine.

Usage:
  node scripts/harness/probe.mjs [options]

Options:
  --json      Print the discovery report as JSON (no extra prose)
  --launch    Also launch each available driver and eval navigator.userAgent
  --help      Show this help

Examples:
  npm run harness:probe
  npm run harness:probe -- --json
  npm run harness:probe -- --launch

Chrome selection (first hit wins):
  CHROMIUM_PATH / CHROME_PATH / PUPPETEER_EXECUTABLE_PATH / AGENT_BROWSER_EXECUTABLE_PATH
  /opt/google/chrome/chrome
  other system chrome
  Playwright bundled Chromium

The /usr/local/bin/google-chrome desktop wrapper is skipped: it pins
--remote-debugging-port=9222 and a shared profile.
`;

function printHuman(report) {
  const chrome = report.chrome;
  console.log('marks harness probe\n');
  console.log('chrome');
  console.log(`  automation   ${chrome.automation ?? 'none'}`);
  console.log(`  reason       ${chrome.reason}`);
  console.log(`  playwright   ${chrome.playwright ?? 'none'}`);
  if (chrome.override) console.log(`  override     ${chrome.overrideKey}=${chrome.override}`);
  if (chrome.skippedWrappers.length) {
    console.log(`  skipped      ${chrome.skippedWrappers.join(', ')} (shared debugging port)`);
  }
  console.log('');
  console.log('drivers');
  for (const name of DRIVER_NAMES) {
    const driver = report.drivers[name];
    const mark = driver.available ? 'ok     ' : 'missing';
    console.log(`  ${mark}  ${name.padEnd(16)} ${driver.detail}`);
    console.log(`${''.padEnd(12)}${driver.uses}`);
  }
}

async function launchProbe(report) {
  const launches = {};
  for (const name of DRIVER_NAMES) {
    const info = report.drivers[name];
    if (!info.available) {
      launches[name] = { ok: false, error: 'not installed' };
      continue;
    }
    try {
      const driver = await import(`./drivers/${name}.mjs`);
      const session = await driver.launch({
        base: 'about:blank',
        headless: true,
        chrome: report.chrome,
      });
      try {
        await session.goto('data:text/html,<title>marks-harness</title>');
        const title = await session.evaluate(() => document.title);
        const ua = await session.evaluate(() => navigator.userAgent);
        launches[name] = { ok: true, title, userAgent: ua, chrome: session.chromeHint ?? null };
      } finally {
        await session.close();
      }
    } catch (error) {
      launches[name] = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
  return launches;
}

const { values } = parseArgs({
  options: {
    json: { type: 'boolean', default: false },
    launch: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});

if (values.help) {
  process.stdout.write(HELP);
  process.exit(0);
}

const report = discoverDrivers();
let launches = null;
if (values.launch) {
  launches = await launchProbe(report);
}

if (values.json) {
  console.log(JSON.stringify({ ...report, launches }, null, 2));
} else {
  printHuman(report);
  if (launches) {
    console.log('\nlaunch');
    for (const name of DRIVER_NAMES) {
      const result = launches[name];
      if (result.ok) console.log(`  ok      ${name}  ${result.title}  ${result.userAgent}`);
      else console.log(`  FAIL    ${name}  ${result.error}`);
    }
  }
}

if (launches && DRIVER_NAMES.some((name) => report.drivers[name].available && !launches[name].ok)) {
  process.exit(1);
}
