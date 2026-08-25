import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
  childIsRunning,
  terminateChildAndCleanup,
} from './child-lifecycle.mjs';

class FakeChild extends EventEmitter {
  exitCode = null;
  signalCode = null;
  signals = [];

  constructor(onSignal) {
    super();
    this.onSignal = onSignal;
  }

  kill(signal) {
    this.signals.push(signal);
    this.onSignal?.(signal, this);
    return true;
  }

  reap(signal) {
    this.signalCode = signal;
    this.emit('exit', null, signal);
  }
}

test('mobile proof cleanup runs only after graceful child reaping', async () => {
  const child = new FakeChild((signal, target) => {
    if (signal === 'SIGTERM') queueMicrotask(() => target.reap(signal));
  });
  let cleaned = false;

  await terminateChildAndCleanup(child, () => {
    assert.equal(childIsRunning(child), false);
    cleaned = true;
  }, { termTimeoutMs: 10, killTimeoutMs: 10 });

  assert.equal(cleaned, true);
  assert.deepEqual(child.signals, ['SIGTERM']);
});

test('mobile proof escalates to SIGKILL and waits for reaping before cleanup', async () => {
  const child = new FakeChild((signal, target) => {
    if (signal === 'SIGKILL') queueMicrotask(() => target.reap(signal));
  });
  let cleaned = false;

  await terminateChildAndCleanup(child, () => {
    assert.equal(childIsRunning(child), false);
    cleaned = true;
  }, { termTimeoutMs: 2, killTimeoutMs: 10 });

  assert.equal(cleaned, true);
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
});

test('mobile proof preserves its temp state when SIGKILL is not reaped', async () => {
  const child = new FakeChild();
  let cleaned = false;

  await assert.rejects(
    terminateChildAndCleanup(child, () => {
      cleaned = true;
    }, { termTimeoutMs: 2, killTimeoutMs: 2 }),
    /did not terminate after SIGTERM and SIGKILL/,
  );

  assert.equal(cleaned, false);
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
});
