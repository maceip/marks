import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EDITOR_CHUNK_UNITS,
  JOURNAL_RETAINED_THRESHOLD,
  MARKS_DOCUMENT_CONFIG,
  MARKS_MAX_FRAME_BYTES,
  MARKS_SERVER_COMPACT_OPERATIONS,
} from './profile.ts';

test('shared profile covers envelope overhead and compacts below retained bounds', () => {
  const limits = MARKS_DOCUMENT_CONFIG.limits!;
  assert.ok(MARKS_MAX_FRAME_BYTES >= limits.maxMessageBytes! + 27);
  assert.ok(MARKS_SERVER_COMPACT_OPERATIONS <= limits.maxRetainedOperations!);
  assert.ok(JOURNAL_RETAINED_THRESHOLD <= limits.maxRetainedOperations!);
  assert.ok(EDITOR_CHUNK_UNITS * 2 <= limits.maxOperationsPerUpdate!);
  assert.equal(limits.maxDocumentUnits, 1_000_000);
});
