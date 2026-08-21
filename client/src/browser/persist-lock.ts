import { hasWebLocks } from './platform.ts';

/**
 * Serialize IndexedDB snapshot writes for one document.
 *
 * Two tabs exporting independently will last-write-wins and drop whichever
 * replica saved first. Holding `navigator.locks` around the export+write
 * means the second writer runs against a document that already merged the
 * first writer's updates (via TabChannel), so the stored snapshot is a
 * union, not a coin flip.
 *
 * Browsers without Web Locks just run the function. Losing a race there is
 * no worse than today's behaviour.
 */
export async function withPersistLock<T>(name: string, work: () => Promise<T>): Promise<T> {
  if (!hasWebLocks()) return work();

  return navigator.locks.request(name, { mode: 'exclusive' }, async () => work());
}

export function persistLockName(engine: string, docId: string): string {
  return `marks:persist:${engine}:${docId}`;
}
