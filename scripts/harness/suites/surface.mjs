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
  check('desktop ribbon is registry-driven',
    (await session.count('.ribbon-body [data-command-id="format.bold"]')) >= 1 &&
    (await session.count('.quick-access [data-command-id="format.bold"]')) >= 1);

  await session.click('.ribbon-tab');
  await session.press('Alt');
  await session.wait(100);
  check('ribbon KeyTips are keyboard discoverable', (await session.count('.ribbon-keytip')) >= 2);
  await session.press('Escape');

  await session.click('.agent-orb');
  const localPrivacy = await session.textContent('.agent-privacy');
  check('local agent privacy disclosure is truthful',
    String(localPrivacy).includes('do not leave this browser'), String(localPrivacy));
  await session.fill('.agent-pill-compose input', 'Show rendered view');
  await session.press('Enter');
  await session.wait(500);
  check('agent visibly raises the relevant ribbon task',
    (await session.count('.ribbon-tab.agent-raised')) >= 1);
  check('agent command changes to rendered-only mode',
    !(await session.isVisible('.editor-pane')) && (await session.isVisible('.preview-pane')));
  check('rendered-only ribbon removes text mutation controls',
    (await session.count('.ribbon-body [data-command-id="format.bold"]')) === 0);

  await session.fill('.agent-pill-compose input', 'Show source and rendering together');
  await session.press('Enter');
  await session.wait(500);
  check('agent can restore split mode through the same command runtime',
    (await session.isVisible('.editor-pane')) && (await session.isVisible('.preview-pane')));
  await session.click('.ribbon-tab:nth-child(2)');
  await session.wait(100);
  if (
    (await session.count('button[data-command-id="input.dictate"]')) === 0 &&
    (await session.count('.ribbon-overflow-trigger')) > 0
  ) {
    await session.click('.ribbon-overflow-trigger');
    await session.wait(100);
  }
  const voiceCount = await session.count('button[data-command-id="input.dictate"]');
  const voiceState = await session.evaluate(() => {
    const button = document.querySelector('button[data-command-id="input.dictate"]');
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

  // Cross the editor/preview focus boundary immediately before the context
  // event. This catches listener lifetimes that accidentally follow React
  // focus state instead of the mounted workspace surface.
  await session.click('.cm-content');
  await session.click('.preview-pane');
  await session.rightClick('.preview-pane', { x: 24, y: 24 });
  await session.waitForSelector('.context-menu', { timeout: 2_000 });
  check('preview right-click opens the marks menu',
    (await session.count('.context-menu')) === 1 && (await session.isVisible('.context-menu')));
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

  const documentPath = await session.evaluate(() => location.pathname);
  await session.goto(`${documentPath}?marks-posture=fold-book`);
  await session.waitForSelector('.fold-ribbon-vertical', { timeout: 20_000 });
  check('book fold uses two hinge-safe ribbon segments',
    (await session.count('.fold-ribbon-primary')) === 1 &&
    (await session.count('.fold-ribbon-hinge')) === 1 &&
    (await session.count('.fold-ribbon-companion')) === 1);

  await session.goto(`${documentPath}?marks-posture=fold-laptop`);
  await session.waitForSelector('.fold-ribbon-horizontal', { timeout: 20_000 });
  check('laptop fold exposes an independent lower touch shelf',
    (await session.count('.fold-ribbon-primary')) === 1 &&
    (await session.count('.fold-ribbon-companion')) === 1);

  await session.goto(`${documentPath}?marks-posture=phone`);
  await session.waitForSelector('.phone-nav', { timeout: 20_000 });
  check('phone uses a focused composer instead of desktop ribbon',
    (await session.count('.phone-nav')) === 1 && (await session.count('.ribbon-body')) === 0);
  await session.click('.phone-nav > button:last-child');
  await session.wait(150);
  const dataMode = await session.evaluate(() => document.documentElement.dataset.marksMode ?? 'local');
  const pairingCount = await session.count('.phone-sheet [data-command-id="identity.pairing"]');
  check('phone page sheet applies phone-confirmation eligibility',
    dataMode === 'service' ? pairingCount === 1 : pairingCount === 0,
    `${dataMode}: ${pairingCount}`);
}

export const SURFACE_CHECK_NAMES = [
  'opening shell does not stay up',
  'document renders blocks',
  'desktop ribbon is registry-driven',
  'ribbon KeyTips are keyboard discoverable',
  'local agent privacy disclosure is truthful',
  'agent visibly raises the relevant ribbon task',
  'agent command changes to rendered-only mode',
  'rendered-only ribbon removes text mutation controls',
  'agent can restore split mode through the same command runtime',
  'voice input is honest',
  'select-all in the preview stays inside the document',
  'preview right-click opens the marks menu',
  'theme toggles',
  'connectivity state is honest',
  'book fold uses two hinge-safe ribbon segments',
  'laptop fold exposes an independent lower touch shelf',
  'phone uses a focused composer instead of desktop ribbon',
  'phone page sheet applies phone-confirmation eligibility',
];
