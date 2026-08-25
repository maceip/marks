import { del as idbDelete, get as idbGet, set as idbSet, update as idbUpdate } from 'idb-keyval';
import { runWithTimeout } from '../browser/network.ts';
import { persistLockName, withPersistLock } from '../browser/persist-lock.ts';
import type { MutationKind } from './protocol.ts';
import { JOURNAL_RETAINED_THRESHOLD } from './profile.ts';
import type { DocumentCapabilities } from './types.ts';

export { JOURNAL_RETAINED_THRESHOLD } from './profile.ts';
export const JOURNAL_PRUNE_INTERVAL_MS = 10 * 60 * 1000;
export const JOURNAL_OPEN_TIMEOUT_MS = 3_000;

export interface JournalMutation {
  id: string;
  kind: MutationKind;
  bytes: Uint8Array;
  createdAt: number;
}

export interface ReplicaJournalRecord {
  version: 3;
  siteId: string;
  /** Last server-authorized role. It permits offline edits locally; the
   * server still revalidates every pending mutation after reconnect. */
  role: DocumentCapabilities['role'];
  snapshot: Uint8Array;
  pending: JournalMutation[];
  ackedVersion: Uint8Array | null;
  committedRevision: string | null;
  lastPruneAt: number;
}

interface UnknownJournalRecord {
  version?: unknown;
  siteId?: unknown;
  snapshot?: unknown;
  pending?: unknown;
  updates?: unknown;
  ackedVersion?: unknown;
  committedRevision?: unknown;
  lastPruneAt?: unknown;
  role?: unknown;
}

export function journalCacheKey(docId: string): string {
  return `marks:esbt:journal:${docId}`;
}

/**
 * Read and validate a journal. Storage failures deliberately reject: callers
 * must not turn an unreadable durable copy into an apparently empty document.
 */
export async function readReplicaJournal(docId: string): Promise<ReplicaJournalRecord | null> {
  return normalizeRecord(await idbGet<unknown>(journalCacheKey(docId)));
}

export class ReplicaJournalUnavailableError extends Error {
  readonly reason: unknown;

  constructor(reason: unknown) {
    super(
      "Marks could not safely read this page's offline edits. Reload and try again; the durable local copy was left untouched.",
    );
    this.name = 'ReplicaJournalUnavailableError';
    this.reason = reason;
  }
}

/**
 * Opening a replica is fail-closed: an unreadable journal may contain edits
 * that have not reached the server, so it must never be treated as an empty
 * journal. The caller gets a bounded, recoverable opening error instead.
 */
export async function readReplicaJournalForOpen(
  docId: string,
  options: {
    timeoutMs?: number;
    read?: (documentId: string) => Promise<ReplicaJournalRecord | null>;
  } = {},
): Promise<ReplicaJournalRecord | null> {
  const read = options.read ?? readReplicaJournal;
  try {
    return await runWithTimeout(
      () => read(docId),
      options.timeoutMs ?? JOURNAL_OPEN_TIMEOUT_MS,
    );
  } catch (error) {
    throw new ReplicaJournalUnavailableError(error);
  }
}

/**
 * Do not construct or connect a replica until its durable local state has
 * been read successfully. Keeping the continuation behind this gate makes it
 * impossible for a read failure to be reinterpreted as an empty journal.
 */
export async function openWithReplicaJournal<T>(
  docId: string,
  continueOpening: (stored: ReplicaJournalRecord | null) => Promise<T>,
  options: {
    timeoutMs?: number;
    read?: (documentId: string) => Promise<ReplicaJournalRecord | null>;
  } = {},
): Promise<T> {
  const stored = await readReplicaJournalForOpen(docId, options);
  return continueOpening(stored);
}

/** Replace a journal under the per-document lock (primarily import/tests). */
export async function writeReplicaJournal(
  docId: string,
  record: ReplicaJournalRecord,
): Promise<void> {
  await withPersistLock(persistLockName('esbt', docId), async () => {
    await idbSet(journalCacheKey(docId), cloneRecord(record));
  });
}

/** Remove one unusable journal without disturbing any other local document. */
export async function deleteReplicaJournal(docId: string): Promise<void> {
  await withPersistLock(persistLockName('esbt', docId), async () => {
    await idbDelete(journalCacheKey(docId));
  });
}

/** Atomically append one retry-stable mutation without a read/write gap. */
export async function appendPendingMutation(
  docId: string,
  fallback: ReplicaJournalRecord,
  mutation: JournalMutation,
): Promise<ReplicaJournalRecord> {
  return updateRecord(docId, fallback, (current) => appendMutation(current, mutation));
}

/**
 * Export inside the same lock that replaces the checkpoint. Pending network
 * mutations are preserved because the snapshot and server commit lifecycle are
 * independent durability axes.
 */
export async function checkpointReplicaJournal(
  docId: string,
  fallback: ReplicaJournalRecord,
  exportSnapshot: () => Uint8Array,
): Promise<ReplicaJournalRecord> {
  return withPersistLock(persistLockName('esbt', docId), async () => {
    const snapshot = exportSnapshot().slice();
    let written: ReplicaJournalRecord | null = null;
    await idbUpdate(journalCacheKey(docId), (stored) => {
      const current = normalizeRecord(stored) ?? cloneRecord(fallback);
      written = { ...current, snapshot };
      return written;
    });
    return written ?? { ...cloneRecord(fallback), snapshot };
  });
}

/**
 * A server ACK removes its retry payload only in the same local transaction
 * that checkpoints the now-committed replica state.
 */
