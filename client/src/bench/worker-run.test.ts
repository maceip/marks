import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BenchMessage } from './types.ts';
import {
  superviseBenchmarkWorker,
  type BenchmarkWorkerLike,
} from './worker-run.ts';

class FakeWorker implements BenchmarkWorkerLike {
  onmessage: ((event: MessageEvent<BenchMessage>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null = null;
  terminations = 0;

  terminate(): void {
    this.terminations += 1;
  }
}

function callbacks(worker: FakeWorker, timeoutMs = 1_000): {
  failures: string[];
  done: string[];
  supervisor: ReturnType<typeof superviseBenchmarkWorker>;
} {
  const failures: string[] = [];
  const done: string[] = [];
  const supervisor = superviseBenchmarkWorker(worker, {
    timeoutMs,
    onMessage: () => undefined,
    onDone: () => done.push('done'),
    onFailure: (message) => failures.push(message),
  });
  return { failures, done, supervisor };
}

test('a silent benchmark worker is terminated at its deadline', async () => {
  const worker = new FakeWorker();
  const { failures } = callbacks(worker, 5);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(worker.terminations, 1);
  assert.match(failures[0] ?? '', /took too long/iu);
});

test('worker error messages terminate the run and surface a retryable failure', () => {
  const worker = new FakeWorker();
  const { failures } = callbacks(worker);
  worker.onmessage?.({ data: { type: 'error', message: 'compile failed' } } as MessageEvent<BenchMessage>);
  assert.deepEqual(failures, ['compile failed']);
  assert.equal(worker.terminations, 1);
});

test('message transport failures and completion are terminal exactly once', () => {
  const broken = new FakeWorker();
  const first = callbacks(broken);
  broken.onmessageerror?.({} as MessageEvent<unknown>);
  first.supervisor.fail('late');
  assert.equal(broken.terminations, 1);
  assert.deepEqual(first.failures, ['The benchmark worker returned an unreadable result.']);

  const complete = new FakeWorker();
  const second = callbacks(complete);
  complete.onmessage?.({ data: { type: 'done' } } as MessageEvent<BenchMessage>);
  second.supervisor.cancel();
  assert.equal(complete.terminations, 1);
  assert.deepEqual(second.done, ['done']);
  assert.deepEqual(second.failures, []);
});
