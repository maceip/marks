import { runWithTimeout } from './network.ts';
import { hasWebLocks } from './platform.ts';

/**
 * Serialize IndexedDB snapshot writes for one document.
 *
 * Two tabs exporting independently will last-write-wins and drop whichever
 * replica saved first. Callers must export **inside** `work` (not before
 * requesting the lock). `writeSnapshotUnderLock` is the only helper that
 * takes an exporter — its signature makes “export then lock” unrepresentable.
 *
 * Same-isolate callers (tests, overlapping saves in one tab) are queued in
 * process. Cross-tab callers also take `navigator.locks` when the browser
 * has Web Locks. Browsers without Web Locks still get the in-process queue;
 * a second tab can still race, which is no worse than running unlocked.
 */

export const PERSIST_LOCK_TIMEOUT_MS = 5_000;

export interface PersistLockOptions {
  /** One absolute budget for the process queue, Web Lock, and durable write. */
  timeoutMs?: number;
}

export class PersistLockTimeoutError extends Error {
  readonly lockName: string;

  constructor(lockName: string) {
    super('Offline storage stopped responding before the document could be saved.');
    this.name = 'PersistLockTimeoutError';
    this.lockName = lockName;
  }
}

export class PersistLockPoisonedError extends Error {
  readonly lockName: string;
  override readonly cause: unknown;

  constructor(lockName: string, cause: unknown) {
    super('Offline storage is unavailable for this document. Reload before editing again.');
    this.name = 'PersistLockPoisonedError';
    this.lockName = lockName;
    this.cause = cause;
  }
}

const tails = new Map<string, Promise<unknown>>();
const poisoned = new Map<string, unknown>();

function requireHealthy(name: string): void {
  if (poisoned.has(name)) throw new PersistLockPoisonedError(name, poisoned.get(name));
}

function withProcessLock<T>(name: string, work: () => Promise<T>): Promise<T> {
  const prev = tails.get(name) ?? Promise.resolve();
  const run = prev.then(() => {
    // A timed-out predecessor can continue executing because IndexedDB work
    // is not cancellable. Never overlap another exporter with that detached
    // work: the document's lane remains poisoned until the page reloads.
    requireHealthy(name);
    return work();
  });
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  tails.set(name, tail);
  void tail.finally(() => {
    if (tails.get(name) === tail) tails.delete(name);
  });
  return run;
}

export async function withPersistLock<T>(
  name: string,
  work: () => Promise<T>,
  options: PersistLockOptions = {},
): Promise<T> {
  requireHealthy(name);
  const timeout = new PersistLockTimeoutError(name);
  try {
    return await runWithTimeout(
      async (signal) => withProcessLock(name, async () => {
        requireHealthy(name);
        if (signal.aborted) throw signal.reason;
        if (!hasWebLocks()) return work();
        return navigator.locks.request(
          name,
          { mode: 'exclusive', signal },
          async () => {
            requireHealthy(name);
            if (signal.aborted) throw signal.reason;
            return work();
          },
        );
      }),
      options.timeoutMs ?? PERSIST_LOCK_TIMEOUT_MS,
      undefined,
      timeout,
    );
  } catch (error) {
    if (error === timeout) poisoned.set(name, timeout);
    throw error;
  }
}

export async function writeSnapshotUnderLock(
  name: string,
  exportBytes: () => Uint8Array,
  write: (bytes: Uint8Array) => Promise<void>,
  options: PersistLockOptions = {},
): Promise<void> {
  await withPersistLock(name, async () => {
    await write(exportBytes());
  }, options);
}

export function persistLockName(engine: string, docId: string): string {
  return `marks:persist:${engine}:${docId}`;
}
