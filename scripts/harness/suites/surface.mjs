/**
 * Portable browser-surface checks that every driver can run.
 *
 * Deep collaboration and REST cases stay in scripts/ci-service-ui.mjs
 * (Playwright against marks-server). This suite covers the portable glass:
 * create a doc, preview, select-all, context menu, voice, theme, and offline.
 */

const FIXTURE = `# Surface harness

Hello from the portable suite.

Currently this note targets API v3.
`;

const EXPECT_PRODUCT_VARIANT = process.env.MARKS_EXPECT_PRODUCT_VARIANT ?? null;
const EXPECT_BUILD_PLAN_SHA256 = process.env.MARKS_EXPECT_BUILD_PLAN_SHA256 ?? null;
if ((EXPECT_PRODUCT_VARIANT === null) !== (EXPECT_BUILD_PLAN_SHA256 === null)) {
  throw new Error(
    'MARKS_EXPECT_PRODUCT_VARIANT and MARKS_EXPECT_BUILD_PLAN_SHA256 must be supplied together',
  );
}
if (EXPECT_BUILD_PLAN_SHA256 !== null && !/^[a-f0-9]{64}$/u.test(EXPECT_BUILD_PLAN_SHA256)) {
  throw new Error('MARKS_EXPECT_BUILD_PLAN_SHA256 must be a lowercase SHA-256 digest');
}

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

