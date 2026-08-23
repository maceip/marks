import assert from 'node:assert/strict';
import test from 'node:test';
import {
  JOURNAL_PRUNE_INTERVAL_MS,
  JOURNAL_RETAINED_THRESHOLD,
  appendJournalUpdate,
  shouldPruneHistory,
  type ReplicaJournalRecord,
} from './journal.ts';

test('journal appends keep the previous snapshot and grow the update list', () => {
  const record: ReplicaJournalRecord = {
    version: 1,
    siteId: '2',
    snapshot: new Uint8Array([1]),
    updates: [],
    ackedVersion: null,
    lastPruneAt: 0,
  };
  const next = appendJournalUpdate(record, new Uint8Array([2, 3]));
  assert.equal(record.updates.length, 0);
  assert.equal(next.updates.length, 1);
  assert.deepEqual([...next.updates[0]], [2, 3]);
});

test('compaction runs at the retained-ops threshold or after the idle interval', () => {
  assert.equal(shouldPruneHistory(0, 0, 0), false);
  assert.equal(shouldPruneHistory(JOURNAL_RETAINED_THRESHOLD, 1, 1), false);
  assert.equal(shouldPruneHistory(JOURNAL_RETAINED_THRESHOLD + 1, 0, 0), true);
  assert.equal(shouldPruneHistory(10, 1, 1 + JOURNAL_PRUNE_INTERVAL_MS + 1), true);
});
