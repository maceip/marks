// Anonymous login and mobile browser UI proof against a live marks-server: a
// desktop first proves the QR flow, then a real phone
// profile (touch, mobile viewport, device scale factor, mobile user agent)
// lands in the document-first phone experience, reaches the editor through
// the mobile ribbon, and types by touch; narrow widths never overflow
// horizontally; primary touch targets stay comfortably tappable. A return to
// the old Home entry is a failure: anonymous service entry is document-first.
import { chromium, devices } from 'playwright';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { accessSync, constants, cpSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  childIsRunning,
  terminateChildAndCleanup,
} from './harness/child-lifecycle.mjs';
import { CHROME_LAUNCH_ARGS, launchEnv } from './harness/env.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bin = process.env.MARKS_BIN ?? join(root, 'target', 'debug', 'marks-server');
const work = mkdtempSync(join(tmpdir(), 'marks-mobile-ui.'));
const configuredStaticDir = process.env.MARKS_STATIC_DIR?.trim();
const staticDir = join(work, 'service-dist');
let server = null;
let serverSpawnError = null;
let stopped = false;
let stopPromise = null;

const wait = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
const stop = async () => {
  if (stopPromise) return stopPromise;
  stopped = true;
  stopPromise = terminateChildAndCleanup(
    server,
    () => rmSync(work, { recursive: true, force: true }),
  );
  return stopPromise;
};
process.once('exit', () => {
  if (childIsRunning(server)) {
    server.kill('SIGKILL');
    return;
  }
  rmSync(work, { recursive: true, force: true });
});

try {
  accessSync(bin, constants.X_OK);
  // Keep this proof independent from client/dist. Other validation lanes may
  // legitimately build the default local client at the same time; sharing
  // that directory used to turn an artifact mismatch into a misleading wait
  // for a phone ribbon that a local-mode root never renders. Even an explicit
  // release artifact is snapshotted before the server starts.
  if (configuredStaticDir) {
    const source = resolve(root, configuredStaticDir);
    console.log(`copying service artifact ${source} into the isolated mobile proof`);
    cpSync(source, staticDir, { recursive: true });
  } else {
    console.log('building an isolated service-mode client for the mobile proof');
    execFileSync(
      'npm',
      ['run', 'build', '--workspace=client', '--', '--outDir', staticDir, '--emptyOutDir'],
      {
        cwd: root,
        stdio: ['ignore', 'ignore', 'inherit'],
        timeout: 120_000,
        env: {
          ...process.env,
          VITE_MARKS_DATA_MODE: 'service',
          VITE_MARKS_TEST_SERVICE_WORKER: '0',
        },
      },
    );
  }
} catch (error) {
  await stop();
  throw error;
}
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
let fatalError = null;
let rejectFatal = null;
const fatalFailure = new Promise((_, reject) => {
  rejectFatal = reject;
});
void fatalFailure.catch(() => undefined);
function recordFatal(error) {
  if (fatalError) return;
  fatalError = error instanceof Error ? error : new Error(String(error));
  rejectFatal?.(fatalError);
}
function throwIfFatal() {
  if (fatalError) throw fatalError;
}

