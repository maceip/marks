import { get as idbGet, set as idbSet } from 'idb-keyval';
import { persistLockName, withPersistLock } from '../browser/persist-lock.ts';

export const JOURNAL_RETAINED_THRESHOLD = 50_000;
export const JOURNAL_PRUNE_INTERVAL_MS = 10 * 60 * 1000;

export interface ReplicaJournalRecord {
  version: 1;
  siteId: string;
  snapshot: Uint8Array;
  updates: Uint8Array[];
  ackedVersion: Uint8Array | null;
  lastPruneAt: number;
}

export function journalCacheKey(docId: string): string {
  return `marks:esbt:journal:${docId}`;
}

export async function readReplicaJournal(docId: string): Promise<ReplicaJournalRecord | null> {
  try {
    const record = await idbGet<ReplicaJournalRecord>(journalCacheKey(docId));
    if (!record || record.version !== 1) return null;
    if (typeof record.siteId !== 'string' || !(record.snapshot instanceof Uint8Array)) return null;
    return {
      version: 1,
      siteId: record.siteId,
      snapshot: record.snapshot,
      updates: Array.isArray(record.updates)
        ? record.updates.filter((update) => update instanceof Uint8Array)
        : [],
      ackedVersion: record.ackedVersion instanceof Uint8Array ? record.ackedVersion : null,
      lastPruneAt: typeof record.lastPruneAt === 'number' ? record.lastPruneAt : 0,
    };
  } catch {
    return null;
  }
}

export async function writeReplicaJournal(
  docId: string,
  record: ReplicaJournalRecord,
): Promise<void> {
  await withPersistLock(persistLockName('esbt', docId), async () => {
    await idbSet(journalCacheKey(docId), record);
  });
}

export function shouldPruneHistory(
  retainedOperations: number,
  lastPruneAt: number,
  now = Date.now(),
): boolean {
  if (retainedOperations > JOURNAL_RETAINED_THRESHOLD) return true;
  if (lastPruneAt === 0) return false;
  return now - lastPruneAt > JOURNAL_PRUNE_INTERVAL_MS;
}

export function appendJournalUpdate(
  record: ReplicaJournalRecord,
  update: Uint8Array,
): ReplicaJournalRecord {
  if (update.byteLength === 0) return record;
  return { ...record, updates: [...record.updates, update.slice()] };
}
