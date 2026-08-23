import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { EsbtDocument, EsbtRuntime } from './esbt-document.ts';
import { MARKS_DOCUMENT_CONFIG, marksSiteToEngine } from './index.ts';

const wasmPath = join(dirname(fileURLToPath(import.meta.url)), '../../../public/esbt.wasm');

test('two configured Wasm replicas converge and batch one transaction', async () => {
  const bytes = await readFile(wasmPath);
  const runtime = await EsbtRuntime.fromBytes(bytes);
  const left = await EsbtDocument.create({
    runtime,
    siteId: marksSiteToEngine('2'),
    config: MARKS_DOCUMENT_CONFIG,
  });
  const right = await EsbtDocument.create({
    runtime,
    siteId: marksSiteToEngine('3'),
    config: MARKS_DOCUMENT_CONFIG,
  });

  const emitted: Uint8Array[] = [];
  left.onLocalUpdate((update) => emitted.push(update));
  left.transact(() => {
    left.insert(0, 'Hel');
    left.insert(3, 'lo');
  });
  assert.equal(emitted.length, 1);
  right.import(emitted[0]);
  assert.equal(left.getText(), 'Hello');
  assert.equal(right.getText(), 'Hello');

  const snapshot = left.exportFullSnapshot();
  const restored = await EsbtDocument.create({
    runtime,
    siteId: marksSiteToEngine('2'),
    config: MARKS_DOCUMENT_CONFIG,
  });
  restored.applySnapshot(snapshot);
  restored.insert(5, '!');
  assert.equal(restored.getText(), 'Hello!');
  assert.ok(left.currentDmax() > 0);
  left.destroy();
  right.destroy();
  restored.destroy();
});
