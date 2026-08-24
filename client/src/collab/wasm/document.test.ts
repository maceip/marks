import assert from 'node:assert/strict';
import test from 'node:test';
import { applyTextEdits, type TextEdit } from '../../text/change.ts';
import { EsbtDocument } from './esbt-document.ts';
import { MARKS_DOCUMENT_CONFIG, marksSiteToEngine } from './index.ts';
import { createTestRuntime } from './test-runtime.ts';
import {
  captureSelectionPresence,
  remoteSelections,
} from '../presence-position.ts';
import { encodeSelectionPresence } from '../protocol.ts';

test('two configured component replicas converge and batch one transaction', async () => {
  const runtime = await createTestRuntime();
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
  const runtime = await createTestRuntime();
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

test('presence identities are deterministic across concurrent edits and offline merge', async () => {
  const runtime = await createTestRuntime();
  const left = await EsbtDocument.create({
    runtime, siteId: marksSiteToEngine('31'), config: MARKS_DOCUMENT_CONFIG,
  });
  const right = await EsbtDocument.create({
    runtime, siteId: marksSiteToEngine('32'), config: MARKS_DOCUMENT_CONFIG,
  });
  const seed = left.insert(0, 'abcdef')!;
  right.applyUpdate(seed);

  // Reversed selection direction survives independently of sorted decoration bounds.
  const reversed = captureSelectionPresence(left, 5, 2, 1);
  assert.equal(reversed.direction, 'backward');
  assert.deepEqual(left.resolvePresencePosition(reversed), { anchor: 5, head: 2 });

  // Concurrent insertion before and exactly at a caret uses explicit `before`
  // affinity, giving a deterministic caret after both inserted runs.
  const caret = captureSelectionPresence(left, 3, 3, 2);
  const before = right.insert(1, 'B')!;
  const exact = right.insert(4, 'X')!;
  left.applyUpdate(before);
  left.applyUpdate(exact);
  assert.deepEqual(left.resolvePresencePosition(caret), { anchor: 5, head: 5 });

  // Deleting through the identity collapses both endpoints safely.
  const containing = captureSelectionPresence(left, 3, 5, 3);
  const deletion = right.delete(2, 4)!;
  left.applyUpdate(deletion);
  const collapsed = left.resolvePresencePosition(containing);
  assert.equal(collapsed.anchor, collapsed.head);

  // Offline edits merge in either delivery order and resolve identically.
  const offlineCaret = captureSelectionPresence(left, 1, 1, 4);
  const leftOffline = left.insert(0, 'L')!;
  const rightOffline = right.insert(right.length, 'R')!;
  left.applyUpdate(rightOffline);
  right.applyUpdate(leftOffline);
  assert.equal(left.getText(), right.getText());
  assert.deepEqual(left.resolvePresencePosition(offlineCaret), right.resolvePresencePosition(offlineCaret));

  left.destroy();
  right.destroy();
});

test('presence delivery order hides unavailable identities and retries after durable update', async () => {
  const runtime = await createTestRuntime();
  const source = await EsbtDocument.create({
    runtime, siteId: marksSiteToEngine('41'), config: MARKS_DOCUMENT_CONFIG,
  });
  const receiver = await EsbtDocument.create({
    runtime, siteId: marksSiteToEngine('42'), config: MARKS_DOCUMENT_CONFIG,
  });
  const update = source.insert(0, 'hello')!;
  const presence = captureSelectionPresence(source, 3, 3, 1);
  const states = { 'peer-cm-sel': encodeSelectionPresence(presence) };

  // Presence-before-update cannot resolve and is hidden, not clamped.
  assert.deepEqual(remoteSelections(states, 'self', receiver), []);
  receiver.applyUpdate(update);
  assert.deepEqual(remoteSelections(states, 'self', receiver).map(({ from, to }) => [from, to]), [[3, 3]]);

  // Update-before-presence resolves immediately.
  const second = await EsbtDocument.create({
    runtime, siteId: marksSiteToEngine('43'), config: MARKS_DOCUMENT_CONFIG,
  });
  second.applyUpdate(update);
  assert.equal(remoteSelections(states, 'self', second)[0]?.to, 3);

  // Compact recovery retains live identity resolution without durable presence storage.
  source.pruneHistoryThrough(source.version());
  const compact = source.exportCompactSnapshot();
  const recovered = await EsbtDocument.create({
    runtime, siteId: marksSiteToEngine('44'), config: MARKS_DOCUMENT_CONFIG,
  });
  recovered.applySnapshot(compact);
  assert.equal(remoteSelections(states, 'self', recovered)[0]?.to, 3);

  source.destroy();
  receiver.destroy();
  second.destroy();
  recovered.destroy();
});

test('Marks component accepts a compact snapshot beyond the retired 4 MiB split', async () => {
  const runtime = await createTestRuntime();
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

test('WIT visible edits preserve a single edit larger than one million UTF-16 units', async () => {
  const runtime = await createTestRuntime();
  const document = await EsbtDocument.create({
    runtime,
    siteId: marksSiteToEngine('45'),
    config: {
      ...MARKS_DOCUMENT_CONFIG,
      limits: {
        ...MARKS_DOCUMENT_CONFIG.limits,
        maxMessageBytes: 128 * 1024 * 1024,
        maxOperationsPerUpdate: 1_100_000,
        maxSnapshotItems: 1_100_000,
        maxDocumentUnits: 1_100_000,
        maxRetainedOperations: 1_100_000,
      },
    },
  });
  const inserted = 'x'.repeat(1_000_001);
  const changes: TextEdit[][] = [];
  document.onChange((change) => changes.push(change.edits));

  const update = document.insert(0, inserted);

  assert.ok(update && update.byteLength > inserted.length);
  assert.equal(document.length, 1_000_001);
  assert.equal(document.getText(), inserted);
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0]?.map(({ from, to, insert }) => [from, to, insert.length]), [
    [0, 0, 1_000_001],
  ]);
  document.destroy();
});
