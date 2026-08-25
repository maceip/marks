/**
 * Portable browser-surface checks that every driver can run.
 *
 * Deep collaboration and REST cases stay in scripts/ci-service-ui.mjs
 * (Playwright against marks-server). This suite covers the portable glass:
 * create a doc, preview, select-all, context menu, voice, theme, and offline.
 */

import { parseBooleanFlag } from '../env.mjs';

const EXPECT_AGENT_CHAT = parseBooleanFlag(process.env.MARKS_EXPECT_AGENT_CHAT);
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

async function openDesktopWildSurface(session, commandId) {
  await session.evaluate(() => {
    const all = document.querySelector('.ribbon-profile-toggle');
    if (all instanceof HTMLButtonElement && all.getAttribute('aria-pressed') !== 'true') all.click();
    const review = [...document.querySelectorAll('.ribbon-tab')]
      .find((button) => button.textContent?.trim() === 'Review');
    if (!(review instanceof HTMLButtonElement)) throw new Error('Review ribbon tab not found');
    review.click();
  });
  const selector = `.ribbon-body [data-command-id="${commandId}"]`;
  await session.waitForSelector(selector, { timeout: 10_000 });
  await session.click(selector);
}

async function waitForAbsent(session, selector, { timeout = 10_000 } = {}) {
  const deadline = Date.now() + timeout;
  while (await session.count(selector)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${selector} to disappear`);
    }
    await session.wait(50);
  }
}

async function createDocument(session) {
  await session.goto('/');
  const dataMode = await session.evaluate(() => document.documentElement.dataset.marksMode ?? 'local');
  if (dataMode === 'service') {
    // Anonymous service entry creates its editable public marketing page in
    // the background. Do not race that creation by clicking a Home action
    // while caller discovery is still resolving.
    await session.waitForSelector('.app[data-marketing="true"] .cm-content', { timeout: 30_000 });
    return;
  }
  await session.waitForSelector(
    '.new-doc .button.primary, .home-actions .button.primary',
    { timeout: 15_000 },
  );
  if (await session.isVisible('.new-doc .button.primary')) {
    await session.click('.new-doc .button.primary');
    return;
  }
  await session.click('.home-actions .button.primary');
}

async function measureWorkspacePanes(session) {
  return session.evaluate(() => {
    const workspace = document.querySelector('.workspace');
    const editor = document.querySelector('.editor-pane');
    const preview = document.querySelector('.preview-pane');
    const wr = workspace?.getBoundingClientRect();
    const er = editor?.getBoundingClientRect();
    const pr = preview?.getBoundingClientRect();
    const visible = (node, rect) => Boolean(node) && !!rect && rect.width > 8 && rect.height > 8
      && getComputedStyle(node).display !== 'none';
    return {
      ghost: Boolean(document.querySelector('.workspace.phone-ghost, .preview-ghost')),
      mode: workspace ? [...workspace.classList].find((name) => name.startsWith('mode-')) ?? '' : '',
      shell: document.documentElement.dataset.shell ?? '',
      workspaceW: wr ? Math.round(wr.width) : 0,
      workspaceH: wr ? Math.round(wr.height) : 0,
      editorW: er ? Math.round(er.width) : 0,
      editorH: er ? Math.round(er.height) : 0,
      previewW: pr ? Math.round(pr.width) : 0,
      previewH: pr ? Math.round(pr.height) : 0,
      editorLeft: er ? Math.round(er.left) : 0,
      previewLeft: pr ? Math.round(pr.left) : 0,
      editorTop: er ? Math.round(er.top) : 0,
      previewTop: pr ? Math.round(pr.top) : 0,
      editorVisible: visible(editor, er),
      previewVisible: visible(preview, pr),
    };
  });
}

export async function runSurface(session, { check }) {
  await createDocument(session);
  await session.waitForSelector('.cm-content', { timeout: 20_000 });
  await session.wait(2000);

  check('opening shell does not stay up', (await session.count('.opening-shell')) === 0);

  const importRibbon = await session.evaluate(() => {
    const selected = document.querySelector('.ribbon-tab[aria-selected="true"]');
    const topLevel = [...document.querySelectorAll('.ribbon-tab')]
      .map((tab) => tab.textContent?.trim() ?? '');
    const expected = [
      'import.notes-app',
      'import.meeting',
      'import.github-readme',
      'import.url',
      'document.import',
    ];
    return {
      selected: selected?.textContent?.trim() ?? '',
      topLevel,
      commands: expected.map((id) => Boolean(document.querySelector(`[data-command-id="${id}"]`))),
    };
  });
  check(
    'desktop opens on the complete Start from template ribbon',
    importRibbon.selected === 'Start from template' && importRibbon.commands.every(Boolean),
    JSON.stringify(importRibbon),
  );
  const desktopDataMode = await session.evaluate(() => document.documentElement.dataset.marksMode ?? 'local');
  check(
    'anonymous desktop puts Log In second',
    desktopDataMode !== 'service' || (
      importRibbon.topLevel[0] === 'Start from template' &&
      importRibbon.topLevel[1] === 'Log In'
    ),
    JSON.stringify(importRibbon.topLevel),
  );
  if (desktopDataMode === 'service') {
    await session.evaluate(() => {
      const login = [...document.querySelectorAll('.ribbon-tab')]
        .find((tab) => tab.textContent?.trim() === 'Log In');
      if (!(login instanceof HTMLButtonElement)) throw new Error('Log In ribbon control not found');
      login.click();
    });
    await session.waitForSelector('[role="dialog"] .qr-mark', { timeout: 10_000 });
    const desktopLogin = await session.evaluate(() => ({
      title: document.querySelector('[role="dialog"] h2')?.textContent?.trim() ?? '',
      scan: document.querySelector('[role="dialog"]')?.textContent?.includes('Scan with your phone') ?? false,
    }));
    check(
      'desktop Log In opens the phone QR flow',
      desktopLogin.title === 'Log In' && desktopLogin.scan,
      JSON.stringify(desktopLogin),
    );
    await session.click('[role="dialog"] button[aria-label="Close"]');
    await waitForAbsent(session, '[role="dialog"]');
  }

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
    (await session.count('.ribbon-body [data-command-id="import.url"]')) === 1 &&
    (await session.count('.quick-access [data-command-id="format.bold"]')) >= 1);

  await session.click('.ribbon-tab');
  await session.press('Alt');
  await session.wait(100);
  check('ribbon KeyTips are keyboard discoverable', (await session.count('.ribbon-keytip')) >= 2);
  await session.press('Escape');

  const agentChatState = await session.evaluate(() =>
    document.documentElement.dataset.marksAgentChat ?? 'missing');
  const agentChatEnabled = agentChatState === 'enabled';
  check('agent-chat build flag matches the expected state',
    agentChatEnabled === EXPECT_AGENT_CHAT,
    `expected=${EXPECT_AGENT_CHAT ? 'enabled' : 'disabled'} actual=${agentChatState}`);

  if (agentChatEnabled) {
    await session.click('.agent-orb');
    const localPrivacy = await session.textContent('.agent-privacy');
    check('local agent privacy disclosure is truthful',
      String(localPrivacy).includes('do not leave this browser'), String(localPrivacy));
    check('enabled agent chat exposes the guarded command bridge',
      await session.evaluate(() => Boolean(window.marksRibbon)));
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
  } else {
    const disabledAgentState = await session.evaluate(() => {
      const resourceNames = performance.getEntriesByType('resource').map((entry) => entry.name);
      return {
        ui: document.querySelectorAll('.agent-pill, .agent-chat-host').length,
        bridge: Boolean(window.marksRibbon),
        choreography: document.querySelectorAll('.agent-raised, [data-agent-state]').length,
        network: resourceNames.filter((name) => /\/v1\/agent(?:\/|\?|$)/u.test(name)),
        assets: resourceNames.filter((name) =>
          /\/assets\/[^/?]*(?:AgentPill|AgentChatPill|agent-chat|webmcp|gateway|run-store)[^/?]*\.(?:css|js)(?:\?|$)/iu.test(name)),
      };
    });
    check('disabled agent chat exposes no UI, command bridge, or ribbon choreography',
      disabledAgentState.ui === 0 &&
      disabledAgentState.bridge === false &&
      disabledAgentState.choreography === 0,
      JSON.stringify(disabledAgentState));
    check('disabled agent chat makes no agent network or lazy-asset requests',
      disabledAgentState.network.length === 0 && disabledAgentState.assets.length === 0,
      JSON.stringify(disabledAgentState));
  }

  await session.click('.preview-pane');
  await session.wait(100);
  const inspectState = await session.evaluate(() => ({
    task: document.querySelector('.ribbon-body')?.getAttribute('data-ribbon-task'),
    bold: document.querySelectorAll('.ribbon-body [data-command-id="format.bold"]').length,
    editor: Boolean(document.querySelector('.editor-pane')),
    preview: Boolean(document.querySelector('.preview-pane')),
  }));
  check('desktop split inspects the rendered pane from a preview click',
    inspectState.task === 'inspect' && inspectState.bold === 0 && inspectState.editor && inspectState.preview,
    JSON.stringify(inspectState));
  await session.click('.cm-content');
  await session.wait(100);
  const composeState = await session.evaluate(() => ({
    task: document.querySelector('.ribbon-body')?.getAttribute('data-ribbon-task'),
    bold: document.querySelectorAll('.ribbon-body [data-command-id="format.bold"]').length,
  }));
  check('desktop split restores compose commands from an editor click',
    composeState.task === 'compose' && composeState.bold >= 1,
    JSON.stringify(composeState));

  const ribbonWildState = await session.evaluate(() => document.documentElement.dataset.marksRibbonWild ?? 'missing');
  const ribbonWildEnabled = ribbonWildState === 'enabled';
  check('ribbon-wild build flag matches the expected state',
    ribbonWildEnabled === EXPECT_RIBBON_WILD,
    `expected=${EXPECT_RIBBON_WILD ? 'enabled' : 'disabled'} actual=${ribbonWildState}`);

  if (ribbonWildEnabled) {
    let horizonRunId = null;
    if (agentChatEnabled) horizonRunId = await proposeFromInPageAgent(session, 'wild.intent-horizon');
    else await openDesktopWildSurface(session, 'wild.intent-horizon');
    await session.waitForSelector('.wild-studio[data-wild-capability="intent"]', { timeout: 10_000 });
    if (agentChatEnabled) {
      const horizonReceipt = await session.evaluate((runId) => {
        const receipt = window.marksRibbon?.state().receipts.find((item) => item.id === runId);
        return receipt ? { source: receipt.source, status: receipt.status } : null;
      }, horizonRunId);
      check('in-page agent can visibly operate the possibility ribbon layer',
        typeof horizonRunId === 'string' && horizonReceipt?.source === 'agent' && horizonReceipt?.status === 'succeeded',
        JSON.stringify(horizonReceipt));
    }
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
    let boldRunId = null;
    if (agentChatEnabled) boldRunId = await proposeFromInPageAgent(session, 'format.bold');
    else await session.click('.quick-access [data-command-id="format.bold"]');
    await session.waitForSelector('.causal-lightpath[data-command-id="format.bold"][data-command-phase="finished"]', { timeout: 10_000 });
    if (agentChatEnabled) {
      check('source-changing agent work paints a live causal lightpath',
        typeof boldRunId === 'string' && (await session.isVisible('.causal-lightpath')));
    }

    if (agentChatEnabled) await proposeFromInPageAgent(session, 'wild.counterfactual-shelf');
    else await openDesktopWildSurface(session, 'wild.counterfactual-shelf');
    await session.waitForSelector('.wild-studio[data-wild-capability="counterfactuals"] .shelf-cards > button', { timeout: 10_000 });
    check('successful source commands capture a reversible counterfactual',
      (await session.count('.shelf-cards > button')) >= 1 &&
      (await session.count('.counterfactual-preview .safe')) === 1);
    await session.click('button[aria-label="Close possibility layer"]');
  } else {
    const disabledState = await session.evaluate(() => ({
      dom: document.querySelectorAll('.wild-studio, .causal-lightpath').length,
      tools: window.marksRibbon?.listTools().filter((tool) => tool.commandId.startsWith('wild.')).length ?? 0,
      commands: document.querySelectorAll('[data-command-id^="wild."]').length,
    }));
    check('disabled ribbon-wild exposes no commands, agent tools, or surfaces',
      disabledState.dom === 0 && disabledState.tools === 0 && disabledState.commands === 0,
      JSON.stringify(disabledState));
  }

  // The wild receipt is an intentional transient button over the top chrome.
  // Let it settle out before isolating the mini-toolbar's hit-target contract.
  await waitForAbsent(session, '.causal-lightpath');
  const homeTabOwnsHitTarget = await session.evaluate(() => {
    const home = [...document.querySelectorAll('.ribbon-tab')]
      .find((tab) => tab.textContent?.trim() === 'Home');
    if (!(home instanceof HTMLButtonElement)) return false;
    const rect = home.getBoundingClientRect();
    return document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) === home;
  });
  check('selection toolbar preserves ribbon tab hit targets', homeTabOwnsHitTarget);

  await session.evaluate(() => {
    const importTab = [...document.querySelectorAll('.ribbon-tab')]
      .find((tab) => tab.textContent?.trim() === 'Start from template');
    if (!(importTab instanceof HTMLButtonElement)) throw new Error('Start from template ribbon tab not found');
    importTab.click();
  });
  await session.wait(100);
  const importUrlOwnsHitTarget = await session.evaluate(() => {
    const button = document.querySelector('[data-command-id="import.url"]');
    if (!(button instanceof HTMLButtonElement)) return false;
    const rect = button.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return hit === button || hit?.closest('[data-command-id="import.url"]') === button;
  });
  check('floating document actions preserve template command hit targets', importUrlOwnsHitTarget);

  await session.evaluate(() => {
    const home = [...document.querySelectorAll('.ribbon-tab')]
      .find((tab) => tab.textContent?.trim() === 'Home');
    if (!(home instanceof HTMLButtonElement)) throw new Error('Home ribbon tab not found');
    home.click();
  });
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

  const contextLossProbe = await session.evaluate(() => {
    const canvas = document.querySelector('.surface-material-canvas[data-ready="true"]');
    if (!canvas) return { applicable: false };
    canvas.setAttribute('data-context-loss-probe', 'true');
    const initialTier = document.documentElement.dataset.surfaceTier;
    const initialEngine = document.documentElement.dataset.surfaceEngine;
    canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    return { applicable: true, initialTier, initialEngine };
  });
  await session.wait(350);
  const contextLoss = await session.evaluate((probe) => {
    const canvases = [...document.querySelectorAll('.surface-material-canvas')];
    const failed = document.querySelector('[data-context-loss-probe="true"]');
    return {
      ...probe,
      tier: document.documentElement.dataset.surfaceTier,
      engine: document.documentElement.dataset.surfaceEngine,
      failedReady: failed?.hasAttribute('data-ready') ?? null,
      canvases: canvases.length,
      visibleCanvases: canvases.filter((node) => getComputedStyle(node).display !== 'none').length,
    };
  }, contextLossProbe);
  check(
    'GPU context loss disables the failed canvas and selects a fallback',
    !contextLoss.applicable || (
      contextLoss.failedReady === false &&
      (contextLoss.engine !== contextLoss.initialEngine || contextLoss.tier !== contextLoss.initialTier)
    ),
    JSON.stringify(contextLoss),
  );

  const documentPath = await session.evaluate(() => location.pathname);
  await session.goto(`${documentPath}?marks-posture=fold-book`);
  await session.waitForSelector('.app-rail', { timeout: 20_000 });
  const bookChrome = await session.evaluate(() => {
    const rail = document.querySelector('.app-rail');
    const ribbon = document.querySelector('.app-ribbon .ribbon-body');
    const header = document.querySelector('.app-ribbon');
    return {
      commands: document.querySelectorAll('.app-rail [data-command-id]').length,
      ribbons: document.querySelectorAll('.ribbon-body').length,
      foldRibbons: document.querySelectorAll('.fold-ribbon').length,
      railWidth: rail ? Math.round(rail.getBoundingClientRect().width) : 0,
      ribbonWidth: ribbon instanceof HTMLElement ? Math.round(ribbon.getBoundingClientRect().width) : 0,
      headerWidth: header instanceof HTMLElement ? Math.round(header.getBoundingClientRect().width) : 0,
    };
  });
  check('book fold uses a view rail and a full-width ribbon',
    bookChrome.commands === 3 && bookChrome.ribbons === 1 && bookChrome.foldRibbons === 0,
    JSON.stringify(bookChrome));
  check('unfolded app rail is thinner than the Material 3 80dp rail',
    bookChrome.railWidth > 0 && bookChrome.railWidth <= 72,
    String(bookChrome.railWidth));
  check('book fold ribbon spans its chrome container',
    bookChrome.ribbonWidth > 0 && Math.abs(bookChrome.ribbonWidth - bookChrome.headerWidth) <= 2,
    JSON.stringify(bookChrome));
  await session.click('.app-rail [data-command-id="view.split"]');
  await session.wait(200);
  const bookSplit = await measureWorkspacePanes(session);
  check('book fold split does not use the phone ghost overlay',
    bookSplit.ghost === false && bookSplit.shell === 'fold-book',
    JSON.stringify(bookSplit));
  check('book fold split is a real two-pane hinge canvas',
    bookSplit.mode === 'mode-split' &&
    bookSplit.editorVisible &&
    bookSplit.previewVisible &&
    bookSplit.editorW > 80 &&
    bookSplit.previewW > 80 &&
    Math.abs(bookSplit.editorTop - bookSplit.previewTop) < 24 &&
    bookSplit.previewLeft >= bookSplit.editorLeft + bookSplit.editorW - 8,
    JSON.stringify(bookSplit));

  await session.evaluate(() => {
    const home = [...document.querySelectorAll('.ribbon-tab')]
      .find((tab) => tab.textContent?.trim() === 'Home');
    if (!(home instanceof HTMLButtonElement)) throw new Error('Home ribbon tab not found');
    home.click();
  });
  await session.wait(100);
  await session.click('.preview-pane');
  await session.wait(100);
  check('book fold split keeps compose until the app rail changes the view',
    (await session.evaluate(() => document.querySelector('.ribbon-body')?.getAttribute('data-ribbon-task'))) === 'compose' &&
    (await session.count('.ribbon-body [data-command-id="format.bold"]')) >= 1);
  await session.click('.app-rail [data-command-id="view.preview"]');
  await session.wait(200);
  check('book fold preview rail shows inspect commands',
    (await session.evaluate(() => document.querySelector('.ribbon-body')?.getAttribute('data-ribbon-task'))) === 'inspect' &&
    (await session.count('.ribbon-body [data-command-id="format.bold"]')) === 0);
  await session.click('.app-rail [data-command-id="view.split"]');
  await session.wait(200);

  await session.evaluate(() => {
    const all = document.querySelector('.ribbon-profile-toggle');
    if (all instanceof HTMLButtonElement && all.getAttribute('aria-pressed') !== 'true') all.click();
    const review = [...document.querySelectorAll('.ribbon-tab')]
      .find((button) => button.textContent?.trim() === 'Review');
    if (!(review instanceof HTMLButtonElement)) throw new Error('Review ribbon tab not found');
    review.click();
  });
  await session.wait(150);
  if (ribbonWildEnabled) {
    check('book fold command library exposes all five possibility tools',
      (await session.count('.ribbon-body [data-command-id^="wild."]')) === 5);
    await session.click('.ribbon-body [data-command-id="wild.intent-horizon"]');
    await session.waitForSelector('.wild-studio[data-shell="fold-book"][data-wild-capability="intent"]');
    check('possibility layer respects the unfolded book posture',
      (await session.isVisible('.wild-studio[data-shell="fold-book"]')));
    await session.click('button[aria-label="Close possibility layer"]');
  } else {
    check('disabled ribbon-wild stays absent from foldable command libraries',
      (await session.count('.ribbon-body [data-command-id^="wild."]')) === 0);
  }

  await session.goto(`${documentPath}?marks-posture=fold-laptop`);
  await session.waitForSelector('.app-rail', { timeout: 20_000 });
  check('laptop fold uses a view rail and a full-width ribbon',
    (await session.count('.app-rail [data-command-id]')) === 3 &&
    (await session.count('.ribbon-body')) === 1 &&
    (await session.count('.fold-ribbon')) === 0);
  await session.click('.app-rail [data-command-id="view.split"]');
  await session.wait(200);
  const laptopSplit = await measureWorkspacePanes(session);
  check('laptop fold split does not use the phone ghost overlay',
    laptopSplit.ghost === false && laptopSplit.shell === 'fold-laptop',
    JSON.stringify(laptopSplit));
  check('laptop fold split is a real stacked hinge canvas',
    laptopSplit.mode === 'mode-split' &&
    laptopSplit.editorVisible &&
    laptopSplit.previewVisible &&
    laptopSplit.editorH > 80 &&
    laptopSplit.previewH > 80 &&
    Math.abs(laptopSplit.editorLeft - laptopSplit.previewLeft) < 24 &&
    laptopSplit.previewTop >= laptopSplit.editorTop + laptopSplit.editorH - 8,
    JSON.stringify(laptopSplit));
  if (ribbonWildEnabled) {
    await session.evaluate(() => {
      const all = document.querySelector('.ribbon-profile-toggle');
      if (all instanceof HTMLButtonElement && all.getAttribute('aria-pressed') !== 'true') all.click();
      const review = [...document.querySelectorAll('.ribbon-tab')]
        .find((button) => button.textContent?.trim() === 'Review');
      if (!(review instanceof HTMLButtonElement)) throw new Error('Review ribbon tab not found');
      review.click();
    });
    await session.wait(150);
    await session.click('.ribbon-body [data-command-id="wild.consequence-lanes"]');
    await session.waitForSelector('.wild-studio[data-shell="fold-laptop"][data-wild-capability="consequences"]');
    check('possibility layer respects the unfolded laptop posture',
      (await session.count('.wild-studio[data-shell="fold-laptop"] .consequence-lanes [data-lane]')) === 5);
    await session.click('button[aria-label="Close possibility layer"]');
  }

  await session.goto(`${documentPath}?marks-posture=phone`);
  await session.waitForSelector('.phone-ribbon', { timeout: 20_000 });
  await session.waitForSelector('.phone-ribbon-deck[aria-label="Start from template commands"]', { timeout: 20_000 });
  check('phone uses a focused composer instead of desktop ribbon',
    (await session.count('.phone-ribbon')) === 1 && (await session.count('.ribbon-body')) === 0);
  const phoneDataMode = await session.evaluate(() => document.documentElement.dataset.marksMode ?? 'local');
  if (phoneDataMode === 'service') {
    await session.waitForSelector(
      '.app[data-marketing="true"] .workspace.mode-preview .marks-preview .marks-block',
      { timeout: 20_000 },
    );
  }
  const phoneImport = await session.evaluate(() => ({
    dataMode: document.documentElement.dataset.marksMode ?? 'local',
    marketing: document.querySelector('.app')?.getAttribute('data-marketing') ?? '',
    mode: [...(document.querySelector('.workspace')?.classList ?? [])]
      .find((name) => name.startsWith('mode-')) ?? '',
    selected: document.querySelector('.phone-ribbon-tabs [role="tab"][aria-selected="true"]')?.textContent?.trim() ?? '',
    topLevel: [...document.querySelectorAll('.phone-ribbon-tabs [role="tab"]')]
      .map((tab) => tab.textContent?.trim() ?? ''),
    editor: Boolean(document.querySelector('.editor-pane')),
    renderedBlocks: document.querySelectorAll('.preview-pane .marks-preview .marks-block').length,
    commands: [
      'import.notes-app',
      'import.meeting',
      'import.github-readme',
      'import.url',
      'document.import',
    ].map((id) => Boolean(document.querySelector(`.phone-ribbon [data-command-id="${id}"]`))),
  }));
  check(
    'phone opens on the complete Start from template ribbon',
    phoneImport.selected === 'Start from template' && phoneImport.commands.every(Boolean),
    JSON.stringify(phoneImport),
  );
  check(
    'anonymous phone puts Log In second',
    phoneImport.dataMode !== 'service' || (
      phoneImport.topLevel[0] === 'Start from template' &&
      phoneImport.topLevel[1] === 'Log In'
    ),
    JSON.stringify(phoneImport.topLevel),
  );
  check(
    'service phone public marketing document opens in Preview with Start from template selected',
    phoneImport.dataMode !== 'service' || (
      phoneImport.marketing === 'true' &&
      phoneImport.mode === 'mode-preview' &&
      phoneImport.selected === 'Start from template' &&
      !phoneImport.editor &&
      phoneImport.renderedBlocks >= 1
    ),
    JSON.stringify(phoneImport),
  );
  await session.evaluate(() => {
    const view = [...document.querySelectorAll('.phone-ribbon-tabs [role="tab"]')]
      .find((button) => button.textContent?.trim() === 'View');
    if (!(view instanceof HTMLButtonElement)) throw new Error('phone View tab not found');
    view.click();
  });
  await session.waitForSelector(
    '.phone-ribbon-deck[aria-label="View commands"] [data-command-id="view.editor"]',
    { timeout: 10_000 },
  );
  await session.click('.phone-ribbon [data-command-id="view.editor"]');
  await session.waitForSelector(
    '.workspace.mode-edit.phone-ghost .editor-pane .cm-content',
    { timeout: 20_000 },
  );
  await session.waitForSelector(
    '.workspace.mode-edit.phone-ghost .preview-pane.preview-ghost .marks-preview .marks-block',
    { timeout: 20_000 },
  );
  const phoneGhost = await session.evaluate(() => {
    const root = document.querySelector('.workspace');
    const preview = document.querySelector('.preview-pane');
    const editor = document.querySelector('.editor-pane');
    if (!(root instanceof HTMLElement) || !(preview instanceof HTMLElement) || !(editor instanceof HTMLElement)) {
      return null;
    }
    const rect = root.getBoundingClientRect();
    const y = rect.top + Math.min(96, Math.max(24, rect.height / 3));
    const leftHit = document.elementFromPoint(rect.left + rect.width * 0.25, y);
    const rightHit = document.elementFromPoint(rect.left + rect.width * 0.75, y);
    const styles = getComputedStyle(preview);
    const editorBox = editor.getBoundingClientRect();
    const previewBox = preview.getBoundingClientRect();
    return {
      ghost: root.classList.contains('phone-ghost'),
      shift: root.dataset.ghostShift ?? '',
      editor: Boolean(document.querySelector('.editor-pane .cm-content')),
      previewGhost: preview.classList.contains('preview-ghost'),
      clip: `${styles.clipPath} ${styles.webkitClipPath}`,
      opacity: Number(styles.opacity),
      pointerEvents: styles.pointerEvents,
      editorFullWidth: Math.abs(editorBox.width - rect.width) <= 2,
      previewFullMeasure: Math.abs(previewBox.width - rect.width) <= 2,
      leftHitEditor: Boolean(leftHit?.closest('.editor-pane')),
      rightHitEditor: Boolean(rightHit?.closest('.editor-pane')),
      rightHitPreview: Boolean(rightHit?.closest('.preview-pane')),
    };
  });
  check('phone write keeps a full-width editor under a right-hand ghost preview',
    Boolean(
      phoneGhost?.ghost &&
      phoneGhost.editor &&
      phoneGhost.previewGhost &&
      phoneGhost.shift === 'start' &&
      phoneGhost.editorFullWidth &&
      phoneGhost.previewFullMeasure,
    ),
    JSON.stringify(phoneGhost));
  check('phone ghost viewfinder is clipped and pointer-transparent',
    Boolean(
      phoneGhost &&
      phoneGhost.clip.includes('50%') &&
      phoneGhost.opacity > 0 &&
      phoneGhost.opacity < 1 &&
      phoneGhost.pointerEvents === 'none' &&
      phoneGhost.leftHitEditor &&
      phoneGhost.rightHitEditor &&
      !phoneGhost.rightHitPreview,
    ),
    JSON.stringify(phoneGhost));
  const ghostPan = await session.evaluate(() => {
    const root = document.querySelector('.workspace.phone-ghost');
    if (!(root instanceof HTMLElement)) return { ok: false };
    const rect = root.getBoundingClientRect();
    const y = rect.top + Math.min(120, Math.max(40, rect.height / 2));
    const fire = (type, id, x) => {
      root.dispatchEvent(new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        pointerId: id,
        pointerType: 'touch',
        isPrimary: id === 1,
        clientX: x,
        clientY: y,
        buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : 1,
      }));
    };
    const x1 = rect.left + rect.width * 0.62;
    const x2 = rect.left + rect.width * 0.78;
    fire('pointerdown', 1, x1);
    fire('pointerdown', 2, x2);
    const draggingAfterDown = root.classList.contains('phone-ghost-dragging');
    fire('pointermove', 1, x1 - rect.width * 0.5);
    fire('pointermove', 2, x2 - rect.width * 0.5);
    fire('pointerup', 1, x1 - rect.width * 0.5);
    fire('pointerup', 2, x2 - rect.width * 0.5);
    return {
      ok: true,
      bound: root.dataset.ghostBound ?? '',
      shift: root.dataset.ghostShift ?? '',
      translate: root.style.getPropertyValue('--phone-ghost-shift'),
      draggingAfterDown,
    };
  });
  check('phone two-finger pan snaps the ghost to the other page half',
    ghostPan.ok && ghostPan.bound === 'true' && ghostPan.draggingAfterDown && ghostPan.shift === 'end' && ghostPan.translate === '0%',
    JSON.stringify(ghostPan));
  await session.evaluate(() => {
    const view = [...document.querySelectorAll('.phone-ribbon-tabs [role="tab"]')]
      .find((button) => button.textContent?.trim() === 'View');
    if (!(view instanceof HTMLButtonElement)) throw new Error('phone View tab not found');
    view.click();
  });
  await session.waitForSelector(
    '.phone-ribbon-deck[aria-label="View commands"] [data-command-id="view.preview"]',
    { timeout: 10_000 },
  );
  await session.click('.phone-ribbon [data-command-id="view.preview"]');
  await session.waitForSelector(
    '.workspace.mode-preview .preview-pane .marks-preview .marks-block',
    { timeout: 10_000 },
  );
  check('phone preview mode removes the ghost overlay',
    (await session.count('.workspace.phone-ghost, .preview-ghost')) === 0 &&
    (await session.isVisible('.preview-pane')) &&
    !(await session.isVisible('.editor-pane')));
  await session.click('.phone-ribbon [data-command-id="view.editor"]');
  await session.waitForSelector(
    '.workspace.mode-edit.phone-ghost .editor-pane .cm-content',
    { timeout: 10_000 },
  );
  await session.evaluate(() => {
    const more = [...document.querySelectorAll('.phone-ribbon-tabs [role="tab"]')]
      .find((button) => button.textContent?.trim() === 'More');
    if (!(more instanceof HTMLButtonElement)) throw new Error('phone More tab not found');
    more.click();
  });
  await session.waitForSelector('.phone-ribbon-deck[aria-label="More commands"]', { timeout: 10_000 });
  const pairingCount = await session.count('.phone-ribbon [data-command-id="identity.pairing"]');
  const buriedLoginCount = await session.count('.phone-ribbon-deck[aria-label="More commands"] [data-command-id="identity.keep"]');
  check('phone More does not duplicate anonymous login',
    pairingCount === 0 && buriedLoginCount === 0,
    `${phoneDataMode}: ${pairingCount}`);
  if (phoneDataMode === 'service') {
    await session.evaluate(() => {
      const login = [...document.querySelectorAll('.phone-ribbon-tabs [role="tab"]')]
        .find((button) => button.textContent?.trim() === 'Log In');
      if (!(login instanceof HTMLButtonElement)) throw new Error('phone Log In control not found');
      login.click();
    });
    await session.waitForSelector('[role="dialog"]', { timeout: 10_000 });
    const mobileLogin = await session.evaluate(() => ({
      laptop: document.querySelector('[role="dialog"]')?.textContent?.includes('Open this page on a laptop') ?? false,
      soloDisclosure: document.querySelectorAll('[role="dialog"] .keep-solo-disclosure').length,
      soloButton: [...document.querySelectorAll('[role="dialog"] button')]
        .some((button) => /phone only|only this phone/i.test(button.textContent ?? '')),
    }));
    check(
      'phone Log In is laptop-first with no phone-only registration',
      mobileLogin.laptop && mobileLogin.soloDisclosure === 0 && !mobileLogin.soloButton,
      JSON.stringify(mobileLogin),
    );
    await session.click('[role="dialog"] button[aria-label="Close"]');
    await waitForAbsent(session, '[role="dialog"]');
  }
  await session.evaluate(() => {
    const review = [...document.querySelectorAll('.phone-ribbon-tabs [role="tab"]')]
      .find((button) => button.textContent?.trim() === 'Review');
    if (!(review instanceof HTMLButtonElement)) throw new Error('phone Review tab not found');
    review.click();
  });
  await session.waitForSelector('.phone-ribbon-deck[aria-label="Review commands"]');
  if (ribbonWildEnabled) {
    check('phone Review ribbon exposes all five possibility tools',
      (await session.count('.phone-ribbon [data-command-id^="wild."]')) === 5);
    await session.click('.phone-ribbon [data-command-id="wild.context-half-life"]');
    await session.waitForSelector('.wild-studio[data-shell="phone"][data-wild-capability="half-life"]');
    check('possibility layer becomes a focused phone surface',
      (await session.isVisible('.wild-studio[data-shell="phone"]')));
  } else {
    check('disabled ribbon-wild stays absent from the phone Review ribbon',
      (await session.count('.phone-ribbon [data-command-id^="wild."]')) === 0);
    const wildAssets = await session.evaluate(() => performance.getEntriesByType('resource')
      .map((entry) => entry.name)
      .filter((name) => /\/assets\/(?:WildStudio|WildTelemetry|wild|observations)-/.test(name)));
    check('disabled ribbon-wild requests no lazy code or style assets',
      wildAssets.length === 0,
      JSON.stringify(wildAssets));
  }

  await session.goto('/design-system');
  await session.waitForSelector('.design-system', { timeout: 20_000 });
  if (agentChatEnabled) {
    await session.waitForSelector('.agent-chat-host', { timeout: 10_000 });
  }
  const designSystemAgentState = await session.evaluate(() => ({
    host: document.querySelectorAll('.agent-chat-host').length,
    control: document.querySelectorAll('[aria-label="Agent-chat pattern state"]').length,
    assets: performance.getEntriesByType('resource')
      .map((entry) => entry.name)
      .filter((name) => /\/assets\/[^/?]*(?:AgentChatPill|agent-chat)[^/?]*\.(?:css|js)(?:\?|$)/iu.test(name)),
  }));
  check('design-system agent chat catalog follows the product flag',
    agentChatEnabled
      ? designSystemAgentState.host === 1 && designSystemAgentState.control === 1
      : designSystemAgentState.host === 0 &&
        designSystemAgentState.control === 0 &&
        designSystemAgentState.assets.length === 0,
    JSON.stringify(designSystemAgentState));
}

export const SURFACE_CHECK_NAMES = [
  'opening shell does not stay up',
  'desktop opens on the complete Start from template ribbon',
  'anonymous desktop puts Log In second',
  'desktop Log In opens the phone QR flow',
  'surface tier is explicit',
  'scrolling document bodies stay opaque',
  'reduced glass removes shader and blur',
  'reduced motion stops material transitions',
  'document renders blocks',
  'desktop ribbon is registry-driven',
  'ribbon KeyTips are keyboard discoverable',
  'agent-chat build flag matches the expected state',
  'local agent privacy disclosure is truthful',
  'enabled agent chat exposes the guarded command bridge',
  'agent visibly raises the relevant ribbon task',
  'agent command changes to rendered-only mode',
  'rendered-only ribbon removes text mutation controls',
  'agent can restore split mode through the same command runtime',
  'disabled agent chat exposes no UI, command bridge, or ribbon choreography',
  'disabled agent chat makes no agent network or lazy-asset requests',
  'desktop split inspects the rendered pane from a preview click',
  'desktop split restores compose commands from an editor click',
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
  'floating document actions preserve template command hit targets',
  'voice input is honest',
  'select-all in the preview stays inside the document',
  'preview right-click opens the marks menu',
  'theme toggles',
  'connectivity state is honest',
  'GPU context loss disables the failed canvas and selects a fallback',
  'book fold uses a view rail and a full-width ribbon',
  'unfolded app rail is thinner than the Material 3 80dp rail',
  'book fold ribbon spans its chrome container',
  'book fold split does not use the phone ghost overlay',
  'book fold split is a real two-pane hinge canvas',
  'book fold split keeps compose until the app rail changes the view',
  'book fold preview rail shows inspect commands',
  'disabled ribbon-wild stays absent from foldable command libraries',
  'book fold command library exposes all five possibility tools',
  'possibility layer respects the unfolded book posture',
  'laptop fold uses a view rail and a full-width ribbon',
  'laptop fold split does not use the phone ghost overlay',
  'laptop fold split is a real stacked hinge canvas',
  'possibility layer respects the unfolded laptop posture',
  'phone uses a focused composer instead of desktop ribbon',
  'phone opens on the complete Start from template ribbon',
  'anonymous phone puts Log In second',
  'service phone public marketing document opens in Preview with Start from template selected',
  'phone write keeps a full-width editor under a right-hand ghost preview',
  'phone ghost viewfinder is clipped and pointer-transparent',
  'phone two-finger pan snaps the ghost to the other page half',
  'phone preview mode removes the ghost overlay',
  'phone More does not duplicate anonymous login',
  'phone Log In is laptop-first with no phone-only registration',
  'disabled ribbon-wild stays absent from the phone Review ribbon',
  'disabled ribbon-wild requests no lazy code or style assets',
  'phone Review ribbon exposes all five possibility tools',
  'possibility layer becomes a focused phone surface',
  'design-system agent chat catalog follows the product flag',
];
