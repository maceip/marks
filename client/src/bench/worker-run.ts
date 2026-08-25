import type { BenchMessage } from './types.ts';

export const BENCHMARK_RUN_TIMEOUT_MS = 120_000;

export interface BenchmarkWorkerLike {
  onmessage: ((event: MessageEvent<BenchMessage>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null;
  terminate(): void;
}

export interface BenchmarkWorkerSupervisor {
  cancel(): void;
  fail(message: string): void;
}

/** Own every terminal path for a benchmark worker, including silent workers. */
export function superviseBenchmarkWorker(
  worker: BenchmarkWorkerLike,
  options: {
    timeoutMs?: number;
    onMessage: (message: Exclude<BenchMessage, { type: 'done' | 'error' }>) => void;
    onDone: () => void;
    onFailure: (message: string) => void;
  },
): BenchmarkWorkerSupervisor {
  let active = true;
  const stop = (): boolean => {
    if (!active) return false;
    active = false;
    globalThis.clearTimeout(timer);
    worker.onmessage = null;
    worker.onerror = null;
    worker.onmessageerror = null;
    worker.terminate();
    return true;
  };
  const fail = (message: string): void => {
    if (!stop()) return;
    options.onFailure(message);
  };
  const timer = globalThis.setTimeout(
    () => fail('The benchmark took too long and was stopped. Try a smaller trace.'),
    options.timeoutMs ?? BENCHMARK_RUN_TIMEOUT_MS,
  );

  worker.onmessage = (event) => {
    const message = event.data;
    if (message.type === 'error') {
      fail(message.message || 'The benchmark worker failed.');
      return;
    }
    if (message.type === 'done') {
      if (stop()) options.onDone();
      return;
    }
    if (active) options.onMessage(message);
  };
  worker.onerror = (event) => {
    event.preventDefault();
    fail(event.message || 'The benchmark worker crashed.');
  };
  worker.onmessageerror = () => {
    fail('The benchmark worker returned an unreadable result.');
  };

  return {
    cancel: () => { stop(); },
    fail,
  };
}
