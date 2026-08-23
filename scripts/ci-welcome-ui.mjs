#!/usr/bin/env node
/**
 * Prove /welcome opens the real editor on the built-in Markdown marketing page.
 *
 *   node scripts/ci-welcome-ui.mjs --url http://127.0.0.1:4173
 *   MARKS_URL=https://marks.secure.build node scripts/ci-welcome-ui.mjs --screenshot /tmp/welcome.png
 */
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { CHROME_LAUNCH_ARGS, launchEnv } from './harness/env.mjs';

function printHelp() {
  console.log(`Usage:
  node scripts/ci-welcome-ui.mjs --url <origin> [--screenshot <path>]

Prove /welcome and /d/about-marks load Google Docs for Markdown in the editor.

Options:
  --url <origin>         App origin (or MARKS_URL). Required.
  --screenshot <path>    Optional PNG of the loaded marketing document.
  --help                 Show this help.
`);
}

function parseArgs(argv) {
  const options = {
    url: process.env.MARKS_URL ?? '',
    screenshot: process.env.MARKS_WELCOME_SCREENSHOT ?? '',
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--url' || arg === '--screenshot') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`Error: ${arg} needs a value.`);
      }
      options[arg.slice(2)] = value;
      index += 1;
      continue;
    }
    throw new Error(`Error: unknown argument ${arg}.`);
  }
  return options;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printHelp();
  process.exit(0);
}
if (!args.url) {
  console.error('Error: --url or MARKS_URL is required.');
  process.exit(2);
}

const BASE = args.url.replace(/\/$/, '');
const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
};

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: CHROME_LAUNCH_ARGS,
  env: launchEnv(),
});

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  await page.goto(`${BASE}/welcome/`, { waitUntil: 'domcontentloaded' });
  await page.waitForURL((url) => url.pathname === '/d/about-marks' || url.pathname === '/welcome/', {
    timeout: 15_000,
  });
  check(
    '/welcome lands on the about document route',
    page.url().includes('/d/about-marks') || page.url().includes('/welcome'),
    page.url(),
  );

  await page.waitForSelector('.workspace-shell, .cm-editor, .empty-state', { timeout: 30_000 });
  const unavailable = await page.locator('.empty-state').filter({ hasText: 'Document unavailable' }).count();
  check('does not show Document unavailable', unavailable === 0);

  await page.waitForSelector('.workspace-shell', { timeout: 30_000 });
  await page.waitForSelector('.cm-editor', { timeout: 30_000 });
  check('opens the document workspace and CodeMirror', (await page.locator('.cm-editor').count()) >= 1);

  await page.waitForFunction(
    () => (document.querySelector('.cm-content')?.innerText ?? '').includes('Google Docs for Markdown'),
    null,
    { timeout: 30_000 },
  );
  await page.waitForSelector('.marks-preview h1, .marks-preview .marks-block', { timeout: 30_000 });
  await page.waitForFunction(
    () => (document.querySelector('.marks-preview')?.innerText ?? '').includes('Google Docs for Markdown'),
    null,
    { timeout: 30_000 },
  );

  const body = await page.evaluate(() => ({
    source: document.querySelector('.cm-content')?.innerText ?? '',
    preview: document.querySelector('.marks-preview')?.innerText ?? '',
    title: document.querySelector('.titlebar .doc-title, .titlebar [data-doc-title]')?.textContent ?? '',
    empty: document.querySelector('.empty-state')?.textContent ?? '',
    mermaid: document.querySelector('.marks-preview .mermaid, .marks-preview svg') != null,
    table: document.querySelector('.marks-preview table') != null,
    callout: document.querySelector('.marks-preview .callout, .marks-preview .markdown-alert, .marks-preview aside') != null,
    split: document.querySelector('.workspace-shell')?.className ?? '',
  }));

  check(
    'editor source is the Google Docs for Markdown page',
    body.source.includes('Google Docs for Markdown'),
    `chars=${body.source.length}`,
  );
  check(
    'source is Markdown, not a hero HTML page',
    body.source.includes('| Google Docs |') &&
      body.source.includes('```mermaid') &&
      !body.source.includes('```mermaid\ntimeline') &&
      !/<(?:div|section|img)\b/i.test(body.source),
  );
  check(
    'preview paints the marketing page',
    body.preview.includes('Google Docs for Markdown') && body.preview.includes('Typical Markdown'),
    `previewChars=${body.preview.length}`,
  );
  check('preview renders the comparison table', body.table);
  check('no leftover empty-state copy', !body.empty.includes('unavailable'));

  if (args.screenshot) {
    await page.screenshot({ path: args.screenshot, fullPage: false });
    writeFileSync(
      args.screenshot.replace(/\.png$/i, '.json'),
      `${JSON.stringify({ url: page.url(), ...body, screenshot: args.screenshot }, null, 2)}\n`,
    );
    console.log(`screenshot: ${args.screenshot}`);
  }
} finally {
  await browser.close();
}

const failed = results.filter((result) => !result.pass);
console.log(`\n${results.length - failed.length}/${results.length} welcome-editor checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
