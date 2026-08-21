/**
 * Portable browser-surface checks that every driver can run.
 *
 * Deep collab / two-peer / Yjs / REST cases stay in scripts/smoke.mjs
 * (Playwright). This suite covers the glass: create a doc, preview,
 * select-all, context menu, comments, voice affordance, theme, offline.
 */

const FIXTURE = `# Surface harness

Hello from the portable suite.
`;

export async function runSurface(session, { check }) {
  await session.goto('/');
  await session.waitForSelector('.new-doc', { timeout: 20_000 });
  await session.click('.new-doc .button.primary');
  await session.waitForSelector('.cm-content', { timeout: 20_000 });
  await session.wait(2000);

  check('opening shell does not stay up', (await session.count('.opening-shell')) === 0);

  await session.click('.cm-content');
  await session.insertText(FIXTURE);
  await session.waitForSelector('.marks-preview .marks-block', { timeout: 20_000 });
  await session.wait(800);

  check('document renders blocks', (await session.count('.marks-preview .marks-block')) >= 1);
  check('voice input is offered', (await session.count('button[aria-label="Voice input"]')) === 1);

  await session.click('.preview-pane');
  await session.press('Control+A');
  const previewSelection = await session.evaluate(() => document.getSelection()?.toString() ?? '');
  check(
    'select-all in the preview stays inside the document',
    typeof previewSelection === 'string' &&
      previewSelection.includes('Surface harness') &&
      !previewSelection.includes('Benchmark engines'),
    previewSelection ? `chars=${String(previewSelection).length}` : 'empty selection',
  );

  await session.rightClick('.marks-preview', { x: 24, y: 24 });
  await session.wait(250);
  check('preview right-click opens the marks menu', (await session.count('.context-menu')) === 1);
  await session.press('Escape');

  await session.click('.cm-content');
  await session.press('Control+A');
  await session.click('button[aria-label="Comment"]');
  await session.wait(250);
  check('comment composer opens on a selection', (await session.count('.comment-composer textarea')) === 1);
  await session.fill('.comment-composer textarea', 'A review note');
  await session.click('.comment-composer button.primary');
  await session.wait(500);
  check('a comment is stored on the document', (await session.count('.comment-card')) >= 1);

  const themeBefore = await session.evaluate(() => document.documentElement.dataset.theme ?? 'light');
  const themeButton =
    themeBefore === 'dark'
      ? 'button[aria-label="Switch to light theme"]'
      : 'button[aria-label="Switch to dark theme"]';
  await session.click(themeButton);
  await session.wait(400);
  const themeAfter = await session.evaluate(() => document.documentElement.dataset.theme ?? 'light');
  check('theme toggles', themeAfter !== themeBefore, `${themeBefore} -> ${themeAfter}`);

  await session.setOffline(true);
  await session.wait(1500);
  const status = await session.textContent('.topbar .status');
  check('offline is reported', String(status).includes('Offline'), String(status));
  await session.setOffline(false);
}

export const SURFACE_CHECK_NAMES = [
  'opening shell does not stay up',
  'document renders blocks',
  'voice input is offered',
  'select-all in the preview stays inside the document',
  'preview right-click opens the marks menu',
  'comment composer opens on a selection',
  'a comment is stored on the document',
  'theme toggles',
  'offline is reported',
];