async function waitForPageState(session, predicate, { timeout = 10_000, label = 'page state' } = {}) {
  const deadline = Date.now() + timeout;
  while (!(await session.evaluate(predicate))) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${label}`);
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
    const rootStyle = getComputedStyle(document.documentElement);
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
      segment0Width: Number.parseFloat(rootStyle.getPropertyValue('--segment-0-width')) || 0,
      segment0Height: Number.parseFloat(rootStyle.getPropertyValue('--segment-0-height')) || 0,
      hingeGap: Number.parseFloat(rootStyle.getPropertyValue('--hinge-gap')) || 0,
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

  const productBuildState = await session.evaluate(async () => {
    const root = document.documentElement;
    const json = document.querySelector('#marks-product-build')?.textContent ?? '';
    let receipt = null;
    try {
      receipt = JSON.parse(json);
    } catch {
      // The check below reports a missing or malformed receipt with context.
    }
    const canonicalize = (value) => {
      if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
        return JSON.stringify(value);
      }
      if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
      return `{${Object.keys(value).sort().map((key) =>
        `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
    };
    let computedDigest = 'unavailable';
    if (receipt?.buildPlan && globalThis.crypto?.subtle) {
      const bytes = new TextEncoder().encode(canonicalize(receipt.buildPlan));
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      computedDigest = [...new Uint8Array(digest)]
        .map((value) => value.toString(16).padStart(2, '0'))
        .join('');
    }
    return {
      receipt,
      json,
      computedDigest,
      variant: root.dataset.marksProductVariant ?? 'missing',
      digest: root.dataset.marksBuildPlanSha256 ?? 'missing',
      agentChat: root.dataset.marksAgentChat ?? 'missing',
      ribbonWild: root.dataset.marksRibbonWild ?? 'missing',
      dataMode: root.dataset.marksMode ?? 'missing',
    };
  });
  const productPlan = productBuildState.receipt?.buildPlan;
  const agentChatEnabled = productPlan?.features?.['agent-chat'] === true;
  const ribbonWildEnabled = productPlan?.features?.['ribbon-wild'] === true;
  check('product build receipt is embedded and schema-valid',
    productBuildState.receipt?.schema === 'marks.product-build-receipt.v1' &&
    productPlan?.schema === 'marks.product-build-plan.v1' &&
    typeof productPlan?.deployable === 'boolean' &&
    typeof productPlan?.features?.['agent-chat'] === 'boolean' &&
    typeof productPlan?.features?.['ribbon-wild'] === 'boolean' &&
    /^[a-f0-9]{64}$/u.test(productBuildState.receipt?.buildPlanSha256 ?? '') &&
    productBuildState.computedDigest === productBuildState.receipt?.buildPlanSha256,
    JSON.stringify(productBuildState));
  check('root product diagnostics agree with the embedded build plan',
    productBuildState.variant === productPlan?.productVariant &&
    productBuildState.digest === productBuildState.receipt?.buildPlanSha256 &&
    productBuildState.dataMode === productPlan?.client?.dataMode &&
    productBuildState.agentChat === (agentChatEnabled ? 'enabled' : 'disabled') &&
    productBuildState.ribbonWild === (ribbonWildEnabled ? 'enabled' : 'disabled'),
    JSON.stringify(productBuildState));
  check('product build matches the externally requested identity',
    EXPECT_PRODUCT_VARIANT === null || (
      productPlan?.productVariant === EXPECT_PRODUCT_VARIANT &&
      productBuildState.receipt?.buildPlanSha256 === EXPECT_BUILD_PLAN_SHA256
    ),
    `expected=${EXPECT_PRODUCT_VARIANT ?? 'unspecified'}/${EXPECT_BUILD_PLAN_SHA256 ?? 'unspecified'} ` +
      `actual=${productPlan?.productVariant ?? 'missing'}/${productBuildState.receipt?.buildPlanSha256 ?? 'missing'}`);

  const openingRibbon = await session.evaluate(() => {
    const selected = document.querySelector('.ribbon-tab[aria-selected="true"]');
    const topLevel = [...document.querySelectorAll('.ribbon-tab')]
      .map((tab) => tab.textContent?.trim() ?? '');
    const expected = [
      'format.bold',
      'format.italic',
      'format.heading-1',
    ];
    return {
      selected: selected?.textContent?.trim() ?? '',
      topLevel,
      commands: expected.map((id) => Boolean(document.querySelector(`[data-command-id="${id}"]`))),
    };
  });
  check(
    'desktop edit opens on the Home ribbon',
    openingRibbon.selected === 'Home' && openingRibbon.commands.every(Boolean),
    JSON.stringify(openingRibbon),
  );
  const desktopDataMode = await session.evaluate(() => document.documentElement.dataset.marksMode ?? 'local');
  check(
    'anonymous desktop puts Log In second',
    desktopDataMode !== 'service' || (
      openingRibbon.topLevel[0] === 'Start from template' &&
      openingRibbon.topLevel[1] === 'Log In'
    ),
    JSON.stringify(openingRibbon.topLevel),
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
    // The login flow intentionally selects the Log In tab. Restore Start
    // before the service registry assertion; local documents remain on Home.
    await session.click('.ribbon-tab[data-ribbon-tab="import"]');
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
  const activeRegistryCommand = desktopDataMode === 'service' ? 'import.url' : 'format.bold';
  const registryCounts = {
    activeCommand: activeRegistryCommand,
    activeCount: await session.count(`.ribbon-body [data-command-id="${activeRegistryCommand}"]`),
    quickBold: await session.count('.quick-access [data-command-id="format.bold"]'),
  };
  check('desktop ribbon is registry-driven',
    registryCounts.activeCount === 1 && registryCounts.quickBold >= 1,
    JSON.stringify(registryCounts));

  await session.click('.ribbon-tab');
  await session.press('Alt');
  await session.wait(100);
  check('ribbon KeyTips are keyboard discoverable', (await session.count('.ribbon-keytip')) >= 2);
  await session.press('Escape');

  const agentChatState = await session.evaluate(() =>
    document.documentElement.dataset.marksAgentChat ?? 'missing');
  check('agent-chat runtime state matches the resolved build plan',
    agentChatState === (agentChatEnabled ? 'enabled' : 'disabled'),
    `plan=${agentChatEnabled ? 'enabled' : 'disabled'} actual=${agentChatState}`);

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
  check('ribbon-wild runtime state matches the resolved build plan',
    ribbonWildState === (ribbonWildEnabled ? 'enabled' : 'disabled'),
    `plan=${ribbonWildEnabled ? 'enabled' : 'disabled'} actual=${ribbonWildState}`);

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
    const header = document.querySelector('.app-ribbon');
    const foldableRibbon = document.querySelector('.foldable-ribbon');
    const primary = document.querySelector('.foldable-ribbon-primary');
    const companion = document.querySelector('.foldable-ribbon-companion');
    const ribbon = document.querySelector('.foldable-ribbon .ribbon-body');
    const tabs = document.querySelector('.foldable-ribbon .ribbon-tabs');
    const deck = document.querySelector('.foldable-ribbon .ribbon-deck');
    const rootStyle = getComputedStyle(document.documentElement);
    const segment0Width = Number.parseFloat(rootStyle.getPropertyValue('--segment-0-width')) || 0;
    const hingeGap = Number.parseFloat(rootStyle.getPropertyValue('--hinge-gap')) || 0;
    const hingeStart = segment0Width;
    const hingeEnd = hingeStart + hingeGap;
    const rect = (node) => node instanceof HTMLElement ? node.getBoundingClientRect() : null;
    const railRect = rect(rail);
    const headerRect = rect(header);
    const foldableRect = rect(foldableRibbon);
    const primaryRect = rect(primary);
    const companionRect = rect(companion);
    const ribbonRect = rect(ribbon);
    const tabsRect = rect(tabs);
    const deckRect = rect(deck);
    const hingeTargets = [...document.querySelectorAll('.foldable-ribbon button, .titlebar button')]
      .filter((node) => {
        if (!(node instanceof HTMLElement) || getComputedStyle(node).visibility === 'hidden') return false;
        const targetRect = node.getBoundingClientRect();
        return targetRect.width > 0 && targetRect.height > 0 &&
          targetRect.left < hingeEnd && targetRect.right > hingeStart;
      })
      .map((node) => node.getAttribute('data-command-id') ?? node.getAttribute('aria-label') ?? node.textContent?.trim() ?? 'button');
    return {
      commands: document.querySelectorAll('.app-rail [data-command-id]').length,
      ribbons: document.querySelectorAll('.ribbon-body').length,
      foldRibbons: document.querySelectorAll('.foldable-ribbon').length,
      railWidth: railRect ? Math.round(railRect.width) : 0,
      ribbonWidth: ribbonRect ? Math.round(ribbonRect.width) : 0,
      foldableWidth: foldableRect ? Math.round(foldableRect.width) : 0,
      headerWidth: headerRect ? Math.round(headerRect.width) : 0,
      railRight: railRect ? Math.round(railRect.right) : 0,
      primaryRight: primaryRect ? Math.round(primaryRect.right) : 0,
      ribbonRight: ribbonRect ? Math.round(ribbonRect.right) : 0,
      tabsRight: tabsRect ? Math.round(tabsRect.right) : 0,
      deckRight: deckRect ? Math.round(deckRect.right) : 0,
      companionLeft: companionRect ? Math.round(companionRect.left) : 0,
      hingeStart,
      hingeEnd,
      hingeTargets,
    };
  });
  check('book fold uses a view rail and a full-width ribbon',
    bookChrome.commands === 3 && bookChrome.ribbons === 1 && bookChrome.foldRibbons === 1,
    JSON.stringify(bookChrome));
  check('unfolded app rail is thinner than the Material 3 80dp rail',
    bookChrome.railWidth > 0 && bookChrome.railWidth <= 72,
    String(bookChrome.railWidth));
  check('book fold ribbon spans its chrome container',
    bookChrome.foldableWidth > 0 && Math.abs(bookChrome.foldableWidth - bookChrome.headerWidth) <= 2,
    JSON.stringify(bookChrome));
  check('book fold keeps ribbon and titlebar controls out of the hinge',
    bookChrome.railRight <= bookChrome.hingeStart + 2 &&
    bookChrome.primaryRight <= bookChrome.hingeStart + 2 &&
    bookChrome.ribbonRight <= bookChrome.hingeStart + 2 &&
    bookChrome.tabsRight <= bookChrome.hingeStart + 2 &&
    bookChrome.deckRight <= bookChrome.hingeStart + 2 &&
    bookChrome.companionLeft >= bookChrome.hingeEnd - 2 &&
    bookChrome.hingeTargets.length === 0,
    JSON.stringify(bookChrome));
  await session.click('.app-rail [data-command-id="view.split"]');
  await session.waitForSelector('.workspace.mode-split', { timeout: 10_000 });
  await session.waitForSelector(
    '.foldable-ribbon .ribbon-body[data-ribbon-task="compose"]',
    { timeout: 10_000 },
  );
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
  check('book fold split panes align to the physical hinge',
    Math.abs(bookSplit.editorLeft + bookSplit.editorW - bookSplit.segment0Width) <= 3 &&
    Math.abs(bookSplit.previewLeft - (bookSplit.segment0Width + bookSplit.hingeGap)) <= 3,
    JSON.stringify(bookSplit));

  const bookProfileExpanded = await session.evaluate(() =>
    document.querySelector('.foldable-ribbon .ribbon-profile-toggle')?.getAttribute('aria-pressed') === 'true');
  if (bookProfileExpanded) {
    await session.click('.foldable-ribbon .ribbon-profile-toggle');
    await session.waitForSelector(
      '.foldable-ribbon .ribbon-profile-toggle[aria-pressed="false"]',
      { timeout: 10_000 },
    );
  }
  await session.click('.foldable-ribbon .ribbon-tab[data-ribbon-tab="home"]');
  await session.waitForSelector(
    '.foldable-ribbon .ribbon-tab[data-ribbon-tab="home"][aria-selected="true"]',
    { timeout: 10_000 },
  );
  await session.waitForSelector(
    '.foldable-ribbon .ribbon-body[data-ribbon-task="compose"] [data-command-id="format.bold"]',
    { timeout: 10_000 },
  );
  await session.click('.preview-pane');
  await session.waitForSelector(
    '.foldable-ribbon .ribbon-body[data-ribbon-task="compose"] [data-command-id="format.bold"]',
    { timeout: 10_000 },
  );
  check('book fold split keeps compose until the app rail changes the view',
    (await session.evaluate(() => document.querySelector('.foldable-ribbon .ribbon-body')?.getAttribute('data-ribbon-task'))) === 'compose' &&
    (await session.count('.foldable-ribbon .ribbon-body [data-command-id="format.bold"]')) >= 1);
  await session.click('.app-rail [data-command-id="view.preview"]');
  await session.waitForSelector('.workspace.mode-preview', { timeout: 10_000 });
  await session.waitForSelector(
    '.foldable-ribbon .ribbon-body[data-ribbon-task="inspect"]',
    { timeout: 10_000 },
  );
  await waitForAbsent(session, '.foldable-ribbon .ribbon-body [data-command-id="format.bold"]');
  check('book fold preview rail shows inspect commands',
    (await session.evaluate(() => document.querySelector('.foldable-ribbon .ribbon-body')?.getAttribute('data-ribbon-task'))) === 'inspect' &&
    (await session.count('.foldable-ribbon .ribbon-body [data-command-id="format.bold"]')) === 0);
  await session.click('.app-rail [data-command-id="view.split"]');
  await session.waitForSelector('.workspace.mode-split', { timeout: 10_000 });
  await session.waitForSelector(
    '.foldable-ribbon .ribbon-body[data-ribbon-task="compose"]',
    { timeout: 10_000 },
  );

  const bookProfileCollapsed = await session.evaluate(() =>
    document.querySelector('.foldable-ribbon .ribbon-profile-toggle')?.getAttribute('aria-pressed') !== 'true');
  if (bookProfileCollapsed) {
    await session.click('.foldable-ribbon .ribbon-profile-toggle');
    await session.waitForSelector(
      '.foldable-ribbon .ribbon-profile-toggle[aria-pressed="true"]',
      { timeout: 10_000 },
    );
  }
  await session.click('.foldable-ribbon .ribbon-tab[data-ribbon-tab="review"]');
  await session.waitForSelector(
    '.foldable-ribbon .ribbon-tab[data-ribbon-tab="review"][aria-selected="true"]',
    { timeout: 10_000 },
  );
  if (await session.count('.foldable-ribbon .ribbon-overflow-trigger')) {
    await session.click('.foldable-ribbon .ribbon-overflow-trigger');
    await session.waitForSelector('.foldable-ribbon .ribbon-overflow-menu', { timeout: 10_000 });
  }
  if (ribbonWildEnabled) {
    await waitForPageState(
      session,
      () => document.querySelectorAll('.foldable-ribbon .ribbon-body [data-command-id^="wild."]').length === 5,
      { timeout: 10_000, label: 'all five book-fold possibility commands' },
    );
    check('book fold command library exposes all five possibility tools',
      (await session.count('.foldable-ribbon .ribbon-body [data-command-id^="wild."]')) === 5);
    await session.click('.foldable-ribbon .ribbon-body [data-command-id="wild.intent-horizon"]');
    await session.waitForSelector('.wild-studio[data-shell="fold-book"][data-wild-capability="intent"]');
    check('possibility layer respects the unfolded book posture',
      (await session.isVisible('.wild-studio[data-shell="fold-book"]')));
    await session.click('button[aria-label="Close possibility layer"]');
  } else {
    check('disabled ribbon-wild stays absent from foldable command libraries',
      (await session.count('.ribbon-body [data-command-id^="wild."]')) === 0);
  }

  // Reproduce the narrow unfolded book geometry that previously let View's
  // local Presence group push More into the 28px hinge. Restore the portable
  // suite's wide viewport before continuing with the existing laptop checks.
  await session.setViewport({ width: 1080, height: 800 });
  await session.goto(`${documentPath}?marks-posture=fold-book`);
  await session.waitForSelector('.foldable-ribbon .ribbon-body', { timeout: 20_000 });
  await session.evaluate(() => {
    const profile = document.querySelector('.ribbon-profile-toggle');
    if (profile instanceof HTMLButtonElement && profile.getAttribute('aria-pressed') === 'true') profile.click();
  });
  await session.wait(100);
  await session.click('.ribbon-tab[data-ribbon-tab="view"]');
  await session.waitForSelector('.ribbon-overflow-trigger', { timeout: 10_000 });
  const narrowBookView = await session.evaluate(() => {
    const rootStyle = getComputedStyle(document.documentElement);
    const primary = document.querySelector('.foldable-ribbon-primary');
    const toolbar = document.querySelector('.foldable-ribbon .ribbon-toolbar');
    const trigger = document.querySelector('.foldable-ribbon .ribbon-overflow-trigger');
    const presence = [...document.querySelectorAll('.foldable-ribbon .ribbon-command-group')]
      .find((group) => group.querySelector('.ribbon-group-label')?.textContent?.trim() === 'Presence');
    const primaryRect = primary?.getBoundingClientRect();
    const triggerRect = trigger?.getBoundingClientRect();
    const presenceRect = presence?.getBoundingClientRect();
    const hingeStart = Number.parseFloat(rootStyle.getPropertyValue('--segment-0-width')) || 0;
    const hingeEnd = hingeStart + (Number.parseFloat(rootStyle.getPropertyValue('--hinge-gap')) || 0);
    const hit = triggerRect
      ? document.elementFromPoint(triggerRect.left + triggerRect.width / 2, triggerRect.top + triggerRect.height / 2)
      : null;
    return {
      viewportWidth: window.innerWidth,
      hingeStart,
      hingeEnd,
      primaryLeft: primaryRect ? Math.round(primaryRect.left) : 0,
      primaryRight: primaryRect ? Math.round(primaryRect.right) : 0,
      triggerLeft: triggerRect ? Math.round(triggerRect.left) : 0,
      triggerRight: triggerRect ? Math.round(triggerRect.right) : 0,
      presenceRight: presenceRect ? Math.round(presenceRect.right) : 0,
      toolbarClientWidth: toolbar?.clientWidth ?? 0,
      toolbarScrollWidth: toolbar?.scrollWidth ?? 0,
      triggerHit: Boolean(hit?.closest('.ribbon-overflow-trigger') === trigger),
    };
  });
  check('1080px book View keeps Presence and More before the hinge',
    narrowBookView.viewportWidth === 1080 &&
    Math.abs(narrowBookView.hingeStart - 526) <= 1 &&
    Math.abs(narrowBookView.hingeEnd - 554) <= 1 &&
    Math.abs(narrowBookView.primaryRight - narrowBookView.hingeStart) <= 2 &&
    narrowBookView.presenceRight <= narrowBookView.hingeStart &&
    narrowBookView.triggerLeft >= narrowBookView.primaryLeft &&
    narrowBookView.triggerRight <= narrowBookView.hingeStart &&
    narrowBookView.toolbarScrollWidth <= narrowBookView.toolbarClientWidth + 1 &&
    narrowBookView.triggerHit,
    JSON.stringify(narrowBookView));

  await session.click('.ribbon-overflow-trigger');
  await session.waitForSelector('.ribbon-overflow-menu', { timeout: 10_000 });
  const narrowBookMenu = await session.evaluate(() => {
    const rootStyle = getComputedStyle(document.documentElement);
    const primary = document.querySelector('.foldable-ribbon-primary');
    const ribbon = document.querySelector('.app-ribbon');
    const menu = document.querySelector('.ribbon-overflow-menu');
    const firstCommand = menu?.querySelector('button');
    const primaryRect = primary?.getBoundingClientRect();
    const ribbonRect = ribbon?.getBoundingClientRect();
    const menuRect = menu?.getBoundingClientRect();
    const commandRect = firstCommand?.getBoundingClientRect();
    const hit = commandRect
      ? document.elementFromPoint(commandRect.left + commandRect.width / 2, commandRect.top + commandRect.height / 2)
      : null;
    return {
      hingeStart: Number.parseFloat(rootStyle.getPropertyValue('--segment-0-width')) || 0,
      primaryLeft: primaryRect ? Math.round(primaryRect.left) : 0,
      ribbonBottom: ribbonRect ? Math.round(ribbonRect.bottom) : 0,
      menuLeft: menuRect ? Math.round(menuRect.left) : 0,
      menuRight: menuRect ? Math.round(menuRect.right) : 0,
      menuTop: menuRect ? Math.round(menuRect.top) : 0,
      menuBottom: menuRect ? Math.round(menuRect.bottom) : 0,
      commandHit: Boolean(hit?.closest('.ribbon-overflow-menu') === menu),
    };
  });
  check('1080px book More menu opens visibly outside the ribbon and before the hinge',
    narrowBookMenu.menuLeft >= narrowBookMenu.primaryLeft &&
    narrowBookMenu.menuRight <= narrowBookMenu.hingeStart &&
    narrowBookMenu.menuTop > narrowBookMenu.ribbonBottom &&
    narrowBookMenu.menuBottom > narrowBookMenu.menuTop &&
    narrowBookMenu.commandHit,
    JSON.stringify(narrowBookMenu));
  await session.click('.ribbon-overflow-trigger');
  await session.wait(50);

  await session.click('.ribbon-profile-toggle');
  await session.wait(100);
  const narrowBookProfile = await session.evaluate(() => {
    const tabs = document.querySelector('.ribbon-tabs');
    const toggle = document.querySelector('.ribbon-profile-toggle');
    const tabsRect = tabs?.getBoundingClientRect();
    const toggleRect = toggle?.getBoundingClientRect();
    const hit = toggleRect
      ? document.elementFromPoint(toggleRect.left + toggleRect.width / 2, toggleRect.top + toggleRect.height / 2)
      : null;
    return {
      expanded: toggle?.getAttribute('aria-pressed') === 'true',
      focused: document.activeElement === toggle,
      scrollLeft: tabs?.scrollLeft ?? 0,
      tabsLeft: tabsRect ? Math.round(tabsRect.left) : 0,
      tabsRight: tabsRect ? Math.round(tabsRect.right) : 0,
      toggleLeft: toggleRect ? Math.round(toggleRect.left) : 0,
      toggleRight: toggleRect ? Math.round(toggleRect.right) : 0,
      toggleHit: Boolean(hit === toggle),
    };
  });
  check('1080px book keeps the focused Essentials toggle visible after expansion',
    narrowBookProfile.expanded && narrowBookProfile.focused && narrowBookProfile.scrollLeft > 0 &&
    narrowBookProfile.toggleLeft >= narrowBookProfile.tabsLeft &&
    narrowBookProfile.toggleRight <= narrowBookProfile.tabsRight &&
    narrowBookProfile.toggleHit,
    JSON.stringify(narrowBookProfile));

  await session.setViewport({ width: 1440, height: 900 });
  await session.goto(`${documentPath}?marks-posture=fold-laptop`);
  await session.waitForSelector('.app-rail', { timeout: 20_000 });
  const laptopChrome = await session.evaluate(() => {
    const rail = document.querySelector('.app-rail');
    const main = document.querySelector('.main.route-document');
    const railRect = rail instanceof HTMLElement ? rail.getBoundingClientRect() : null;
    const rootStyle = getComputedStyle(document.documentElement);
    const mainStyle = main instanceof HTMLElement ? getComputedStyle(main) : null;
    return {
      commands: document.querySelectorAll('.app-rail [data-command-id]').length,
      ribbons: document.querySelectorAll('.ribbon-body').length,
      foldRibbons: document.querySelectorAll('.foldable-ribbon').length,
      railTop: railRect ? Math.round(railRect.top) : 0,
      railBottom: railRect ? Math.round(railRect.bottom) : 0,
      hingeStart: Number.parseFloat(rootStyle.getPropertyValue('--segment-0-height')) || 0,
      ribbonHeight: Number.parseFloat(mainStyle?.getPropertyValue('--fold-top-chrome-height') ?? '') || 0,
    };
  });
  check('laptop fold uses a view rail and a full-width ribbon',
    laptopChrome.commands === 3 && laptopChrome.ribbons === 1 && laptopChrome.foldRibbons === 1,
    JSON.stringify(laptopChrome));
  check('laptop fold rail stays in the upper workspace segment',
    Math.abs(laptopChrome.railTop - laptopChrome.ribbonHeight) <= 2 &&
    laptopChrome.railBottom <= laptopChrome.hingeStart + 2,
    JSON.stringify(laptopChrome));
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
  check('laptop fold split panes align to the physical hinge',
    Math.abs(laptopSplit.editorTop + laptopSplit.editorH - laptopSplit.segment0Height) <= 3 &&
    Math.abs(laptopSplit.previewTop - (laptopSplit.segment0Height + laptopSplit.hingeGap)) <= 3,
    JSON.stringify(laptopSplit));
  await session.click('.ribbon-collapse');
  await session.wait(100);
  const laptopCollapsed = {
    ...await measureWorkspacePanes(session),
    ...await session.evaluate(() => {
      const rail = document.querySelector('.app-rail');
      const main = document.querySelector('.main.route-document');
      const railRect = rail instanceof HTMLElement ? rail.getBoundingClientRect() : null;
      const mainStyle = main instanceof HTMLElement ? getComputedStyle(main) : null;
      return {
        collapsed: document.querySelector('.app')?.classList.contains('ribbon-collapsed') ?? false,
        railTop: railRect ? Math.round(railRect.top) : 0,
        railBottom: railRect ? Math.round(railRect.bottom) : 0,
        topChromeHeight: Number.parseFloat(mainStyle?.getPropertyValue('--fold-top-chrome-height') ?? '') || 0,
      };
    }),
  };
  check('laptop fold collapsed chrome keeps rail and panes hinge-aligned',
    laptopCollapsed.collapsed &&
    Math.abs(laptopCollapsed.railTop - laptopCollapsed.topChromeHeight) <= 2 &&
    Math.abs(laptopCollapsed.railBottom - laptopCollapsed.segment0Height) <= 3 &&
    Math.abs(laptopCollapsed.editorTop + laptopCollapsed.editorH - laptopCollapsed.segment0Height) <= 3 &&
    Math.abs(laptopCollapsed.previewTop - (laptopCollapsed.segment0Height + laptopCollapsed.hingeGap)) <= 3,
    JSON.stringify(laptopCollapsed));
  await session.click('.ribbon-collapse');
  await session.wait(100);
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
  await session.waitForSelector('.phone-ribbon-deck', { timeout: 20_000 });
  check('phone uses a focused composer instead of desktop ribbon',
    (await session.count('.phone-ribbon')) === 1 &&
    (await session.count('.ribbon-body')) === 0 &&
    (await session.count('.phone-ribbon-tabs')) === 0);
  const phoneDataMode = await session.evaluate(() => document.documentElement.dataset.marksMode ?? 'local');
  if (phoneDataMode === 'service') {
    await session.waitForSelector(
      '.app[data-marketing="true"] .workspace.mode-preview .marks-preview .marks-block',
      { timeout: 20_000 },
    );
  } else {
    await session.waitForSelector(
      '.workspace.mode-edit .editor-pane .cm-content',
      { timeout: 20_000 },
    );
  }
  const phoneEntry = await session.evaluate(() => ({
    dataMode: document.documentElement.dataset.marksMode ?? 'local',
    marketing: document.querySelector('.app')?.getAttribute('data-marketing') ?? '',
    mode: [...(document.querySelector('.workspace')?.classList ?? [])]
      .find((name) => name.startsWith('mode-')) ?? '',
    category: document.querySelector('.phone-category-trigger strong')?.textContent?.trim() ?? '',
    deck: document.querySelector('.phone-ribbon-deck')?.getAttribute('aria-label') ?? '',
    retiredTabs: document.querySelectorAll('.phone-ribbon-tabs').length,
    categoryTrigger: document.querySelectorAll('.phone-category-trigger').length,
    editorModeControls: document.querySelectorAll('.phone-mode-switch [data-command-id="view.editor"]').length,
    previewModeControls: document.querySelectorAll('.phone-mode-switch [data-command-id="view.preview"]').length,
    editPressed: document.querySelector('.phone-mode-switch [data-command-id="view.editor"]')?.getAttribute('aria-pressed') ?? '',
    previewPressed: document.querySelector('.phone-mode-switch [data-command-id="view.preview"]')?.getAttribute('aria-pressed') ?? '',
    editor: Boolean(document.querySelector('.editor-pane')),
    renderedBlocks: document.querySelectorAll('.preview-pane .marks-preview .marks-block').length,
  }));
  check(
    'phone category picker replaces the retired tab strip and keeps view modes persistent',
    phoneEntry.retiredTabs === 0 &&
      phoneEntry.categoryTrigger === 1 &&
      phoneEntry.editorModeControls === 1 &&
      phoneEntry.previewModeControls === 1,
    JSON.stringify(phoneEntry),
  );
  check(
    'ordinary phone edit documents default to Home',
    phoneEntry.dataMode === 'service' || (
      phoneEntry.marketing !== 'true' &&
      phoneEntry.mode === 'mode-edit' &&
      phoneEntry.category === 'Home' &&
      phoneEntry.deck === 'Home commands' &&
      phoneEntry.editPressed === 'true'
    ),
    JSON.stringify(phoneEntry),
  );
  check(
    'service phone public marketing document opens in Preview with View selected',
    phoneEntry.dataMode !== 'service' || (
      phoneEntry.marketing === 'true' &&
      phoneEntry.mode === 'mode-preview' &&
      phoneEntry.category === 'View' &&
      phoneEntry.deck === 'View commands' &&
      phoneEntry.previewPressed === 'true' &&
      !phoneEntry.editor &&
      phoneEntry.renderedBlocks >= 1
    ),
    JSON.stringify(phoneEntry),
  );

  await session.click('.phone-category-trigger');
  await session.waitForSelector('#phone-ribbon-categories', { timeout: 10_000 });
  const categoryPicker = await session.evaluate(() => ({
    role: document.querySelector('#phone-ribbon-categories')?.getAttribute('role') ?? '',
    ids: [...document.querySelectorAll('#phone-ribbon-categories [data-ribbon-tab]')]
      .map((button) => button.getAttribute('data-ribbon-tab')),
    nonButtons: document.querySelectorAll('#phone-ribbon-categories [data-ribbon-tab]:not(button)').length,
    pressed: document.querySelector('#phone-ribbon-categories [data-ribbon-tab][aria-pressed="true"]')
      ?.getAttribute('data-ribbon-tab') ?? '',
  }));
  check(
    'phone category trigger opens the ribbon category dialog',
    categoryPicker.role === 'dialog' &&
      categoryPicker.nonButtons === 0 &&
      categoryPicker.ids.includes('home') &&
      categoryPicker.ids.includes('view') &&
      categoryPicker.ids.includes('import') &&
      categoryPicker.pressed === (phoneEntry.category === 'View' ? 'view' : 'home'),
    JSON.stringify(categoryPicker),
  );
  await session.click('#phone-ribbon-categories [data-ribbon-tab="view"]');
  await waitForAbsent(session, '#phone-ribbon-categories');
  await session.waitForSelector(
    '.phone-ribbon-deck[aria-label="View commands"] [data-command-id="view.ghost-overlay"]',
    { timeout: 10_000 },
  );
  const viewDeck = await session.evaluate(() => ({
    duplicateModes: document.querySelectorAll(
      '.phone-ribbon-deck [data-command-id="view.editor"], .phone-ribbon-deck [data-command-id="view.split"], .phone-ribbon-deck [data-command-id="view.preview"]',
    ).length,
    persistentEditor: document.querySelectorAll('.phone-mode-switch [data-command-id="view.editor"]').length,
    persistentPreview: document.querySelectorAll('.phone-mode-switch [data-command-id="view.preview"]').length,
    ghostLabel: document.querySelector('.phone-ribbon-deck [data-command-id="view.ghost-overlay"]')?.getAttribute('aria-label') ?? '',
    ghostStatus: document.querySelector('.phone-ribbon-deck [data-command-id="view.ghost-overlay"] .phone-command-status')?.textContent?.trim() ?? '',
    horizontalScrollers: [...document.querySelectorAll('.phone-composer *')]
      .filter((node) => ['auto', 'scroll'].includes(getComputedStyle(node).overflowX))
      .map((node) => node.className),
  }));
  check(
    'phone View deck owns horizontal scrolling without duplicate mode commands',
    viewDeck.duplicateModes === 0 &&
      viewDeck.persistentEditor === 1 &&
      viewDeck.persistentPreview === 1 &&
      viewDeck.horizontalScrollers.length === 1 &&
      viewDeck.horizontalScrollers[0] === 'phone-ribbon-deck',
    JSON.stringify(viewDeck),
  );
  check(
    'phone View deck exposes the default-on ghost overlay command',
    viewDeck.ghostLabel === 'Ghost overlay, On' && viewDeck.ghostStatus === 'On',
    JSON.stringify(viewDeck),
  );

  await session.click('.phone-mode-switch [data-command-id="view.editor"]');
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

  // Edit retasks the phone ribbon to Compose/Home. Choose View again before
  // invoking a View-owned command instead of racing that intentional effect.
  await session.click('.phone-category-trigger');
  await session.waitForSelector('#phone-ribbon-categories', { timeout: 10_000 });
  await session.click('#phone-ribbon-categories [data-ribbon-tab="view"]');
  await waitForAbsent(session, '#phone-ribbon-categories');
  await session.waitForSelector(
    '.phone-ribbon-deck[aria-label="View commands"] [data-command-id="view.ghost-overlay"]',
    { timeout: 10_000 },
  );
  await session.click('.phone-ribbon-deck [data-command-id="view.ghost-overlay"]');
  await session.waitForSelector('[role="dialog"] .ghost-overlay-dialog', { timeout: 10_000 });
  const ghostDialog = await session.evaluate(() => ({
    title: document.querySelector('[role="dialog"] h2')?.textContent?.trim() ?? '',
    switchRole: document.querySelector('[role="dialog"] .ghost-overlay-switch input')?.getAttribute('role') ?? '',
    checked: Boolean(document.querySelector('[role="dialog"] .ghost-overlay-switch input')?.checked),
    left: document.querySelector('[role="dialog"] .ghost-overlay-halves button:first-child')?.textContent?.trim() ?? '',
    right: document.querySelector('[role="dialog"] .ghost-overlay-halves button:last-child')?.textContent?.trim() ?? '',
    guidance: document.querySelector('[role="dialog"] .ghost-overlay-gesture')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
  }));
  check(
    'phone ghost command opens its default-on Rendered Markdown dialog',
    ghostDialog.title === 'Rendered Markdown ghost' &&
      ghostDialog.switchRole === 'switch' &&
      ghostDialog.checked &&
      ghostDialog.left === 'Left half' &&
      ghostDialog.right === 'Right half' &&
      ghostDialog.guidance.includes('two fingers') &&
      ghostDialog.guidance.includes('One finger still edits') &&
      ghostDialog.guidance.includes('pinch still zooms'),
    JSON.stringify(ghostDialog),
  );

  await session.click('[role="dialog"] .ghost-overlay-halves button:first-child');
  await session.waitForSelector('.workspace.phone-ghost[data-ghost-shift="start"]', { timeout: 10_000 });
  await session.click('[role="dialog"] .ghost-overlay-halves button:last-child');
  await session.waitForSelector('.workspace.phone-ghost[data-ghost-shift="end"]', { timeout: 10_000 });
  const halfControls = await session.evaluate(() => ({
    shift: document.querySelector('.workspace.phone-ghost')?.getAttribute('data-ghost-shift') ?? '',
    leftPressed: document.querySelector('[role="dialog"] .ghost-overlay-halves button:first-child')?.getAttribute('aria-pressed') ?? '',
    rightPressed: document.querySelector('[role="dialog"] .ghost-overlay-halves button:last-child')?.getAttribute('aria-pressed') ?? '',
  }));
  check(
    'phone ghost dialog moves the rendered page with accessible half controls',
    halfControls.shift === 'end' && halfControls.leftPressed === 'false' && halfControls.rightPressed === 'true',
    JSON.stringify(halfControls),
  );

  await session.click('[role="dialog"] .ghost-overlay-switch input[role="switch"]');
  await waitForAbsent(session, '.workspace.phone-ghost');
  await waitForPageState(
    session,
    () => {
      try {
        return JSON.parse(localStorage.getItem('marks:ui-preferences:v1') ?? '{}').phoneGhost === false;
      } catch {
        return false;
      }
    },
    { label: 'the disabled phone ghost preference to persist' },
  );
  const ghostOff = await session.evaluate(() => ({
    checked: Boolean(document.querySelector('[role="dialog"] .ghost-overlay-switch input')?.checked),
    workspaceGhosts: document.querySelectorAll('.workspace.phone-ghost, .preview-ghost').length,
    stored: JSON.parse(localStorage.getItem('marks:ui-preferences:v1') ?? '{}').phoneGhost,
    commandLabel: document.querySelector('.phone-ribbon-deck [data-command-id="view.ghost-overlay"]')?.getAttribute('aria-label') ?? '',
  }));
  check(
    'phone ghost switch persists an explicit off preference',
    !ghostOff.checked && ghostOff.workspaceGhosts === 0 && ghostOff.stored === false && ghostOff.commandLabel === 'Ghost overlay, Off',
    JSON.stringify(ghostOff),
  );

  await session.click('[role="dialog"] .ghost-overlay-switch input[role="switch"]');
  await session.waitForSelector('.workspace.mode-edit.phone-ghost[data-ghost-shift="end"]', { timeout: 10_000 });
  await waitForPageState(
    session,
    () => {
      try {
        return JSON.parse(localStorage.getItem('marks:ui-preferences:v1') ?? '{}').phoneGhost === true;
      } catch {
        return false;
      }
    },
    { label: 'the enabled phone ghost preference to persist' },
  );
  const ghostOn = await session.evaluate(() => ({
    checked: Boolean(document.querySelector('[role="dialog"] .ghost-overlay-switch input')?.checked),
    shift: document.querySelector('.workspace.phone-ghost')?.getAttribute('data-ghost-shift') ?? '',
    stored: JSON.parse(localStorage.getItem('marks:ui-preferences:v1') ?? '{}').phoneGhost,
    commandLabel: document.querySelector('.phone-ribbon-deck [data-command-id="view.ghost-overlay"]')?.getAttribute('aria-label') ?? '',
  }));
  check(
    'phone ghost switch restores the overlay and remembered half',
    ghostOn.checked && ghostOn.shift === 'end' && ghostOn.stored === true && ghostOn.commandLabel === 'Ghost overlay, On',
    JSON.stringify(ghostOn),
  );
  await session.click('[role="dialog"] button[aria-label="Close"]');
  await waitForAbsent(session, '[role="dialog"]');
  await session.evaluate(() => {
    document.querySelectorAll('.toast button[aria-label="Dismiss notification"]')
      .forEach((button) => button.click());
  });
  await waitForAbsent(session, '.toast');

  await session.click('.phone-mode-switch [data-command-id="view.preview"]');
  await session.waitForSelector(
    '.workspace.mode-preview .preview-pane .marks-preview .marks-block',
    { timeout: 10_000 },
  );
  check('phone preview mode removes the ghost overlay',
    (await session.count('.workspace.phone-ghost, .preview-ghost')) === 0 &&
    (await session.isVisible('.preview-pane')) &&
    !(await session.isVisible('.editor-pane')));
  await session.click('.phone-mode-switch [data-command-id="view.editor"]');
  await session.waitForSelector(
    '.workspace.mode-edit.phone-ghost[data-ghost-shift="end"] .editor-pane .cm-content',
    { timeout: 10_000 },
  );
  check('phone ghost half survives Edit and Preview mode changes',
    (await session.count('.workspace.phone-ghost[data-ghost-shift="end"]')) === 1);

  await session.click('.phone-category-trigger');
  await session.waitForSelector('#phone-ribbon-categories', { timeout: 10_000 });
  const pairingCount = await session.count('.phone-ribbon [data-command-id="identity.pairing"]');
  const buriedLoginCount = await session.count('.phone-ribbon-deck [data-command-id="identity.keep"]');
  const loginCategoryCount = await session.count('#phone-ribbon-categories [data-ribbon-tab="login"]');
  check('phone category picker does not duplicate anonymous login',
    pairingCount === 0 && buriedLoginCount === 0 && loginCategoryCount <= 1,
    `${phoneDataMode}: ${pairingCount}/${buriedLoginCount}/${loginCategoryCount}`);
  if (phoneDataMode === 'service') {
    await session.click('#phone-ribbon-categories [data-ribbon-tab="login"]');
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
  } else {
    await session.click('#phone-ribbon-categories button[aria-label="Close ribbon categories"]');
    await waitForAbsent(session, '#phone-ribbon-categories');
  }

  await session.click('.phone-category-trigger');
  await session.waitForSelector('#phone-ribbon-categories', { timeout: 10_000 });
  const phoneCategoriesEssential = await session.evaluate(() =>
    document.querySelector('#phone-ribbon-categories .phone-category-all')?.getAttribute('aria-checked') !== 'true');
  if (phoneCategoriesEssential) {
    await session.click('#phone-ribbon-categories .phone-category-all');
    await session.waitForSelector(
      '#phone-ribbon-categories .phone-category-all[aria-checked="true"]',
      { timeout: 10_000 },
    );
  }
  await session.click('#phone-ribbon-categories [data-ribbon-tab="review"]');
  await session.waitForSelector('.phone-ribbon-deck[aria-label="Review commands"]');
  if (ribbonWildEnabled) {
    await waitForPageState(
      session,
      () => document.querySelectorAll('.phone-ribbon [data-command-id^="wild."]').length === 5,
      { timeout: 10_000, label: 'all five phone possibility commands' },
    );
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
  'product build receipt is embedded and schema-valid',
  'root product diagnostics agree with the embedded build plan',
  'product build matches the externally requested identity',
  'desktop edit opens on the Home ribbon',
  'anonymous desktop puts Log In second',
  'desktop Log In opens the phone QR flow',
  'surface tier is explicit',
  'scrolling document bodies stay opaque',
  'reduced glass removes shader and blur',
  'reduced motion stops material transitions',
  'document renders blocks',
  'desktop ribbon is registry-driven',
  'ribbon KeyTips are keyboard discoverable',
  'agent-chat runtime state matches the resolved build plan',
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
  'ribbon-wild runtime state matches the resolved build plan',
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
  'book fold keeps ribbon and titlebar controls out of the hinge',
  'book fold split does not use the phone ghost overlay',
  'book fold split is a real two-pane hinge canvas',
  'book fold split panes align to the physical hinge',
  'book fold split keeps compose until the app rail changes the view',
  'book fold preview rail shows inspect commands',
  'disabled ribbon-wild stays absent from foldable command libraries',
  'book fold command library exposes all five possibility tools',
  'possibility layer respects the unfolded book posture',
  '1080px book View keeps Presence and More before the hinge',
  '1080px book More menu opens visibly outside the ribbon and before the hinge',
  '1080px book keeps the focused Essentials toggle visible after expansion',
  'laptop fold uses a view rail and a full-width ribbon',
  'laptop fold rail stays in the upper workspace segment',
  'laptop fold split does not use the phone ghost overlay',
  'laptop fold split is a real stacked hinge canvas',
  'laptop fold split panes align to the physical hinge',
  'laptop fold collapsed chrome keeps rail and panes hinge-aligned',
  'possibility layer respects the unfolded laptop posture',
  'phone uses a focused composer instead of desktop ribbon',
  'phone category picker replaces the retired tab strip and keeps view modes persistent',
  'ordinary phone edit documents default to Home',
  'service phone public marketing document opens in Preview with View selected',
  'phone category trigger opens the ribbon category dialog',
  'phone View deck owns horizontal scrolling without duplicate mode commands',
  'phone View deck exposes the default-on ghost overlay command',
  'phone write keeps a full-width editor under a right-hand ghost preview',
  'phone ghost viewfinder is clipped and pointer-transparent',
  'phone two-finger pan snaps the ghost to the other page half',
  'phone ghost command opens its default-on Rendered Markdown dialog',
  'phone ghost dialog moves the rendered page with accessible half controls',
  'phone ghost switch persists an explicit off preference',
  'phone ghost switch restores the overlay and remembered half',
  'phone preview mode removes the ghost overlay',
  'phone ghost half survives Edit and Preview mode changes',
  'phone category picker does not duplicate anonymous login',
  'phone Log In is laptop-first with no phone-only registration',
  'disabled ribbon-wild stays absent from the phone Review ribbon',
  'disabled ribbon-wild requests no lazy code or style assets',
  'phone Review ribbon exposes all five possibility tools',
  'possibility layer becomes a focused phone surface',
  'design-system agent chat catalog follows the product flag',
];
