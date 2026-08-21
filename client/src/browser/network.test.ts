import assert from 'node:assert/strict';
import { test } from 'node:test';
import { snapshotFetchTimeoutMs } from './network.ts';

test('offline snapshot fetch does not wait', () => {
  assert.equal(snapshotFetchTimeoutMs('offline', true), 0);
});

test('slow networks give up sooner when a local copy already painted', () => {
  const withLocal = snapshotFetchTimeoutMs('slow', true);
  const without = snapshotFetchTimeoutMs('slow', false);
  const online = snapshotFetchTimeoutMs('online', false);
  assert.ok(withLocal < without);
  assert.ok(without < online);
});
