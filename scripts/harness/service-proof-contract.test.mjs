import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');

test('the repository exposes only current browser and service proof commands', () => {
  const packageJson = JSON.parse(read('package.json'));
  assert.equal(existsSync(resolve(root, 'scripts/smoke.mjs')), false);
  assert.equal(Object.hasOwn(packageJson.scripts, 'smoke'), false);
  assert.equal(
    packageJson.scripts['smoke:platforms'],
    'node scripts/harness/run.mjs --driver=all',
  );

  const publicContracts = [
    read('README.md'),
    read('docs/TEST-HARNESS.md'),
    read('docs/PRESENCE-TEST-MATRIX.md'),
    read('scripts/harness/run.mjs'),
    read('scripts/harness/suites/surface.mjs'),
    read('.github/workflows/ci.yml'),
    read('.github/workflows/scheduled-service-smoke.yml'),
  ].join('\n');
  assert.doesNotMatch(publicContracts, /scripts\/smoke\.mjs/);
  assert.doesNotMatch(publicContracts, /npm run smoke(?!:)/);
  assert.doesNotMatch(publicContracts, /pre-auth|retained legacy|legacy smoke/i);
});

test('the current service proof owns the migrated two-browser scenarios', () => {
  const serviceProof = read('scripts/ci-service-ui.mjs');
  for (const assertion of [
    'second isolated browser is admitted by current scratch authority',
    'isolated browser replicas converge through marks-server',
    'current service paints the remote browser caret',
    'presence bar shows both live browser connections',
    'per-peer undo removes only the second browser edit',
    'preview checkbox writes through to the editor and durable service source',
    'isolated browser peer cold-opens committed content including preview writeback',
    'current service outline reflects admitted Markdown headings',
    'current service editor scrolling moves the preview',
  ]) {
    assert.match(serviceProof, new RegExp(assertion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(serviceProof, /browser\.newContext/);
  assert.match(serviceProof, /peerContext\.addInitScript/);
});

test('incremental CI is conservative, gated, cached, and keeps full browser coverage', () => {
  const workflow = read('.github/workflows/ci.yml');
  assert.match(workflow, /^\s*impact:\s*$/m);
  assert.match(workflow, /node scripts\/ci-impact\.mjs/);
  assert.match(workflow, /browser: \$\{\{ fromJSON\(needs\.impact\.outputs\.browser_matrix\) \}\}/);
  assert.match(workflow, /actions\/cache@[0-9a-f]{40} # v6\./);
  assert.match(workflow, /aggregate-current/);
  assert.match(workflow, /service-current/);
  assert.match(workflow, /args\+\=\(--skip-collab\)/);
  assert.match(workflow, /^\s*gate:\s*$/m);
  assert.match(workflow, /name: CI gate/);
  assert.match(workflow, /if: always\(\)/);
  assert.match(workflow, /RUN_AGGREGATE/);
  assert.match(workflow, /RUN_SERVICE/);

  const classifier = read('scripts/ci-impact.mjs');
  assert.match(classifier, /unknown-default-full/);
  assert.match(classifier, /ci-selector-self-check/);
  assert.match(classifier, /\['chromium', 'firefox', 'webkit'\]/);
});
