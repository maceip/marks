import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchWithTimeout, runWithTimeout, snapshotFetchTimeoutMs } from './network.ts';

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

test('service fetches keep the deadline through a stalled response body', async () => {
  const headersOnlyFetch: typeof fetch = async () => new Response(
    new ReadableStream({
      pull() {
        return new Promise(() => undefined);
      },
    }),
  );
  await assert.rejects(
    fetchWithTimeout('/headers-only', {}, 5, headersOnlyFetch),
    (error: unknown) => error instanceof DOMException && error.name === 'TimeoutError',
  );
});

test('service fetches return a replayable bounded response body', async () => {
  const response = await fetchWithTimeout(
    '/complete',
    {},
    1_000,
    async () => Response.json({ ready: true }, { status: 201, headers: { 'X-Proof': 'bounded' } }),
  );
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('X-Proof'), 'bounded');
  assert.deepEqual(await response.json(), { ready: true });
});

test('generic browser work rejects even when the operation ignores its signal', async () => {
  await assert.rejects(
    runWithTimeout(() => new Promise(() => undefined), 5),
    (error: unknown) => error instanceof DOMException && error.name === 'TimeoutError',
  );
});
