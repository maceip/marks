/**
 * Portable browser-surface checks that every driver can run.
 *
 * Deep collaboration and REST cases stay in scripts/ci-service-ui.mjs
 * (Playwright against marks-server). This suite covers the portable glass:
 * create a doc, preview, select-all, context menu, voice, theme, and offline.
 */

import { parseBooleanFlag } from '../env.mjs';

const EXPECT_RIBBON_WILD = parseBooleanFlag(process.env.MARKS_EXPECT_RIBBON_WILD);

const FIXTURE = `# Surface harness

Hello from the portable suite.

Currently this note targets API v3.
`;

async function proposeFromInPageAgent(session, commandId) {
  return session.evaluate((id) => {
    if (!window.marksRibbon) return null;
    window.marksRibbon.focus([id], 5_000);
    return window.marksRibbon.propose(id).id;
  }, commandId);
}

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

  const materialState = await session.evaluate(() => ({
    tier: document.documentElement.dataset.surfaceTier,
    engine: document.documentElement.dataset.surfaceEngine,
    documentCanvases: document.querySelectorAll('.editor-pane .surface-material-canvas, .preview-pane .surface-material-canvas').length,
  }));
  check('surface tier is explicit', ['opaque', 'foundation', 'balanced', 'cinematic'].includes(materialState.tier), JSON.stringify(materialState));
  check('scrolling document bodies stay opaque', materialState.documentCanvases === 0, JSON.stringify(materialState));

  const preferenceState = await session.evaluate(() => {
    const root = document.documentElement;
    root.dataset.motion = 'reduced';
    root.dataset.glass = 'reduced';
    const canvasesHidden = [...document.querySelectorAll('.surface-material-canvas')]
      .every((canvas) => getComputedStyle(canvas).display === 'none');
    const opaque = [...document.querySelectorAll('.surface-material-host')]
      .every((host) => getComputedStyle(host).backdropFilter === 'none');
    const motionStopped = [...document.querySelectorAll('.surface-material-canvas')]
      .every((canvas) => getComputedStyle(canvas).transitionDuration === '0s');
    root.dataset.motion = 'full';
    root.dataset.glass = 'full';
    return { canvasesHidden, opaque, motionStopped };
  });
  check('reduced glass removes shader and blur', preferenceState.canvasesHidden && preferenceState.opaque, JSON.stringify(preferenceState));
  check('reduced motion stops material transitions', preferenceState.motionStopped, JSON.stringify(preferenceState));

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

  const ribbonWildState = await session.evaluate(() => document.documentElement.dataset.marksRibbonWild ?? 'missing');
  const ribbonWildEnabled = ribbonWildState === 'enabled';
  check('ribbon-wild build flag matches the expected state',
    ribbonWildEnabled === EXPECT_RIBBON_WILD,
    `expected=${EXPECT_RIBBON_WILD ? 'enabled' : 'disabled'} actual=${ribbonWildState}`);

  if (ribbonWildEnabled) {
    const horizonRunId = await proposeFromInPageAgent(session, 'wild.intent-horizon');
    await session.waitForSelector('.wild-studio[data-wild-capability="intent"]', { timeout: 10_000 });
    const horizonReceipt = await session.evaluate((runId) => {
      const receipt = window.marksRibbon?.state().receipts.find((item) => item.id === runId);
      return receipt ? { source: receipt.source, status: receipt.status } : null;
    }, horizonRunId);
    check('in-page agent can visibly operate the possibility ribbon layer',
      typeof horizonRunId === 'string' && horizonReceipt?.source === 'agent' && horizonReceipt?.status === 'succeeded',
      JSON.stringify(horizonReceipt));
    check('wild studio exposes all five integrated capabilities',
      (await session.count('.wild-nav [data-wild-nav]')) === 5 &&
      (await session.count('.intent-horizon')) === 1);

    await session.click('[data-wild-nav="consequences"]');
    await session.waitForSelector('.wild-studio[data-wild-capability="consequences"]');
    check('consequence lanes expose all product-effect planes',
      (await session.count('.consequence-lanes.is-detailed [data-lane]')) === 5);

    await session.click('[data-wild-nav="half-life"]');
    await session.waitForSelector('.wild-studio[data-wild-capability="half-life"] .half-life-list article', { timeout: 10_000 });
    check('context half-life discovers live source claims',
      (await session.count('.half-life-list article')) >= 2);

    await session.click('[data-wild-nav="causal"]');
    await session.waitForSelector('.wild-studio[data-wild-capability="causal"] .causal-ledger article', { timeout: 10_000 });
    check('causal lightpath seals actual command receipts',
      (await session.count('.causal-ledger article[data-status="succeeded"]')) >= 1);
    await session.click('button[aria-label="Close possibility layer"]');

    await session.click('.cm-content');
    await session.press('Control+A');
    const boldRunId = await proposeFromInPageAgent(session, 'format.bold');
    await session.waitForSelector('.causal-lightpath[data-command-id="format.bold"][data-command-phase="finished"]', { timeout: 10_000 });
    check('source-changing agent work paints a live causal lightpath',
      typeof boldRunId === 'string' && (await session.isVisible('.causal-lightpath')));

    await proposeFromInPageAgent(session, 'wild.counterfactual-shelf');
    await session.waitForSelector('.wild-studio[data-wild-capability="counterfactuals"] .shelf-cards > button', { timeout: 10_000 });
    check('successful source commands capture a reversible counterfactual',
      (await session.count('.shelf-cards > button')) >= 1 &&
      (await session.count('.counterfactual-preview .safe')) === 1);
    await session.click('button[aria-label="Close possibility layer"]');
  } else {
    const disabledState = await session.evaluate(() => ({
      dom: document.querySelectorAll('.wild-studio, .causal-lightpath').length,
      tools: window.marksRibbon?.listTools().filter((tool) => tool.commandId.startsWith('wild.')).length ?? -1,
      commands: document.querySelectorAll('[data-command-id^="wild."]').length,
    }));
    check('disabled ribbon-wild exposes no commands, agent tools, or surfaces',
      disabledState.dom === 0 && disabledState.tools === 0 && disabledState.commands === 0,
      JSON.stringify(disabledState));
  }

  const homeTabOwnsHitTarget = await session.evaluate(() => {
    const home = [...document.querySelectorAll('.ribbon-tab')]
      .find((tab) => tab.textContent?.trim() === 'Home');
    if (!(home instanceof HTMLButtonElement)) return false;
    const rect = home.getBoundingClientRect();
    return document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) === home;
  });
  check('selection toolbar preserves ribbon tab hit targets', homeTabOwnsHitTarget);

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

  const contextLoss = await session.evaluate(() => {
    const canvas = document.querySelector('.surface-material-canvas[data-ready="true"]');
    if (!canvas) return { applicable: false, tier: document.documentElement.dataset.surfaceTier };
    canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    return {
      applicable: true,
      tier: document.documentElement.dataset.surfaceTier,
      engine: document.documentElement.dataset.surfaceEngine,
      canvases: document.querySelectorAll('.surface-material-canvas').length,
    };
  });
  check(
    'WebGL context loss removes canvases',
    !contextLoss.applicable || (contextLoss.tier === 'foundation' && contextLoss.engine === 'css' && contextLoss.canvases === 0),
    JSON.stringify(contextLoss),
  );

  const documentPath = await session.evaluate(() => location.pathname);
  await session.goto(`${documentPath}?marks-posture=fold-book`);
  await session.waitForSelector('.fold-ribbon-vertical', { timeout: 20_000 });
  check('book fold uses two hinge-safe ribbon segments',
    (await session.count('.fold-ribbon-primary')) === 1 &&
    (await session.count('.fold-ribbon-hinge')) === 1 &&
    (await session.count('.fold-ribbon-companion')) === 1);
  await session.click('.fold-more');
  await session.waitForSelector('.fold-command-library');
  if (ribbonWildEnabled) {
    check('book fold command library exposes all five possibility tools',
      (await session.count('.fold-command-library [data-command-id^="wild."]')) === 5);
    await session.click('.fold-command-library [data-command-id="wild.intent-horizon"]');
    await session.waitForSelector('.wild-studio[data-shell="fold-book"][data-wild-capability="intent"]');
    check('possibility layer respects the unfolded book posture',
      (await session.isVisible('.wild-studio[data-shell="fold-book"]')));
    await session.click('button[aria-label="Close possibility layer"]');
  } else {
    check('disabled ribbon-wild stays absent from foldable command libraries',
      (await session.count('.fold-command-library [data-command-id^="wild."]')) === 0);
  }

  await session.goto(`${documentPath}?marks-posture=fold-laptop`);
  await session.waitForSelector('.fold-ribbon-horizontal', { timeout: 20_000 });
  check('laptop fold exposes an independent lower touch shelf',
    (await session.count('.fold-ribbon-primary')) === 1 &&
    (await session.count('.fold-ribbon-companion')) === 1);
  if (ribbonWildEnabled) {
    await session.click('.fold-more');
    await session.waitForSelector('.fold-command-library');
    await session.click('.fold-command-library [data-command-id="wild.consequence-lanes"]');
    await session.waitForSelector('.wild-studio[data-shell="fold-laptop"][data-wild-capability="consequences"]');
    check('possibility layer respects the unfolded laptop posture',
      (await session.count('.wild-studio[data-shell="fold-laptop"] .consequence-lanes [data-lane]')) === 5);
    await session.click('button[aria-label="Close possibility layer"]');
  }

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
  await session.evaluate(() => {
    const review = [...document.querySelectorAll('.phone-nav > button')]
      .find((button) => button.textContent?.trim() === 'Review');
    if (!(review instanceof HTMLButtonElement)) throw new Error('phone Review command not found');
    review.click();
  });
  await session.waitForSelector('.phone-sheet[aria-label="Document intelligence commands"]');
  if (ribbonWildEnabled) {
    check('phone review sheet exposes all five possibility tools',
      (await session.count('.phone-sheet [data-command-id^="wild."]')) === 5);
    await session.click('.phone-sheet [data-command-id="wild.context-half-life"]');
    await session.waitForSelector('.wild-studio[data-shell="phone"][data-wild-capability="half-life"]');
    check('possibility layer becomes a focused phone sheet',
      (await session.isVisible('.wild-studio[data-shell="phone"]')));
  } else {
    check('disabled ribbon-wild stays absent from the phone review sheet',
      (await session.count('.phone-sheet [data-command-id^="wild."]')) === 0);
    const wildAssets = await session.evaluate(() => performance.getEntriesByType('resource')
      .map((entry) => entry.name)
      .filter((name) => /\/assets\/(?:WildStudio|WildTelemetry|wild|observations)-/.test(name)));
    check('disabled ribbon-wild requests no lazy code or style assets',
      wildAssets.length === 0,
      JSON.stringify(wildAssets));
  }
}

