// Mobile browser UI proof against a live marks-server: a real phone
// profile (touch, mobile viewport, device scale factor, mobile user agent)
// lands in the document-first phone experience, reaches the editor through
// the mobile ribbon, and types by touch; narrow widths never overflow
// horizontally; primary touch targets stay comfortably tappable. If the
// phone entry ever becomes a home screen again, the home branch covers it.
import { chromium, devices } from 'playwright';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHROME_LAUNCH_ARGS, launchEnv } from './harness/env.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bin = process.env.MARKS_BIN ?? join(root, 'target', 'debug', 'marks-server');
const staticDir = process.env.MARKS_STATIC_DIR ?? join(root, 'client', 'dist');
const work = mkdtempSync(join(tmpdir(), 'marks-mobile-ui.'));
const port = await new Promise((resolvePort, rejectPort) => {
  const reservation = createServer();
  reservation.once('error', rejectPort);
  reservation.listen(0, '127.0.0.1', () => {
    const address = reservation.address();
    if (!address || typeof address === 'string') {
      reservation.close();
      rejectPort(new Error('could not reserve a mobile UI test port'));
      return;
    }
    reservation.close((error) => {
      if (error) rejectPort(error);
      else resolvePort(address.port);
    });
  });
});
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

const RIBBON = '.phone-ribbon';

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

async function assertTappable(locator, label, viewportWidth) {
  const box = await locator.boundingBox();
  assert(box, `${label} renders a tappable box`);
  assert(
    box.height >= 40 && box.width >= 40,
    `${label} is ${box.width}x${box.height}px; touch targets need at least 40px`,
  );
  assert(
    box.x >= 0 && box.x + box.width <= viewportWidth,
    `${label} sits inside the ${viewportWidth}px viewport`,
  );
  console.log(`  ok   ${label} is a ${Math.round(box.width)}x${Math.round(box.height)}px touch target`);
  return box;
}

async function reachEditorByTouch(page, viewportWidth) {
  // Service mode is document-first: the temporary opening shell must resolve
  // directly to the unique public page, never to the workspace home.
  await page.locator(RIBBON).waitFor({ timeout: 30_000 });
  await assertNoHorizontalOverflow(page, `${viewportWidth}px entry`);
  assert.equal(await page.locator('.home-surface').count(), 0, 'anonymous service entry never exposes workspace home');
  await page.waitForURL((url) => /^\/d\/document_/.test(url.pathname), { timeout: 30_000 });
  assert.match(page.url(), /\/d\/document_/, 'anonymous mobile entry receives a unique document slug');

  // Import remains the first ribbon object while the document itself opens
  // as the rendered, editable Markdown introduction.
  const importTab = page.getByRole('tab', { name: 'Import', exact: true });
  assert.equal(await importTab.getAttribute('aria-selected'), 'true', 'Import is selected on mobile first paint');
  await assertTappable(importTab, 'initial Import ribbon tab', viewportWidth);
  await page.waitForFunction(
    () =>
      document.querySelector('.marks-preview')?.textContent?.includes('Google Docs for Markdown') &&
      document.querySelector('.marks-preview table') != null,
    undefined,
    { timeout: 30_000 },
  );
  const hero = await page.evaluate(() => {
    const app = document.querySelector('.app');
    const heading = document.querySelector('.marks-preview h1');
    const style = heading ? getComputedStyle(heading) : null;
    return {
      marketing: app?.getAttribute('data-marketing'),
      fontSize: Number.parseFloat(style?.fontSize ?? '0'),
      borderBottomWidth: style?.borderBottomWidth ?? '',
    };
  });
  assert.equal(hero.marketing, 'true', 'the anonymous clone carries the marketing-page presentation marker');
  assert(hero.fontSize > 30, `marketing hero heading is ${hero.fontSize}px`);
  assert.equal(hero.borderBottomWidth, '0px', 'marketing hero heading is borderless');
  console.log('  ok   anonymous slug first paints the rendered Markdown hero and comparison table');

  const viewTab = page.getByRole('tab', { name: 'View', exact: true });
  await assertTappable(viewTab, 'View ribbon tab', viewportWidth);
  await viewTab.tap();
  const editorCommand = page.locator('.phone-ribbon [data-command-id="view.editor"]');
  await assertTappable(editorCommand, 'Editor command', viewportWidth);
  await editorCommand.tap();
  await page.locator('.cm-content').first().waitFor({ timeout: 30_000 });
  console.log('  ok   touch navigation reaches the editor');
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
    await reachEditorByTouch(page, page.viewportSize().width);

    const sharedUrl = page.url();
    const linkedPhone = await browser.newContext({ ...devices['Pixel 7'] });
    const linkedPage = await linkedPhone.newPage();
    linkedPage.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message));
    await linkedPage.goto(sharedUrl, { waitUntil: 'domcontentloaded' });
    await linkedPage.locator(RIBBON).waitFor({ timeout: 30_000 });
    await linkedPage.waitForFunction(
      () => document.querySelector('.marks-preview')?.textContent?.includes('Google Docs for Markdown'),
      undefined,
      { timeout: 30_000 },
    );
    assert.equal(linkedPage.url(), sharedUrl, 'a copied slug opens the same public page');
    assert.equal(
      await linkedPage.getByRole('tab', { name: 'Import', exact: true }).getAttribute('aria-selected'),
      'true',
      'a cold direct mobile slug keeps Import selected while opening in Preview',
    );
    console.log('  ok   a different anonymous phone cold-opens the copied slug in Preview with Import selected');
    await linkedPhone.close();

    const loginPrompt = page.locator('.phone-identity');
    assert.match(await loginPrompt.innerText(), /Open this page on a laptop to log in/i);
    await loginPrompt.tap();
    const loginDialog = page.getByRole('dialog');
    await loginDialog.waitFor({ timeout: 10_000 });
    assert.match(await loginDialog.innerText(), /Open this page on a laptop/i);
    assert.equal(
      await loginDialog.getByRole('button', { name: 'Log in on this phone only', exact: true }).isVisible(),
      false,
      'solo phone login stays buried in a collapsed disclosure',
    );
    console.log('  ok   logged-out mobile login is laptop-first and buries solo-phone login');
    await loginDialog.getByRole('button', { name: 'Close', exact: true }).click();

    await page.locator('.cm-content').tap();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a');
    await page.keyboard.type('Mobile touch editing works');
    await page.waitForFunction(
      () =>
        document.querySelector('.cm-content')?.textContent?.includes('Mobile touch editing works') &&
        !document.querySelector('.cm-content')?.textContent?.includes('Google Docs for Markdown'),
      undefined,
      { timeout: 30_000 },
    );
    console.log('  ok   the user can delete and replace the entire Markdown introduction');
    await assertNoHorizontalOverflow(page, 'phone editor');
    await phone.close();

    // The smallest supported phone width still lays out cleanly and keeps
    // the same touch path reachable.
    const small = await browser.newContext({
      viewport: { width: 320, height: 568 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
    });
    const smallPage = await small.newPage();
    smallPage.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message));
    await smallPage.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
    await reachEditorByTouch(smallPage, 320);
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
