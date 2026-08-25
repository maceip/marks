import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { SURFACE_CHECK_NAMES } from './suites/surface.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const source = readFileSync(resolve(root, 'scripts/harness/suites/surface.mjs'), 'utf8');
const mobileProofSource = readFileSync(resolve(root, 'scripts/check-mobile-ui.mjs'), 'utf8');
const phoneStart = source.indexOf('await session.goto(`${documentPath}?marks-posture=phone`)');
const phoneFlow = source.slice(phoneStart, source.indexOf('\n}\n\nexport const SURFACE_CHECK_NAMES', phoneStart));
const touchStart = mobileProofSource.indexOf('async function reachEditorByTouch');
const touchFlow = mobileProofSource.slice(
  touchStart,
  mobileProofSource.indexOf('\n}\n\nasync function proveDesktopLogin', touchStart),
);

test('service entry waits for its generated public marketing document', () => {
  const createStart = source.indexOf('async function createDocument(session)');
  const createFlow = source.slice(createStart, source.indexOf('\n}\n\nasync function measureWorkspacePanes', createStart));

  assert.match(createFlow, /dataMode === 'service'/);
  assert.match(createFlow, /\.app\[data-marketing="true"\] \.cm-content/);
  assert.ok(
    createFlow.indexOf("dataMode === 'service'") <
      createFlow.indexOf("session.click('.home-actions .button.primary')"),
  );
});

test('desktop composing and phone preview open on their Office-style default categories', () => {
  assert.match(source, /openingRibbon\.selected === 'Home'/);
  assert.doesNotMatch(source, /desktop opens on the complete Start from template ribbon/);
  assert.ok(SURFACE_CHECK_NAMES.includes('desktop edit opens on the Home ribbon'));
  assert.match(phoneFlow, /ordinary phone edit documents default to Home/);
  assert.match(phoneFlow, /service phone public marketing document opens in Preview with View selected/);
  assert.doesNotMatch(phoneFlow, /Start from template selected|complete Start from template/);
});

test('phone surface proof uses the category picker and persistent Edit before ghost geometry', () => {
  assert.notEqual(phoneStart, -1);

  const previewEntry = phoneFlow.indexOf(
    'service phone public marketing document opens in Preview with View selected',
  );
  const openCategories = phoneFlow.indexOf("await session.click('.phone-category-trigger')");
  const categoryMenu = phoneFlow.indexOf("await session.waitForSelector('#phone-ribbon-categories'");
  const selectView = phoneFlow.indexOf(
    "await session.click('#phone-ribbon-categories [data-ribbon-tab=\"view\"]')",
  );
  const viewDeck = phoneFlow.indexOf(
    '.phone-ribbon-deck[aria-label="View commands"] [data-command-id="view.ghost-overlay"]',
  );
  const selectEditor = phoneFlow.indexOf(
    "await session.click('.phone-mode-switch [data-command-id=\"view.editor\"]')",
  );
  const editWorkspace = phoneFlow.indexOf('.workspace.mode-edit.phone-ghost .editor-pane .cm-content');
  const geometry = phoneFlow.indexOf('const phoneGhost = await session.evaluate');

  assert.ok(previewEntry >= 0);
  assert.ok(openCategories > previewEntry);
  assert.ok(categoryMenu > openCategories);
  assert.ok(selectView > categoryMenu);
  assert.ok(viewDeck > selectView);
  assert.ok(selectEditor > viewDeck);
  assert.ok(editWorkspace > selectEditor);
  assert.ok(geometry > editWorkspace);
  assert.ok(SURFACE_CHECK_NAMES.includes(
    'service phone public marketing document opens in Preview with View selected',
  ));
});