export const SURFACE_CHECK_NAMES = [
  'opening shell does not stay up',
  'surface tier is explicit',
  'scrolling document bodies stay opaque',
  'reduced glass removes shader and blur',
  'reduced motion stops material transitions',
  'document renders blocks',
  'desktop ribbon is registry-driven',
  'ribbon KeyTips are keyboard discoverable',
  'local agent privacy disclosure is truthful',
  'agent visibly raises the relevant ribbon task',
  'agent command changes to rendered-only mode',
  'rendered-only ribbon removes text mutation controls',
  'agent can restore split mode through the same command runtime',
  'ribbon-wild build flag matches the expected state',
  'disabled ribbon-wild exposes no commands, agent tools, or surfaces',
  'in-page agent can visibly operate the possibility ribbon layer',
  'wild studio exposes all five integrated capabilities',
  'consequence lanes expose all product-effect planes',
  'context half-life discovers live source claims',
  'causal lightpath seals actual command receipts',
  'source-changing agent work paints a live causal lightpath',
  'successful source commands capture a reversible counterfactual',
  'selection toolbar preserves ribbon tab hit targets',
  'voice input is honest',
  'select-all in the preview stays inside the document',
  'preview right-click opens the marks menu',
  'theme toggles',
  'connectivity state is honest',
  'WebGL context loss removes canvases',
  'book fold uses two hinge-safe ribbon segments',
  'disabled ribbon-wild stays absent from foldable command libraries',
  'book fold command library exposes all five possibility tools',
  'possibility layer respects the unfolded book posture',
  'laptop fold exposes an independent lower touch shelf',
  'possibility layer respects the unfolded laptop posture',
  'phone uses a focused composer instead of desktop ribbon',
  'phone page sheet applies phone-confirmation eligibility',
  'disabled ribbon-wild stays absent from the phone review sheet',
  'disabled ribbon-wild requests no lazy code or style assets',
  'phone review sheet exposes all five possibility tools',
  'possibility layer becomes a focused phone sheet',
];
