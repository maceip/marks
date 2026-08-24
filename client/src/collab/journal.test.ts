import assert from 'node:assert/strict';
import test from 'node:test';
import 'fake-indexeddb/auto';
import {
  JOURNAL_PRUNE_INTERVAL_MS,
  JOURNAL_RETAINED_THRESHOLD,
  acknowledgePendingMutation,
  appendPendingMutation,
  appendMutation,
  checkpointReplicaJournal,
  readReplicaJournal,
  shouldPruneHistory,
  type ReplicaJournalRecord,
} from './journal.ts';

let nextDocument = 1;

function docId(): string {
  return `journal-race-${nextDocument++}`;
}

function record(): ReplicaJournalRecord {
  return {
    version: 3,
    siteId: '2',
    role: 'editor',
    snapshot: new Uint8Array([1]),
    pending: [],
    ackedVersion: null,
    committedRevision: null,
    lastPruneAt: 0,
  };
}

test('journal append is immutable and preserves a stable mutation id', () => {
  const current = record();
  const next = appendMutation(current, {
    id: '01010101010101010101010101010101',
    kind: 'update',
    bytes: new Uint8Array([2, 3]),
    createdAt: 4,
  });
  assert.equal(current.pending.length, 0);
  assert.equal(next.pending.length, 1);
  assert.deepEqual([...next.pending[0].bytes], [2, 3]);
  assert.equal(next.pending[0].id, '01010101010101010101010101010101');
});

test('journal persists the last authorized offline role', async () => {
  const id = docId();
  await checkpointReplicaJournal(id, record(), () => new Uint8Array([9]));
  assert.equal((await readReplicaJournal(id))?.role, 'editor');
});

test('one mutation id cannot be rebound to different bytes', () => {
  const mutation = {
    id: '01010101010101010101010101010101',
    kind: 'update' as const,
    bytes: new Uint8Array([2]),
    createdAt: 4,
  };
  const once = appendMutation(record(), mutation);
  assert.equal(appendMutation(once, mutation), once);
  assert.throws(
    () => appendMutation(once, { ...mutation, bytes: new Uint8Array([3]) }),
    /reused/,
  );
});

test('compaction runs at the retained-ops threshold or after the idle interval', () => {
  assert.equal(shouldPruneHistory(0, 0, 0), false);
  assert.equal(shouldPruneHistory(JOURNAL_RETAINED_THRESHOLD, 1, 1), false);
  assert.equal(shouldPruneHistory(JOURNAL_RETAINED_THRESHOLD + 1, 0, 0), true);
  assert.equal(shouldPruneHistory(10, 1, 1 + JOURNAL_PRUNE_INTERVAL_MS + 1), true);
});

test('concurrent IndexedDB appends lose no mutations', async () => {
  const id = docId();
  const mutations = Array.from({ length: 64 }, (_, index) => ({
    id: (index + 1).toString(16).padStart(32, '0'),
    kind: 'update' as const,
    bytes: new Uint8Array([index]),
    createdAt: index,
  }));
  await Promise.all(mutations.map((mutation) => appendPendingMutation(id, record(), mutation)));
  const stored = await readReplicaJournal(id);
  assert.equal(stored?.pending.length, mutations.length);
  assert.deepEqual(
    stored?.pending.map((mutation) => mutation.id),
    mutations.map((mutation) => mutation.id),
  );
});

test('checkpoint and append serialize while preserving both snapshot and tail', async () => {
  const id = docId();
  const mutation = {
    id: 'abababababababababababababababab',
    kind: 'update' as const,
    bytes: new Uint8Array([7]),
    createdAt: 1,
  };
  await Promise.all([
    checkpointReplicaJournal(id, record(), () => new Uint8Array([9])),
    appendPendingMutation(id, record(), mutation),
  ]);
  const stored = await readReplicaJournal(id);
  assert.deepEqual([...stored!.snapshot], [9]);
  assert.deepEqual(stored!.pending.map((item) => item.id), [mutation.id]);
});

test('commit receipt checkpoints state and removes only its matching retry', async () => {
  const id = docId();
  const first = {
    id: '11111111111111111111111111111111',
    kind: 'update' as const,
    bytes: new Uint8Array([1]),
    createdAt: 1,
  };
  const second = { ...first, id: '22222222222222222222222222222222', bytes: new Uint8Array([2]) };
  await appendPendingMutation(id, record(), first);
  await appendPendingMutation(id, record(), second);
  await acknowledgePendingMutation(
    id,
    record(),
    first.id,
    new Uint8Array([4]),
    19n,
    () => new Uint8Array([8]),
  );
  const stored = await readReplicaJournal(id);
  assert.deepEqual([...stored!.snapshot], [8]);
  assert.deepEqual(stored!.pending.map((item) => item.id), [second.id]);
  assert.deepEqual([...stored!.ackedVersion!], [4]);
  assert.equal(stored!.committedRevision, '19');
});
