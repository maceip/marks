import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchWithTimeout, snapshotFetchTimeoutMs } from './network.ts';

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

const stalledFetch: typeof fetch = (_input, init) => new Promise((_, reject) => {
  const signal = init?.signal;
  if (signal?.aborted) {
    reject(signal.reason);
    return;
  }
  signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
});

test('service fetches reject at their own deadline', async () => {
  await assert.rejects(
    fetchWithTimeout('/stalled', {}, 5, stalledFetch),
    (error: unknown) => error instanceof DOMException && error.name === 'TimeoutError',
  );
});

test('service fetches preserve caller cancellation', async () => {
  const controller = new AbortController();
  const request = fetchWithTimeout('/cancelled', { signal: controller.signal }, 1_000, stalledFetch);
  controller.abort(new DOMException('caller stopped', 'AbortError'));
  await assert.rejects(
    request,
    (error: unknown) => error instanceof DOMException && error.name === 'AbortError',
  );
});