export async function acknowledgePendingMutation(
  docId: string,
  fallback: ReplicaJournalRecord,
  mutationId: string,
  acknowledgedVersion: Uint8Array,
  committedRevision: bigint,
  exportSnapshot: () => Uint8Array,
): Promise<ReplicaJournalRecord> {
  return withPersistLock(persistLockName('esbt', docId), async () => {
    const snapshot = exportSnapshot().slice();
    let written: ReplicaJournalRecord | null = null;
    await idbUpdate(journalCacheKey(docId), (stored) => {
      const current = normalizeRecord(stored) ?? cloneRecord(fallback);
      written = {
        ...current,
        snapshot,
        pending: current.pending.filter((mutation) => mutation.id !== mutationId),
        ackedVersion: acknowledgedVersion.slice(),
        committedRevision: committedRevision.toString(),
      };
      return written;
    });
    return (
      written ?? {
        ...cloneRecord(fallback),
        snapshot,
        ackedVersion: acknowledgedVersion.slice(),
        committedRevision: committedRevision.toString(),
      }
    );
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

export function appendMutation(
  record: ReplicaJournalRecord,
  mutation: JournalMutation,
): ReplicaJournalRecord {
  if (mutation.bytes.byteLength === 0) return record;
  const existing = record.pending.find((item) => item.id === mutation.id);
  if (existing) {
    if (existing.kind !== mutation.kind || !bytesEqual(existing.bytes, mutation.bytes)) {
      throw new Error('marks: one mutation id was reused for different bytes');
    }
    return record;
  }
  return {
    ...record,
    pending: [...record.pending, { ...mutation, bytes: mutation.bytes.slice() }],
  };
}

async function updateRecord(
  docId: string,
  fallback: ReplicaJournalRecord,
  mutate: (record: ReplicaJournalRecord) => ReplicaJournalRecord,
): Promise<ReplicaJournalRecord> {
  return withPersistLock(persistLockName('esbt', docId), async () => {
    let written: ReplicaJournalRecord | null = null;
    await idbUpdate(journalCacheKey(docId), (stored) => {
      written = mutate(normalizeRecord(stored) ?? cloneRecord(fallback));
      return written;
    });
    return written ?? mutate(cloneRecord(fallback));
  });
}

function normalizeRecord(value: unknown): ReplicaJournalRecord | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as UnknownJournalRecord;
  if (typeof record.siteId !== 'string' || !(record.snapshot instanceof Uint8Array)) return null;
  const ackedVersion = record.ackedVersion instanceof Uint8Array ? record.ackedVersion : null;
  const lastPruneAt = typeof record.lastPruneAt === 'number' ? record.lastPruneAt : 0;

  if (record.version === 3 || record.version === 2) {
    const pending = Array.isArray(record.pending)
      ? record.pending.flatMap((value): JournalMutation[] => {
          const item = value as Partial<JournalMutation> | null;
          if (
            !item ||
            typeof item.id !== 'string' ||
            !/^[0-9a-f]{32}$/.test(item.id) ||
            (item.kind !== 'update' && item.kind !== 'snapshot') ||
            !(item.bytes instanceof Uint8Array)
          ) {
            return [];
          }
          return [
            {
              id: item.id,
              kind: item.kind,
              bytes: item.bytes,
              createdAt: typeof item.createdAt === 'number' ? item.createdAt : 0,
            },
          ];
        })
      : [];
    return {
      version: 3,
      siteId: record.siteId,
      role: record.version === 3 ? persistedRole(record.role) : null,
      snapshot: record.snapshot,
      pending,
      ackedVersion,
      committedRevision:
        typeof record.committedRevision === 'string' ? record.committedRevision : null,
      lastPruneAt,
    };
  }

  if (record.version === 1) {
    const updates = Array.isArray(record.updates)
      ? record.updates.filter((update): update is Uint8Array => update instanceof Uint8Array)
      : [];
    return {
      version: 3,
      siteId: record.siteId,
      role: null,
      snapshot: record.snapshot,
      pending: updates.map((bytes, index) => ({
        id: legacyMutationId(bytes, index),
        kind: 'update',
        bytes,
        createdAt: 0,
      })),
      ackedVersion,
      committedRevision: null,
      lastPruneAt,
    };
  }
  return null;
}

function persistedRole(value: unknown): DocumentCapabilities['role'] {
  return value === 'local'
    || value === 'scratch'
    || value === 'owner'
    || value === 'editor'
    || value === 'commenter'
    || value === 'viewer'
    ? value
    : null;
}

function cloneRecord(record: ReplicaJournalRecord): ReplicaJournalRecord {
  return {
    ...record,
    snapshot: record.snapshot.slice(),
    pending: record.pending.map((mutation) => ({ ...mutation, bytes: mutation.bytes.slice() })),
    ackedVersion: record.ackedVersion?.slice() ?? null,
  };
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

/** Deterministic v1 migration id; ESBT dedup remains the collision backstop. */
function legacyMutationId(bytes: Uint8Array, index: number): string {
  let first = 0xcbf29ce484222325n ^ BigInt(index);
  let second = 0x84222325cbf29ce4n ^ BigInt(bytes.byteLength);
  for (const byte of bytes) {
    first = BigInt.asUintN(64, (first ^ BigInt(byte)) * 0x100000001b3n);
    second = BigInt.asUintN(64, (second ^ BigInt(byte + 1)) * 0x100000001b3n);
  }
  if (first === 0n && second === 0n) first = 1n;
  return first.toString(16).padStart(16, '0') + second.toString(16).padStart(16, '0');
}
