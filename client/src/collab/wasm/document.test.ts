import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { applyTextEdits, type TextEdit } from '../../text/change.ts';
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
  const localEdits: TextEdit[][] = [];
  const remoteEdits: TextEdit[][] = [];
  left.onLocalUpdate((update) => emitted.push(update));
  left.onChange((change) => localEdits.push(change.edits));
  right.onChange((change) => remoteEdits.push(change.edits));
  left.transact(() => {
    left.insert(0, 'Hel');
    left.insert(3, 'lo');
  });
  assert.equal(emitted.length, 1);
  right.import(emitted[0]);
  assert.deepEqual(localEdits, [[{ from: 0, to: 0, insert: 'Hello' }]]);
  assert.deepEqual(remoteEdits, localEdits);
  assert.equal(applyTextEdits('', remoteEdits[0]), 'Hello');
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

test('persisted anchors follow their identities through edits', async () => {
  const bytes = await readFile(wasmPath);
  const runtime = await EsbtRuntime.fromBytes(bytes);
  const document = await EsbtDocument.create({
    runtime,
    siteId: marksSiteToEngine('22'),
    config: MARKS_DOCUMENT_CONFIG,
  });
  document.insert(0, 'abcdef');
  const start = document.indexToAnchor(2, 'after');
  const end = document.indexToAnchor(4, 'before');
  assert.deepEqual([document.anchorToIndex(start), document.anchorToIndex(end)], [2, 4]);

  document.insert(0, 'XX');
  assert.equal(document.getText().slice(document.anchorToIndex(start), document.anchorToIndex(end)), 'cd');

  document.delete(document.anchorToIndex(start), 2);
  assert.equal(document.anchorToIndex(start), document.anchorToIndex(end));
  document.destroy();
});

test('Marks Wasm accepts a compact snapshot beyond the retired 4 MiB split', async () => {
  const bytes = await readFile(wasmPath);
  const runtime = await EsbtRuntime.fromBytes(bytes);
  const source = await EsbtDocument.create({
    runtime,
    siteId: marksSiteToEngine('20'),
    config: MARKS_DOCUMENT_CONFIG,
  });
  const chunk = 'x'.repeat(25_000);
  for (let offset = 0; offset < 350_000; offset += chunk.length) {
    source.insert(source.length, chunk);
    source.pruneHistoryThrough(source.version());
  }
  const snapshot = source.exportCompactSnapshot();
  assert.ok(snapshot.byteLength > 4 * 1024 * 1024, `snapshot was ${snapshot.byteLength}`);

  const restored = await EsbtDocument.create({
    runtime,
    siteId: marksSiteToEngine('21'),
    config: MARKS_DOCUMENT_CONFIG,
  });
  restored.applySnapshot(snapshot);
  assert.equal(restored.length, 350_000);
  assert.equal(restored.getText().length, 350_000);
  source.destroy();
  restored.destroy();
});