server = spawn(bin, [], {
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
server.once('error', (error) => {
  serverSpawnError = error;
  recordFatal(new Error(`marks-server could not start: ${error.message}`));
});
server.once('exit', (code, signal) => {
  if (!stopped) {
    recordFatal(new Error(
      `marks-server exited unexpectedly (code=${String(code)}, signal=${String(signal)})${serverOutput() ? `\n${serverOutput()}` : ''}`,
    ));
  }
});

const RIBBON = '.phone-ribbon';

function serverOutput() {
  return Buffer.concat(serverLog).toString().trim();
}

async function waitForServer() {
  const deadline = Date.now() + 15_000;
  while (true) {
    throwIfFatal();
    if (serverSpawnError) {
      throw new Error(`marks-server could not start: ${serverSpawnError.message}`);
    }
    if (server.exitCode !== null || server.signalCode !== null) {
      throw new Error(
        `marks-server exited before becoming ready (code=${String(server.exitCode)}, signal=${String(server.signalCode)})${serverOutput() ? `\n${serverOutput()}` : ''}`,
      );
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      const response = await fetch(`${origin}/readyz`, {
        signal: AbortSignal.timeout(Math.max(1, Math.min(1_000, remaining))),
      });
      if (response.ok) return;
    } catch {
      throwIfFatal();
    }
    const pause = Math.min(250, deadline - Date.now());
    if (pause > 0) await Promise.race([wait(pause), fatalFailure]);
  }
  throw new Error(
    `marks-server did not become ready within 15 seconds${serverOutput() ? `\n${serverOutput()}` : ''}`,
  );
}

async function assertServiceMode(page, label) {
  const mode = await page.evaluate(() => document.documentElement.dataset.marksMode ?? 'missing');
  assert.equal(
    mode,
    'service',
    `${label} loaded data-marks-mode=${mode}; the mobile proof requires an isolated service-mode artifact`,
  );
}

function rejectOnPageFailure(page, label, pageErrors) {
  page.once('pageerror', (error) => {
    const detail = error.stack ?? error.message;
    pageErrors.push(`${label}: ${detail}`);
    recordFatal(new Error(`${label} page error: ${detail}`));
  });
  page.once('crash', () => {
    const error = new Error(`${label} page crashed`);
    pageErrors.push(error.message);
    recordFatal(error);
  });
  return fatalFailure;
}

async function navigate(page, url, failure) {
  await Promise.race([
    page.goto(url, { waitUntil: 'domcontentloaded' }),
    failure,
    fatalFailure,
  ]);
}

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
    `${label} spans x=${box.x}..${box.x + box.width} outside the ${viewportWidth}px viewport`,
  );
  console.log(`  ok   ${label} is a ${Math.round(box.width)}x${Math.round(box.height)}px touch target`);
  return box;
}

