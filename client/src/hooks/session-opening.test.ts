import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openSessionWithTimeout } from './session-opening.ts';

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

test('session opening times out even when the lazy module load ignores cancellation', async () => {
  await assert.rejects(
    openSessionWithTimeout(
      () => new Promise(() => undefined),
      { timeoutMs: 5 },
    ),
    (error: unknown) => error instanceof DOMException && error.name === 'TimeoutError',
  );
});

test('a session constructed after its deadline is destroyed', async () => {
  const construction = deferred<{ destroy(): void }>();
  let destroyed = 0;
  const opening = openSessionWithTimeout(
    async () => () => construction.promise,
    { timeoutMs: 5 },
  );

  await assert.rejects(opening, (error: unknown) =>
    error instanceof DOMException && error.name === 'TimeoutError');
  construction.resolve({ destroy: () => { destroyed += 1; } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(destroyed, 1);
});

test('caller cancellation bounds session opening', async () => {
  const controller = new AbortController();
  const opening = openSessionWithTimeout(
    () => new Promise(() => undefined),
    { timeoutMs: 1_000, signal: controller.signal },
  );
  controller.abort(new DOMException('route changed', 'AbortError'));
  await assert.rejects(opening, (error: unknown) =>
    error instanceof DOMException && error.name === 'AbortError');
});
