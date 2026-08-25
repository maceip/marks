import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkerSupervisor, type WorkerFailure } from './worker-supervisor.ts';

class ManualTimer {
  callback: (() => void) | null = null;

  set(callback: () => void): object {
    this.callback = callback;
    return {};
  }

  clear(): void {
    this.callback = null;
  }

  fire(): void {
    const callback = this.callback;
    this.callback = null;
    callback?.();
  }
}

class FakeWorker {
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: ErrorEvent) => unknown) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  posted: unknown[] = [];
  terminated = false;

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  respond(value: string): void {
    this.onmessage?.({ data: value } as MessageEvent<string>);
  }

  fail(message: string): boolean {
    let prevented = false;
    this.onerror?.({
      message,
      preventDefault: () => { prevented = true; },
    } as ErrorEvent);
    return prevented;
  }

  failMessage(): void {
    this.onmessageerror?.({} as MessageEvent);
  }
}

test('an initial worker construction failure reaches terminal UI asynchronously', async () => {
  const terminal: WorkerFailure[] = [];
  const supervisor = new WorkerSupervisor<object, string>(
    () => {
      throw new DOMException('worker blocked', 'SecurityError');
    },
    {
      deadlineMs: 25,
      onMessage: () => assert.fail('a worker that never started cannot respond'),
      onRecover: () => assert.fail('initial construction has no live worker to recover'),
      onTerminal: (failure) => terminal.push(failure),
    },
  );

  assert.equal(supervisor.post({ seq: 1 }, true), false);
  assert.deepEqual(terminal, []);
  await Promise.resolve();
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0]?.kind, 'error');
  assert.equal(terminal[0]?.error.name, 'SecurityError');
});

test('a render deadline replaces the worker and a response replenishes recovery', () => {
  const timer = new ManualTimer();
  const workers: FakeWorker[] = [];
  const recovered: WorkerFailure[] = [];
  const terminal: WorkerFailure[] = [];
  const responses: string[] = [];
  const supervisor = new WorkerSupervisor<object, string>(
    () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker as unknown as Worker;
    },
    {
      deadlineMs: 25,
      timer,
      onMessage: (response) => responses.push(response),
      onRecover: (failure) => recovered.push(failure),
      onTerminal: (failure) => terminal.push(failure),
    },
  );

  assert.equal(supervisor.post({ seq: 1 }, true), true);
  timer.fire();
  assert.equal(workers[0].terminated, true);
  assert.equal(workers.length, 2);
  assert.equal(recovered[0]?.kind, 'timeout');

  assert.equal(supervisor.post({ seq: 2 }, true), true);
  workers[1].respond('rendered');
  assert.deepEqual(responses, ['rendered']);
  assert.deepEqual(terminal, []);

  // A successful response reset the budget, so a later failure is recoverable.
  assert.equal(supervisor.post({ seq: 3 }, true), true);
  assert.equal(workers[1].fail('later crash'), true);
  assert.equal(workers.length, 3);
  assert.deepEqual(recovered.map((failure) => failure.kind), ['timeout', 'error']);
  supervisor.destroy();
});

test('two consecutive transport failures terminate instead of hanging in flight', () => {
  const timer = new ManualTimer();
  const workers: FakeWorker[] = [];
  const recovered: WorkerFailure[] = [];
  const terminal: WorkerFailure[] = [];
  const supervisor = new WorkerSupervisor<object, string>(
    () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker as unknown as Worker;
    },
    {
      deadlineMs: 25,
      timer,
      onMessage: () => undefined,
      onRecover: (failure) => recovered.push(failure),
      onTerminal: (failure) => terminal.push(failure),
    },
  );

  supervisor.post({ seq: 1 }, true);
  assert.equal(workers[0].fail('first crash'), true);
  assert.equal(recovered.length, 1);
  supervisor.post({ seq: 1 }, true);
  workers[1].failMessage();

  assert.equal(workers[1].terminated, true);
  assert.equal(workers.length, 2);
  assert.equal(terminal[0]?.kind, 'messageerror');
  assert.equal(supervisor.post({ seq: 2 }, true), false);
});