async function reachEditorByTouch(page, viewportWidth, failure) {
  // Service mode is document-first: the temporary opening shell must resolve
  // directly to the unique public page, never to the workspace home.
  await assertServiceMode(page, `${viewportWidth}px entry`);
  await Promise.race([
    Promise.all([
      page.waitForURL((url) => /^\/d\/document_/.test(url.pathname), { timeout: 30_000 }),
      page.locator(RIBBON).waitFor({ timeout: 30_000 }),
      page.waitForFunction(
        () =>
          document.querySelector('.marks-preview')?.innerText?.includes('Google Docs for Markdown') &&
          document.querySelector('.marks-preview table') != null &&
          document.querySelector('.workspace')?.classList.contains('mode-preview') === true &&
          document.querySelector('.app')?.getAttribute('data-marketing') === 'true',
        undefined,
        { timeout: 30_000 },
      ),
    ]),
    failure,
    fatalFailure,
  ]);
  await assertNoHorizontalOverflow(page, `${viewportWidth}px entry`);
  assert.equal(await page.locator('.home-surface').count(), 0, 'anonymous service entry never exposes workspace home');
  assert.match(page.url(), /\/d\/document_/, 'anonymous mobile entry receives a unique document slug');

  // Templates and login lead the ribbon while the document itself opens as
  // the rendered, editable Markdown introduction.
  const templateTab = page.getByRole('tab', { name: 'Start from template', exact: true });
  assert.equal(await templateTab.getAttribute('aria-selected'), 'true', 'Start from template is selected on mobile first paint');
  await assertTappable(templateTab, 'initial Start from template ribbon tab', viewportWidth);
  const ribbonLabels = await page.locator('.phone-ribbon-tabs [role="tab"]').allTextContents();
  assert.deepEqual(
    ribbonLabels.slice(0, 2).map((label) => label.trim()),
    ['Start from template', 'Log In'],
    'anonymous mobile ribbon starts with templates and login',
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
  // At the 320px support floor, the required Templates + Log In leaders leave
  // View just beyond the horizontally scrollable tab viewport. Reveal it the
  // same way a horizontal ribbon gesture would before testing the touch path.
  await viewTab.evaluate((tab) => {
    const strip = tab.parentElement;
    if (!strip) return;
    strip.scrollLeft = Math.max(
      0,
      tab.offsetLeft - Math.floor((strip.clientWidth - tab.clientWidth) / 2),
    );
  });
  await page.waitForTimeout(50);
  await assertTappable(viewTab, 'View ribbon tab', viewportWidth);
  await viewTab.tap();
  const editorCommand = page.locator('.phone-ribbon [data-command-id="view.editor"]');
  await assertTappable(editorCommand, 'Editor command', viewportWidth);
  await editorCommand.tap();
  await page.locator('.cm-content').first().waitFor({ timeout: 30_000 });
  console.log('  ok   touch navigation reaches the editor');
}

async function proveDesktopLogin(browser, pageErrors) {
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await desktop.newPage();
  page.setDefaultTimeout(30_000);
  page.setDefaultNavigationTimeout(30_000);
  const failure = rejectOnPageFailure(page, 'desktop login', pageErrors);
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && new URL(response.url()).pathname === '/v1/documents',
    { timeout: 30_000 },
  );
  void created.catch(() => undefined);
  await navigate(page, `${origin}/`, failure);
  await assertServiceMode(page, 'desktop login');
  const createdResponse = await Promise.race([created, failure, fatalFailure]);
  assert.equal(
    createdResponse.status(),
    201,
    `anonymous desktop bootstrap returned ${createdResponse.status()} from /v1/documents`,
  );
  await page.locator('.ribbon-body').waitFor({ timeout: 30_000 });
  const ribbonLabels = await page.locator('.ribbon-tabs [role="tab"]').allTextContents();
  assert.deepEqual(
    ribbonLabels.slice(0, 2).map((label) => label.trim()),
    ['Start from template', 'Log In'],
    'anonymous desktop ribbon starts with templates and login',
  );
  await page.getByRole('tab', { name: 'Log In', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 10_000 });
  assert.equal(await dialog.getByRole('heading').innerText(), 'Log In');
  assert.equal(await dialog.locator('.qr-mark').count(), 1, 'desktop login renders the QR code');
  assert.match(await dialog.innerText(), /Scan with your phone/i);
  console.log('  ok   second-position desktop Log In opens the QR flow');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await dialog.waitFor({ state: 'detached', timeout: 10_000 });
  await desktop.close();
}

