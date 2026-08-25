// Mobile browser UI proof against a live marks-server: a real phone
// profile (touch, mobile viewport, device scale factor, mobile user agent)
// admits, creates a document by tapping, and types into the editor; narrow
// widths never overflow horizontally; the primary touch target stays
// comfortably tappable.
import { chromium, devices } from 'playwright';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHROME_LAUNCH_ARGS, launchEnv } from './harness/env.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bin = process.env.MARKS_BIN ?? join(root, 'target', 'debug', 'marks-server');
const staticDir = process.env.MARKS_STATIC_DIR ?? join(root, 'client', 'dist');
const work = mkdtempSync(join(tmpdir(), 'marks-mobile-ui.'));
const port = 4219;
const origin = `http://127.0.0.1:${port}`;

const serverLog = [];
const server = spawn(bin, [], {
  env: {
    ...process.env,
    MARKS_LISTEN: `127.0.0.1:${port}`,
    MARKS_ORIGIN: origin,
    MARKS_DB: join(work, 'marks.db3'),
    MARKS_ASSET_DIR: join(work, 'doc-assets'),
    MARKS_STATIC_DIR: staticDir,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (chunk) => serverLog.push(chunk));
server.stderr.on('data', (chunk) => serverLog.push(chunk));
let stopped = false;
const stop = () => {
  if (stopped) return;
  stopped = true;
  server.kill('SIGTERM');
  rmSync(work, { recursive: true, force: true });
};
process.on('exit', stop);

const PRIMARY = '.home-actions .button.primary, .new-doc .button.primary';

async function assertNoHorizontalOverflow(page, label) {
  const overflow = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  assert(
    overflow.scroll <= overflow.client + 1,
    `${label}: content ${overflow.scroll}px overflows the ${overflow.client}px viewport`,
  );
  console.log(`  ok   ${label} fits without horizontal overflow (${overflow.client}px)`);
}

try {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if ((await fetch(`${origin}/healthz`)).ok) break;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }

  const browser = await chromium.launch({ args: CHROME_LAUNCH_ARGS, env: launchEnv() });
  const pageErrors = [];
  try {
    // A current Android phone profile: touch, mobile UA, high DPR.
    const phone = await browser.newContext({ ...devices['Pixel 7'] });
    const page = await phone.newPage();
    page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message));
    await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(PRIMARY, { timeout: 30_000 });
    await assertNoHorizontalOverflow(page, 'phone home');

    const action = page.locator(PRIMARY).first();
    const box = await action.boundingBox();
    assert(box, 'primary action renders a tappable box');
    assert(
      box.height >= 40 && box.width >= 40,
      `primary action is ${box.width}x${box.height}px; touch targets need at least 40px`,
    );
    const viewport = page.viewportSize();
    assert(
      box.x >= 0 && box.x + box.width <= viewport.width,
      'primary action sits inside the phone viewport',
    );
    console.log(`  ok   primary action is a ${Math.round(box.width)}x${Math.round(box.height)}px touch target`);

    await action.tap();
    await page.waitForURL((url) => url.pathname.startsWith('/d/document_'), { timeout: 30_000 });
    await page.waitForSelector('.cm-content', { timeout: 30_000 });
    console.log('  ok   tapping the primary action admits and opens a document');

    await page.locator('.cm-content').tap();
    await page.keyboard.type('Mobile touch editing works');
    await page.waitForFunction(
      () => document.querySelector('.cm-content')?.textContent?.includes('Mobile touch editing works'),
      undefined,
      { timeout: 30_000 },
    );
    console.log('  ok   the editor accepts touch-initiated typing');
    await assertNoHorizontalOverflow(page, 'phone editor');
    await phone.close();

    // The smallest supported phone width still lays out cleanly.
    const small = await browser.newContext({
      viewport: { width: 320, height: 568 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
    });
    const smallPage = await small.newPage();
    smallPage.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message));
    await smallPage.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
    await smallPage.waitForSelector(PRIMARY, { timeout: 30_000 });
    await assertNoHorizontalOverflow(smallPage, '320px home');
    const smallBox = await smallPage.locator(PRIMARY).first().boundingBox();
    assert(
      smallBox && smallBox.x >= 0 && smallBox.x + smallBox.width <= 320,
      'primary action stays inside a 320px viewport',
    );
    console.log('  ok   the 320px layout keeps the primary action reachable');
    await small.close();

    assert.deepEqual(pageErrors, [], `mobile pages threw: ${pageErrors.join('\n')}`);
  } finally {
    await browser.close();
  }
  console.log('mobile browser UI checks passed');
  // The spawned server's piped stdio would otherwise keep the event loop
  // alive forever; tear down and exit explicitly.
  stop();
  process.exit(0);
} catch (error) {
  console.error(Buffer.concat(serverLog).toString());
  console.error(error);
  stop();
  process.exit(1);
}
