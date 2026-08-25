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

const HOME_PRIMARY = '.home-actions .button.primary, .new-doc .button.primary';
const RIBBON = '.phone-ribbon';
const EDITOR_TAB = '.phone-ribbon [data-command-id="view.editor"]';

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
  // The phone entry may briefly flash the home surface before settling on
  // the document-first experience; wait for the stable ribbon state and
  // fall back to the home flow only when it never arrives.
  const ribbonSettled = await page
    .locator(RIBBON)
    .waitFor({ timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  await assertNoHorizontalOverflow(page, `${viewportWidth}px entry`);
  if (ribbonSettled) {
    // Document-first phone experience: the mobile ribbon is the surface.
    const editorTab = page.locator(EDITOR_TAB).first();
    await assertTappable(editorTab, 'ribbon editor tab', viewportWidth);
    await editorTab.tap();
  } else {
    const action = page.locator(HOME_PRIMARY).first();
    await assertTappable(action, 'home primary action', viewportWidth);
    await action.tap();
    await page.waitForURL((url) => url.pathname.startsWith('/d/document_'), { timeout: 30_000 });
  }
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
