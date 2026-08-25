export type WorkerFailureKind = 'timeout' | 'error' | 'messageerror' | 'postmessage';

export interface WorkerFailure {
  kind: WorkerFailureKind;
  error: Error;
}

interface WorkerTimer {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

interface WorkerSupervisorOptions<Response> {
  deadlineMs: number;
  maxRecoveries?: number;
  onMessage(response: Response): void;
  onRecover(failure: WorkerFailure): void;
  onTerminal(failure: WorkerFailure): void;
  timer?: WorkerTimer;
}

const systemTimer: WorkerTimer = {
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Owns the failure boundary around a request/response Web Worker.
 *
 * A worker gets one automatic restart before a second consecutive failure is
 * surfaced as terminal. Any valid response replenishes that recovery budget.
 */
export class WorkerSupervisor<Request, Response> {
  private worker: Worker | null;
  private deadlineHandle: unknown = null;
  private awaitingResponse = false;
  private failuresWithoutResponse = 0;
  private stopped = false;
  private readonly maxRecoveries: number;
  private readonly timer: WorkerTimer;
  private readonly createWorker: () => Worker;
  private readonly options: WorkerSupervisorOptions<Response>;

  constructor(
    createWorker: () => Worker,
    options: WorkerSupervisorOptions<Response>,
  ) {
    this.createWorker = createWorker;
    this.options = options;
    this.maxRecoveries = options.maxRecoveries ?? 1;
    this.timer = options.timer ?? systemTimer;
    this.worker = this.spawn();
  }

  post(message: Request, expectResponse: boolean): boolean {
    const worker = this.worker;
    if (this.stopped || !worker) return false;
    try {
      worker.postMessage(message);
    } catch (error) {
      this.fail(worker, {
        kind: 'postmessage',
        error: asError(error, 'Markdown worker rejected a message'),
      });
      return false;
    }
    if (expectResponse) this.armDeadline(worker);
    return true;
  }

  destroy(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.clearDeadline();
    this.detachAndTerminate(this.worker);
    this.worker = null;
  }

  private spawn(): Worker {
    const worker = this.createWorker();
    worker.onmessage = (event: MessageEvent<Response>) => {
      if (this.stopped || this.worker !== worker) return;
      this.clearDeadline();
      this.failuresWithoutResponse = 0;
      this.options.onMessage(event.data);
    };
    worker.onerror = (event: ErrorEvent) => {
      if (this.stopped || this.worker !== worker) return true;
      event.preventDefault();
      this.fail(worker, {
        kind: 'error',
        error: new Error(event.message || 'Markdown worker failed'),
      });
      return true;
    };
    worker.onmessageerror = () => {
      if (this.stopped || this.worker !== worker) return;
      this.fail(worker, {
        kind: 'messageerror',
        error: new Error('Markdown worker returned an unreadable message'),
      });
    };
    return worker;
  }

  private armDeadline(worker: Worker): void {
    this.clearDeadline();
    this.awaitingResponse = true;
    this.deadlineHandle = this.timer.set(() => {
      if (this.stopped || this.worker !== worker || !this.awaitingResponse) return;
      this.fail(worker, {
        kind: 'timeout',
        error: new Error(`Markdown worker timed out after ${this.options.deadlineMs} ms`),
      });
    }, this.options.deadlineMs);
  }

  private clearDeadline(): void {
    this.awaitingResponse = false;
    if (this.deadlineHandle === null) return;
    this.timer.clear(this.deadlineHandle);
    this.deadlineHandle = null;
  }

  private fail(worker: Worker, failure: WorkerFailure): void {
    if (this.stopped || this.worker !== worker) return;
    this.clearDeadline();
    this.detachAndTerminate(worker);
    this.worker = null;
    this.failuresWithoutResponse += 1;

    if (this.failuresWithoutResponse > this.maxRecoveries) {
      this.stopped = true;
      this.options.onTerminal(failure);
      return;
    }

    try {
      this.worker = this.spawn();
    } catch (error) {
      this.stopped = true;
      this.options.onTerminal({
        kind: 'error',
        error: asError(error, 'Markdown worker could not restart'),
      });
      return;
    }
    this.options.onRecover(failure);
  }

  private detachAndTerminate(worker: Worker | null): void {
    if (!worker) return;
    worker.onmessage = null;
    worker.onerror = null;
    worker.onmessageerror = null;
    worker.terminate();
  }
}

function asError(value: unknown, fallback: string): Error {
  if (value instanceof Error) return value;
  return new Error(value ? String(value) : fallback);
}
