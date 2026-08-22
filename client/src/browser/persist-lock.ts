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

const tails = new Map<string, Promise<unknown>>();

function withProcessLock<T>(name: string, work: () => Promise<T>): Promise<T> {
  const prev = tails.get(name) ?? Promise.resolve();
  const run = prev.then(() => work());
  tails.set(
    name,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

export async function withPersistLock<T>(name: string, work: () => Promise<T>): Promise<T> {
  return withProcessLock(name, async () => {
    if (!hasWebLocks()) return work();
    return navigator.locks.request(name, { mode: 'exclusive' }, async () => work());
  });
}

export async function writeSnapshotUnderLock(
  name: string,
  exportBytes: () => Uint8Array,
  write: (bytes: Uint8Array) => Promise<void>,
): Promise<void> {
  await withPersistLock(name, async () => {
    await write(exportBytes());
  });
}

export function persistLockName(engine: string, docId: string): string {
  return `marks:persist:${engine}:${docId}`;
}