test('phone Option 2 contract has one picker, one scrolling deck, and persistent modes', () => {
  assert.match(phoneFlow, /phone-ribbon-tabs'\)\) === 0/);
  assert.doesNotMatch(phoneFlow, /phone-ribbon-tabs \[role="tab"\]/);
  assert.match(phoneFlow, /\.phone-category-trigger/);
  assert.match(phoneFlow, /#phone-ribbon-categories/);
  assert.match(phoneFlow, /categoryPicker\.ids\.includes\('home'\)/);
  assert.match(phoneFlow, /\[data-ribbon-tab="view"\]/);
  assert.match(phoneFlow, /\[data-ribbon-tab\]\[aria-pressed="true"\]/);
  assert.match(phoneFlow, /\.phone-mode-switch \[data-command-id="view\.editor"\]/);
  assert.match(phoneFlow, /\.phone-mode-switch \[data-command-id="view\.preview"\]/);
  assert.match(phoneFlow, /duplicateModes === 0/);
  assert.match(phoneFlow, /horizontalScrollers\[0\] === 'phone-ribbon-deck'/);
  assert.ok(SURFACE_CHECK_NAMES.includes(
    'phone View deck owns horizontal scrolling without duplicate mode commands',
  ));
});

test('phone surface proves the ghost command, dialog controls, and persisted switch', () => {
  const defaultOn = phoneFlow.indexOf('phone View deck exposes the default-on ghost overlay command');
  const invoke = phoneFlow.indexOf(
    "await session.click('.phone-ribbon-deck [data-command-id=\"view.ghost-overlay\"]')",
  );
  const dialog = phoneFlow.indexOf("await session.waitForSelector('[role=\"dialog\"] .ghost-overlay-dialog'");
  const left = phoneFlow.indexOf(
    "await session.click('[role=\"dialog\"] .ghost-overlay-halves button:first-child')",
  );
  const right = phoneFlow.indexOf(
    "await session.click('[role=\"dialog\"] .ghost-overlay-halves button:last-child')",
  );
  const switchOff = phoneFlow.indexOf(
    "await session.click('[role=\"dialog\"] .ghost-overlay-switch input[role=\"switch\"]')",
  );
  const persistedOff = phoneFlow.indexOf('the disabled phone ghost preference to persist');
  const switchOn = phoneFlow.indexOf(
    "await session.click('[role=\"dialog\"] .ghost-overlay-switch input[role=\"switch\"]')",
    switchOff + 1,
  );
  const persistedOn = phoneFlow.indexOf('the enabled phone ghost preference to persist');

  assert.ok(defaultOn >= 0);
  assert.ok(invoke > defaultOn);
  assert.ok(dialog > invoke);
  assert.ok(left > dialog);
  assert.ok(right > left);
  assert.ok(switchOff > right);
  assert.ok(persistedOff > switchOff);
  assert.ok(switchOn > persistedOff);
  assert.ok(persistedOn > switchOn);
  assert.match(phoneFlow, /Rendered Markdown ghost/);
  assert.match(phoneFlow, /Ghost overlay, On/);
  assert.match(phoneFlow, /Ghost overlay, Off/);
  assert.match(phoneFlow, /marks:ui-preferences:v1/);
  assert.ok(SURFACE_CHECK_NAMES.includes(
    'phone ghost dialog moves the rendered page with accessible half controls',
  ));
  assert.ok(SURFACE_CHECK_NAMES.includes('phone ghost switch persists an explicit off preference'));
});

test('phone state changes use bounded DOM and page-state waits instead of timing sleeps', () => {
  assert.doesNotMatch(phoneFlow, /session\.wait\(\d+\)/);
  assert.match(phoneFlow, /workspace\.mode-preview/);
  assert.match(phoneFlow, /workspace\.mode-edit\.phone-ghost/);
  assert.match(phoneFlow, /waitForAbsent\(session, '#phone-ribbon-categories'/);
  assert.match(phoneFlow, /waitForPageState\(/);
  assert.match(phoneFlow, /timeout: 10_000/);
  assert.doesNotMatch(phoneFlow, /More commands|phone More/);
});

test('service mobile proof follows the same Option 2 DOM contract', () => {
  assert.notEqual(touchStart, -1);
  assert.match(touchFlow, /phone-ribbon-tabs'\)\.count\(\), 0/);
  assert.match(touchFlow, /\.phone-category-trigger/);
  assert.match(touchFlow, /#phone-ribbon-categories/);
  assert.match(touchFlow, /\[data-ribbon-tab="view"\]/);
  assert.match(touchFlow, /\.phone-mode-switch \[data-command-id="view\.editor"\]/);
  assert.match(touchFlow, /\.phone-mode-switch \[data-command-id="view\.preview"\]/);
  assert.match(touchFlow, /data-command-id="view\.ghost-overlay"/);
  assert.match(touchFlow, /Rendered Markdown ghost/);
  assert.doesNotMatch(touchFlow, /getByRole\('tab'|waitForTimeout/);
});
