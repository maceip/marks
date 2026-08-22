/**
 * Portable browser-surface checks that every driver can run.
 *
 * Deep collab / two-peer / REST cases stay in scripts/smoke.mjs
 * (Playwright). This suite covers the glass: create a doc, preview,
 * select-all, context menu, voice affordance, theme, offline.
 */

const FIXTURE = `# Surface harness

Hello from the portable suite.
`;

async function createDocument(session) {
  await session.goto('/');
  try {
    await session.waitForSelector('.new-doc .button.primary', { timeout: 8_000 });
    if (await session.isVisible('.new-doc .button.primary')) {
      await session.click('.new-doc .button.primary');
      return;
    }
  } catch {
    // The persistent rail becomes an overlay below the desktop posture.
  }
  await session.waitForSelector('.home-actions .button.primary', { timeout: 15_000 });
  await session.click('.home-actions .button.primary');
}

export async function runSurface(session, { check }) {
  await createDocument(session);
  await session.waitForSelector('.cm-content', { timeout: 20_000 });
  await session.wait(2000);

  check('opening shell does not stay up', (await session.count('.opening-shell')) === 0);

  await session.click('.cm-content');
  await session.insertText(FIXTURE);
  await session.waitForSelector('.marks-preview .marks-block', { timeout: 20_000 });
  await session.wait(800);

  check('document renders blocks', (await session.count('.marks-preview .marks-block')) >= 1);
  const voiceCount = await session.count('button[aria-label="Voice input"]');
  const voiceState = await session.evaluate(() => {
    const button = document.querySelector('button[aria-label="Voice input"]');
    return button
      ? { disabled: button.hasAttribute('disabled'), title: button.getAttribute('title') ?? '' }
      : null;
  });
  check(
    'voice input is honest',
    voiceCount === 1 && Boolean(voiceState) && (!voiceState.disabled || voiceState.title.includes('not supported')),
    JSON.stringify(voiceState),
  );

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
  const status = await session.textContent('.titlebar .status');
  check(
    'connectivity state is honest',
    String(status).includes('Offline') || String(status).includes('On this device'),
    String(status),
  );
  await session.setOffline(false);
}

export const SURFACE_CHECK_NAMES = [
  'opening shell does not stay up',
  'document renders blocks',
  'voice input is honest',
  'select-all in the preview stays inside the document',
  'preview right-click opens the marks menu',
  'theme toggles',
  'connectivity state is honest',
];
