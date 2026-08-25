import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { SURFACE_CHECK_NAMES } from './suites/surface.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const source = readFileSync(resolve(root, 'scripts/harness/suites/surface.mjs'), 'utf8');
const phoneStart = source.indexOf('await session.goto(`${documentPath}?marks-posture=phone`)');
const phoneFlow = source.slice(phoneStart, source.indexOf('\n}\n\nexport const SURFACE_CHECK_NAMES', phoneStart));

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

test('phone surface proof enters the editor before measuring ghost geometry', () => {
  assert.notEqual(phoneStart, -1);

  const previewEntry = phoneFlow.indexOf(
    'service phone public marketing document opens in Preview with Import selected',
  );
  const viewDeck = phoneFlow.indexOf(
    '.phone-ribbon-deck[aria-label="View commands"] [data-command-id="view.editor"]',
  );
  const selectEditor = phoneFlow.indexOf(
    "await session.click('.phone-ribbon [data-command-id=\"view.editor\"]')",
  );
  const editWorkspace = phoneFlow.indexOf('.workspace.mode-edit.phone-ghost .editor-pane .cm-content');
  const geometry = phoneFlow.indexOf('const phoneGhost = await session.evaluate');

  assert.ok(previewEntry >= 0);
  assert.ok(viewDeck > previewEntry);
  assert.ok(selectEditor > viewDeck);
  assert.ok(editWorkspace > selectEditor);
  assert.ok(geometry > editWorkspace);
  assert.ok(SURFACE_CHECK_NAMES.includes(
    'service phone public marketing document opens in Preview with Import selected',
  ));
});

test('phone state changes use bounded DOM waits instead of timing sleeps', () => {
  assert.doesNotMatch(phoneFlow, /session\.wait\(\d+\)/);
  assert.match(phoneFlow, /workspace\.mode-preview/);
  assert.match(phoneFlow, /workspace\.mode-edit\.phone-ghost/);
  assert.match(phoneFlow, /phone-ribbon-deck\[aria-label="More commands"\]/);
});