async function runProof() {
  await waitForServer();

  const browser = await chromium.launch({
    args: CHROME_LAUNCH_ARGS,
    env: launchEnv(),
    timeout: 30_000,
  });
  const pageErrors = [];
  try {
    await proveDesktopLogin(browser, pageErrors);

    // A current Android phone profile: touch, mobile UA, high DPR.
    const phone = await browser.newContext({ ...devices['Pixel 7'] });
    const page = await phone.newPage();
    page.setDefaultTimeout(30_000);
    page.setDefaultNavigationTimeout(30_000);
    const pageFailure = rejectOnPageFailure(page, 'primary phone', pageErrors);
    const created = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' && new URL(response.url()).pathname === '/v1/documents',
      { timeout: 30_000 },
    );
    void created.catch(() => undefined);
    await navigate(page, `${origin}/`, pageFailure);
    await assertServiceMode(page, 'primary phone');
    const createdResponse = await Promise.race([created, pageFailure, fatalFailure]);
    assert.equal(
      createdResponse.status(),
      201,
      `anonymous mobile bootstrap returned ${createdResponse.status()} from /v1/documents`,
    );
    await reachEditorByTouch(page, page.viewportSize().width, pageFailure);

    const sharedUrl = page.url();
    const linkedPhone = await browser.newContext({ ...devices['Pixel 7'] });
    const linkedPage = await linkedPhone.newPage();
    linkedPage.setDefaultTimeout(30_000);
    linkedPage.setDefaultNavigationTimeout(30_000);
    const linkedFailure = rejectOnPageFailure(linkedPage, 'copied mobile slug', pageErrors);
    await navigate(linkedPage, sharedUrl, linkedFailure);
    await assertServiceMode(linkedPage, 'copied mobile slug');
    await Promise.race([
      Promise.all([
        linkedPage.locator(RIBBON).waitFor({ timeout: 30_000 }),
        linkedPage.waitForFunction(
          () => document.querySelector('.marks-preview')?.textContent?.includes('Google Docs for Markdown'),
          undefined,
          { timeout: 30_000 },
        ),
      ]),
      linkedFailure,
      fatalFailure,
    ]);
    assert.equal(linkedPage.url(), sharedUrl, 'a copied slug opens the same public page');
    assert.equal(
      await linkedPage.getByRole('tab', { name: 'Start from template', exact: true }).getAttribute('aria-selected'),
      'true',
      'a cold direct mobile slug keeps Start from template selected while opening in Preview',
    );
    console.log('  ok   a different anonymous phone cold-opens the copied slug in Preview with Start from template selected');
    await linkedPhone.close();

    const loginPrompt = page.locator('.phone-identity');
    assert.match(await loginPrompt.innerText(), /Open this page on a laptop to log in/i);
    const loginControl = page.getByRole('tab', { name: 'Log In', exact: true });
    await assertTappable(loginControl, 'second-position Log In ribbon control', page.viewportSize().width);
    await loginControl.tap();
    const loginDialog = page.getByRole('dialog');
    await loginDialog.waitFor({ timeout: 10_000 });
    assert.match(await loginDialog.innerText(), /Open this page on a laptop/i);
    assert.equal(await loginDialog.locator('details.keep-solo-disclosure').count(), 0, 'mobile login renders no phone-only disclosure');
    assert.doesNotMatch(
      await loginDialog.innerText(),
      /phone only|only this phone|continue with only/i,
      'mobile login does not advertise phone-only registration',
    );
    console.log('  ok   logged-out mobile login is laptop-first with no phone-only registration UI');
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
    smallPage.setDefaultTimeout(30_000);
    smallPage.setDefaultNavigationTimeout(30_000);
    const smallFailure = rejectOnPageFailure(smallPage, '320px phone', pageErrors);
    const smallCreated = smallPage.waitForResponse(
      (response) =>
        response.request().method() === 'POST' && new URL(response.url()).pathname === '/v1/documents',
      { timeout: 30_000 },
    );
    void smallCreated.catch(() => undefined);
    await navigate(smallPage, `${origin}/`, smallFailure);
    await assertServiceMode(smallPage, '320px phone');
    const smallCreatedResponse = await Promise.race([smallCreated, smallFailure, fatalFailure]);
    assert.equal(
      smallCreatedResponse.status(),
      201,
      `320px anonymous bootstrap returned ${smallCreatedResponse.status()} from /v1/documents`,
    );
    await reachEditorByTouch(smallPage, 320, smallFailure);
    await small.close();

    throwIfFatal();
    assert.deepEqual(pageErrors, [], `mobile pages threw: ${pageErrors.join('\n')}`);
  } finally {
    await browser.close();
  }
  throwIfFatal();
}

try {
  await Promise.race([runProof(), fatalFailure]);
  throwIfFatal();
  await stop();
  console.log('mobile browser UI checks passed');
} catch (error) {
  const output = Buffer.concat(serverLog).toString();
  await stop().catch((shutdownError) => console.error(shutdownError));
  console.error(output);
  console.error(error);
  process.exitCode = 1;
}
