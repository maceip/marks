/**
 * Find a Chrome/Chromium binary that automation can launch.
 *
 * This Cloud Agent image ships two different "google-chrome" entry points:
 *
 *   /opt/google/chrome/chrome
 *     The real binary. Safe to launch with our own --user-data-dir.
 *
 *   /usr/local/bin/google-chrome  and  /usr/local/bin/chrome
 *     Desktop wrappers that pin --remote-debugging-port=9222 and a shared
 *     profile. A second launch joins that instance instead of starting a
 *     clean browser. The harness never picks those unless they are the
 *     only thing on disk or the caller set CHROMIUM_PATH.
 *
 * Playwright's bundled Chromium is reported separately so Playwright can
 * stay version-matched while Puppeteer and agent-browser drive system Chrome.
 */
import { closeSync, existsSync, openSync, readSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

export const OVERRIDE_KEYS = [
  'CHROMIUM_PATH',
  'CHROME_PATH',
  'PUPPETEER_EXECUTABLE_PATH',
  'AGENT_BROWSER_EXECUTABLE_PATH',
];

export const SYSTEM_CHROME_CANDIDATES = [
  '/opt/google/chrome/chrome',
  '/opt/google/chrome/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/usr/local/bin/google-chrome',
  '/usr/local/bin/chrome',
];

export function peekText(path, readFile) {
  if (readFile) return readFile(path);
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(8192);
    const n = readSync(fd, buf, 0, 8192, 0);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

export function isCloudDesktopWrapper(path, readFile) {
  let text;
  try {
    text = peekText(path, readFile);
  } catch {
    return false;
  }
  if (typeof text !== 'string' || !text.startsWith('#!')) return false;
  return /--remote-debugging-port=9222/.test(text) && /user-data-dir/.test(text);
}

export function playwrightExecutablePath({ requireFrom = ROOT } = {}) {
  try {
    const require = createRequire(join(requireFrom, 'package.json'));
    const playwright = require('playwright');
    return playwright.chromium.executablePath();
  } catch {
    return null;
  }
}

export function discoverChrome({
  env = process.env,
  exists = existsSync,
  readFile,
  playwrightPath,
  requireFrom = ROOT,
} = {}) {
  const overrideKey = OVERRIDE_KEYS.find((key) => env[key]);
  const override = overrideKey ? env[overrideKey] : null;
  const bundled =
    playwrightPath === undefined ? playwrightExecutablePath({ requireFrom }) : playwrightPath;

  const found = [];
  for (const path of SYSTEM_CHROME_CANDIDATES) {
    if (!exists(path)) continue;
    const wrapper = isCloudDesktopWrapper(path, readFile);
    found.push({ path, wrapper });
  }

  const skippedWrappers = found.filter((item) => item.wrapper).map((item) => item.path);
  const system = found.find((item) => !item.wrapper)?.path ?? found[0]?.path ?? null;

  let automation = null;
  let reason = 'none';
  if (override) {
    automation = override;
    reason = `override ${overrideKey}`;
  } else if (system) {
    automation = system;
    reason = skippedWrappers.includes(system)
      ? 'only chrome is a shared-profile wrapper'
      : 'system chrome';
  } else if (bundled) {
    automation = bundled;
    reason = 'playwright bundled chromium';
  }

  return {
    override,
    overrideKey: override ? overrideKey : null,
    automation,
    reason,
    playwright: bundled,
    system,
    skippedWrappers,
    found: found.map((item) => item.path),
    launchArgsHint: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
    ],
  };
}
