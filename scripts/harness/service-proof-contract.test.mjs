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
    'anonymous root creates a unique page through /v1/documents',
    'anonymous page is public by its opaque slug on creation',
    'more than six anonymous edits mark the public page persisted',
    'copy-pasted slug admits a different anonymous editor without sharing settings',
    'isolated browser replicas converge through marks-server',
    'current service paints the remote browser caret',
    'presence bar shows both live browser connections',
    'per-peer undo removes only the second browser edit',
    'preview checkbox writes through to the editor and durable service source',
    'isolated browser peer cold-opens committed content including preview writeback',
    'current service outline reflects admitted Markdown headings',
    'current service editor scrolling moves the preview',
    'supported document drag shows the Markdown import target',
    'document drop converts and creates one populated public page',
    'browser Wasm PDF drop creates a populated public Markdown page',
    'PDF drop stays in browser Wasm and never uploads to the server',
  ]) {
    assert.match(serviceProof, new RegExp(assertion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(serviceProof, /browser\.newContext/);
  assert.doesNotMatch(serviceProof, /peerContext\.addInitScript/);
});

test('mobile and service proofs fail fast without sharing a mutable client artifact', () => {
  const mobileProof = read('scripts/check-mobile-ui.mjs');
  assert.match(mobileProof, /join\(work, 'service-dist'\)/);
  assert.match(mobileProof, /'build', '--workspace=client'.*'--outDir', staticDir, '--emptyOutDir'/s);
  assert.match(mobileProof, /VITE_MARKS_DATA_MODE: 'service'/);
  assert.match(mobileProof, /timeout: 120_000/);
  assert.match(mobileProof, /fetch\(`\$\{origin\}\/readyz`/);
  assert.match(mobileProof, /marks-server did not become ready within 15 seconds/);
  assert.match(mobileProof, /loaded data-marks-mode=\$\{mode\}/);
  assert.match(mobileProof, /function recordFatal\(error\)/);
  assert.match(mobileProof, /server\.signalCode/);
  assert.match(mobileProof, /Math\.min\(1_000, remaining\)/);
  assert.match(mobileProof, /server\.kill\('SIGKILL'\)/);
  assert.match(mobileProof, /await stop\(\)/);
  assert.doesNotMatch(mobileProof, /process\.exit\(/);
  assert.doesNotMatch(mobileProof, /join\(root, 'client', 'dist'\)/);

  const serviceProof = read('scripts/ci-service-ui.mjs');
  assert.match(serviceProof, /service proof loaded data-marks-mode=/);
  assert.match(serviceProof, /rebuild with VITE_MARKS_DATA_MODE=service/);
});

test('anonymous and copied-slug failures leave opening shells with a retry surface', () => {
  const app = read('client/src/App.tsx');
  const sessionHook = read('client/src/hooks/useSession.ts');
  const caller = read('client/src/auth/caller.ts');
  const pendingDevice = read('client/src/auth/pending-device.ts');
  const api = read('client/src/lib/api.ts');
  const roomAccess = read('client/src/auth/room-access.ts');
  const engine = read('client/src/collab/esbt-engine.ts');
  const journal = read('client/src/collab/journal.ts');
  const network = read('client/src/browser/network.ts');
  const metadata = read('client/src/hooks/useDocumentMeta.ts');

  assert.match(caller, /SERVICE_REQUEST_TIMEOUT_MS/);
  assert.match(pendingDevice, /fetchWithTimeout/);
  assert.match(api, /IMPORT_REQUEST_TIMEOUT_MS/);
  assert.match(roomAccess, /fetchWithTimeout/);
  assert.match(network, /await response\.arrayBuffer\(\)/);
  assert.match(network, /Promise\.race\(\[completed, aborted\]\)/);
  assert.match(sessionHook, /setError\(error instanceof Error/);
  assert.match(metadata, /setError\('Marks could not reach the document service in time\.'/);
  assert.match(app, /Page could not open/);
  assert.match(app, /Document connection failed/);
  assert.match(app, /Try again/);
  assert.ok(
    app.indexOf('metadataError || sessionError') < app.indexOf('resolved && !supported'),
    'transport failures render before authoritative unavailable documents',
  );
  assert.match(app, /ensureServiceCaller\(\{ forceProbe: true \}\)[\s\S]*?setServiceCallerError/);
  assert.match(journal, /runWithTimeout\([\s\S]*?read\(docId\)/);
  assert.match(engine, /openWithReplicaJournal\(options\.docId,[\s\S]*?new EsbtEngine/);
  assert.match(engine, /void deleteReplicaJournal\(this\.docId\)\.catch/);
  assert.doesNotMatch(engine, /await deleteReplicaJournal\(this\.docId\)/);
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
