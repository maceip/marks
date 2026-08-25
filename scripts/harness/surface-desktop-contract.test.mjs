import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const source = readFileSync(resolve(root, 'scripts/harness/suites/surface.mjs'), 'utf8');
const desktopStart = source.indexOf('export async function runSurface');
const phoneStart = source.indexOf('await session.goto(`${documentPath}?marks-posture=phone`)');
const desktopFlow = source.slice(desktopStart, phoneStart);

test('service login restores the active Start tab before checking registry controls', () => {
  const closeLogin = desktopFlow.indexOf("await session.click('[role=\"dialog\"] button[aria-label=\"Close\"]')");
  const restoreStart = desktopFlow.indexOf(
    "await session.click('.ribbon-tab[data-ribbon-tab=\"import\"]')",
  );
  const registryCounts = desktopFlow.indexOf('const registryCounts = {');
  const registryCheck = desktopFlow.indexOf("check('desktop ribbon is registry-driven'");

  assert.ok(closeLogin >= 0, 'desktop service proof must close the login dialog');
  assert.ok(restoreStart > closeLogin, 'the Start tab must be restored after closing login');
  assert.ok(registryCounts > restoreStart, 'registry counts must be collected after restoring Start');
  assert.ok(registryCheck > registryCounts);
  assert.match(
    desktopFlow.slice(registryCounts, registryCheck + 300),
    /JSON\.stringify\(registryCounts\)/u,
    'a failed live assertion must report both observed command counts',
  );
});

test('fold-book command transitions wait for committed ribbon state and expose overflow commands', () => {
  const bookStart = desktopFlow.indexOf('await session.goto(`${documentPath}?marks-posture=fold-book`)');
  const bookEnd = desktopFlow.indexOf('// Reproduce the narrow unfolded book geometry', bookStart);
  const bookFlow = desktopFlow.slice(bookStart, bookEnd);

  assert.match(bookFlow, /\.workspace\.mode-split/);
  assert.match(bookFlow, /\.ribbon-body\[data-ribbon-task="compose"\]/);
  assert.match(bookFlow, /data-ribbon-tab="home"\]\[aria-selected="true"\]/);
  assert.match(bookFlow, /\.workspace\.mode-preview/);
  assert.match(bookFlow, /\.ribbon-body\[data-ribbon-task="inspect"\]/);
  assert.match(bookFlow, /data-ribbon-tab="review"\]\[aria-selected="true"\]/);
  assert.match(bookFlow, /\.foldable-ribbon \.ribbon-overflow-trigger/);
  assert.match(bookFlow, /all five book-fold possibility commands/);
  assert.doesNotMatch(bookFlow, /session\.wait\(\d+\)/);
});
