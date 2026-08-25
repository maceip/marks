import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pollPairingUntilSettled } from './pairing-poll.ts';

test('pairing polling has at most one request in flight', async () => {
  let clock = 0;
  let calls = 0;
  let inFlight = 0;
  let maximum = 0;
  const session = { sessionId: 'session_done' };
  const result = await pollPairingUntilSettled({
    expiresAtMs: 10_000,
    signal: new AbortController().signal,
    now: () => clock,
    sleep: async (milliseconds) => {
      clock += milliseconds;
    },
    finalize: async () => {
      calls += 1;
      inFlight += 1;
      maximum = Math.max(maximum, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return calls < 3 ? 'pending' : session;
    },
  });

  assert.equal(result, session);
  assert.equal(calls, 3);
  assert.equal(maximum, 1);
});

test('pairing polling stops at the server-issued expiry', async () => {
  let clock = 0;
  let calls = 0;
  const result = await pollPairingUntilSettled({
    expiresAtMs: 2_500,
    signal: new AbortController().signal,
    now: () => clock,
    sleep: async (milliseconds) => {
      clock += milliseconds;
    },
    finalize: async () => {
      calls += 1;
      return 'pending';
    },
  });

  assert.equal(result, 'gone');
  assert.equal(clock, 2_500);
  assert.equal(calls, 2);
});

test('closing the login dialog aborts an in-flight finalize request', async () => {
  const controller = new AbortController();
  const polling = pollPairingUntilSettled({
    expiresAtMs: Date.now() + 60_000,
    signal: controller.signal,
    finalize: (signal) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  });
  controller.abort(new DOMException('Dialog closed.', 'AbortError'));
  await assert.rejects(polling, (error: unknown) => error instanceof DOMException && error.name === 'AbortError');
});
