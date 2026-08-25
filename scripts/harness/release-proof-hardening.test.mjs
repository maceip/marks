import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const runServicePath = resolve(root, 'scripts/run-service-ci.sh');

test('service orchestration requires a ready writer and at least one real proof', () => {
  const script = read('scripts/run-service-ci.sh');
  assert.match(script, /wait-for-server\.sh" "\$URL\/readyz"/);
  assert.match(script, /--skip-ui and --skip-collab would run no proof/);
  assert.match(script, /--url cannot be combined with --bin, --static-dir, or --listen/);
  assert.match(script, /ci-welcome-ui\.mjs" --url "\$URL"/);
  assert.match(script, /\[ "\$BROWSER" = "chromium" \]/);
  assert.match(script, /ui=\$UI_RESULT, welcome=\$WELCOME_RESULT, native-collab=\$COLLAB_RESULT/);
});

test('service orchestration rejects a zero-proof or ambiguous invocation before networking', () => {
  const zeroProof = spawnSync(
    'bash',
    [runServicePath, '--url', 'http://127.0.0.1:9', '--skip-ui', '--skip-collab'],
    { encoding: 'utf8' },
  );
  assert.equal(zeroProof.status, 2);
  assert.match(zeroProof.stderr, /would run no proof/);
  assert.doesNotMatch(zeroProof.stdout, /checks passed/);

  const ambiguous = spawnSync(
    'bash',
    [runServicePath, '--url', 'http://127.0.0.1:9', '--bin', '/tmp/not-used'],
    { encoding: 'utf8' },
  );
  assert.equal(ambiguous.status, 2);
  assert.match(ambiguous.stderr, /--url cannot be combined/);
});

test('browser proof bounds recovery waits and publishes receipts only after success', () => {
  const script = read('scripts/ci-service-ui.mjs');
  const marketingWaitStart = script.indexOf("await page.waitForSelector('.cm-content'");
  const marketingWait = script.slice(
    marketingWaitStart,
    script.indexOf('const initialExport', marketingWaitStart),
  );
  assert.match(script, /waitForServiceWorkerController\(page\)/);
  assert.match(script, /service worker did not become ready and control the page within/);
  assert.match(script, /reload recovery evidence unavailable/);
  assert.match(script, /timed out reading IndexedDB recovery evidence/);
  assert.match(script, /requireCheck\(/);
  assert.match(script, /if \(receiptPath\) rmSync\(receiptPath, \{ force: true \}\)/);
  assert.match(script, /writeReceiptAtomically\(receiptPath, pendingReceipt\)/);
  assert.match(marketingWait, /getAttribute\('data-marketing'\) === 'true'/);
  assert.match(marketingWait, /querySelector\('\.marks-preview'\)\?\.innerText/);
  assert.match(marketingWait, /timeout: 30_000/);
  assert.ok(
    script.indexOf('const failed = results.filter') <
      script.indexOf('writeReceiptAtomically(receiptPath, pendingReceipt)'),
    'receipt publication must follow the final failed-check calculation',
  );
});

test('anonymous marketing identity survives the creation and metadata handoff', () => {
  const app = read('client/src/App.tsx');
  const identityStart = app.indexOf('const metadataIdentifiesMarketingDocument');
  const identity = app.slice(identityStart, app.indexOf('const { session', identityStart));
  const presentationEffectStart = app.indexOf("useEffect(() => {\n    if (!marketingPresentationKey)");
  const presentationEffect = app.slice(
    presentationEffectStart,
    app.indexOf("\n\n  useEffect(() => {\n    localStorage.setItem('marks:ribbon-collapsed'", presentationEffectStart),
  );
  const starter = app.slice(
    app.indexOf('.then(({ created, createScope, requestId, confirmRequest })'),
    app.indexOf("\n      .catch(() => {", app.indexOf('.then(({ created, createScope, requestId, confirmRequest })')),
  );

  assert.match(identity, /knownMarketingDocumentId === docId/);
  assert.match(starter, /setKnownMarketingDocumentId\(created\.id\)[\s\S]*navigate\(/);
  assert.match(presentationEffect, /if \(!marketingPresentationKey\) return;/);
  assert.doesNotMatch(presentationEffect, /setPreparedMarketingPresentation\(null\)/);
});

test('mobile proof waits for the complete marketing presentation before inspecting it', () => {
  const script = read('scripts/check-mobile-ui.mjs');
  const readinessStart = script.indexOf('Promise.all([');
  const readiness = script.slice(readinessStart, script.indexOf('await assertNoHorizontalOverflow', readinessStart));
  assert.match(readiness, /getAttribute\('data-marketing'\) === 'true'/);
  assert.match(readiness, /querySelector\('\.marks-preview'\)\?\.innerText/);
  assert.match(readiness, /classList\.contains\('mode-preview'\)/);
  assert.match(readiness, /timeout: 30_000/);
});

test('welcome corruption injection is bounded and abort-aware', () => {
  const script = read('scripts/ci-welcome-ui.mjs');
  assert.match(script, /transaction\.onabort/);
  assert.match(script, /timed out after \$\{timeoutMs\}ms writing the incompatible welcome snapshot/);
  assert.match(script, /request\.onblocked/);
  assert.match(script, /}, 10_000\);/);
});

test('each readiness request is shorter than the outer startup deadline', () => {
  const script = read('scripts/wait-for-server.sh');
  assert.match(script, /--connect-timeout "\$request_timeout"/);
  assert.match(script, /--max-time "\$request_timeout"/);
  assert.match(script, /remaining=\$\(\(deadline - SECONDS\)\)/);
});
