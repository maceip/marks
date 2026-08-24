import type {
  CausalReceipt,
  ContextSignal,
  CounterfactualPatch,
  StoredIntent,
} from './types.ts';

const DATABASE = 'marks-wild-studio';
const VERSION = 1;
const INTENTS = 'intentions';
const CAUSAL = 'causal';
const CONTEXT = 'context';
const COUNTERFACTUALS = 'counterfactuals';
const CHANGE_EVENT = 'marks:wild-store-change';
const CHANNEL = 'marks:wild-store-change:v1';
const MAX_INTENTS_PER_DOCUMENT = 40;
const MAX_CAUSAL_PER_DOCUMENT = 250;
const MAX_CONTEXT_PER_DOCUMENT = 500;
const MAX_COUNTERFACTUALS_PER_DOCUMENT = 80;
const MAX_COUNTERFACTUAL_BYTES = 8 * 1024 * 1024;
const textEncoder = new TextEncoder();

let channel: BroadcastChannel | null | undefined;

function changeChannel(): BroadcastChannel | null {
  if (channel !== undefined) return channel;
  channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANNEL);
  return channel;
}

function emit(documentId: string): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { documentId } }));
  changeChannel()?.postMessage(documentId);
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      const intents = database.createObjectStore(INTENTS, { keyPath: 'id' });
      intents.createIndex('documentId', 'documentId', { unique: false });
      const causal = database.createObjectStore(CAUSAL, { keyPath: 'id' });
      causal.createIndex('documentId', 'documentId', { unique: false });
      const context = database.createObjectStore(CONTEXT, { keyPath: 'id' });
      context.createIndex('documentId', 'documentId', { unique: false });
      const counterfactuals = database.createObjectStore(COUNTERFACTUALS, { keyPath: 'id' });
      counterfactuals.createIndex('documentId', 'documentId', { unique: false });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('possibility store unavailable'));
  });
}

function requested<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('possibility request failed'));
  });
}

function completed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('possibility transaction aborted'));
    transaction.onerror = () => reject(transaction.error ?? new Error('possibility transaction failed'));
  });
}

async function abortWith(database: IDBDatabase, transaction: IDBTransaction, message: string): Promise<never> {
  const done = completed(transaction);
  transaction.abort();
  await done.catch(() => undefined);
  database.close();
  throw new Error(message);
}

async function listByDocument<T>(storeName: string, documentId: string): Promise<T[]> {
  const database = await openDatabase();
  const transaction = database.transaction(storeName, 'readonly');
  const values = await requested<T[]>(transaction.objectStore(storeName).index('documentId').getAll(documentId));
  await completed(transaction);
  database.close();
  return values;
}

export function subscribeWildStore(documentId: string, listener: () => void): () => void {
  const local = (event: Event) => {
    const detail = (event as CustomEvent<{ documentId?: string }>).detail;
    if (!detail?.documentId || detail.documentId === documentId) listener();
  };
  const remote = (event: MessageEvent<unknown>) => {
    if (event.data === documentId) listener();
  };
  if (typeof window !== 'undefined') window.addEventListener(CHANGE_EVENT, local);
  const bus = changeChannel();
  bus?.addEventListener('message', remote);
  return () => {
    if (typeof window !== 'undefined') window.removeEventListener(CHANGE_EVENT, local);
    bus?.removeEventListener('message', remote);
  };
}

export async function listIntents(documentId: string): Promise<StoredIntent[]> {
  return (await listByDocument<StoredIntent>(INTENTS, documentId))
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

export async function putIntent(intent: StoredIntent): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(INTENTS, 'readwrite');
  const store = transaction.objectStore(INTENTS);
  const current = await requested<StoredIntent[]>(store.index('documentId').getAll(intent.documentId));
  if (!current.some((item) => item.id === intent.id) && current.length >= MAX_INTENTS_PER_DOCUMENT) {
    return abortWith(database, transaction, `The intent horizon keeps at most ${MAX_INTENTS_PER_DOCUMENT} entries per document.`);
  }
  store.put(intent);
  await completed(transaction);
  database.close();
  emit(intent.documentId);
}

export async function listCausalReceipts(documentId: string): Promise<CausalReceipt[]> {
  return (await listByDocument<CausalReceipt>(CAUSAL, documentId))
    .sort((left, right) => right.finishedAt - left.finishedAt);
}

export async function putCausalReceipt(receipt: CausalReceipt): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(CAUSAL, 'readwrite');
  const store = transaction.objectStore(CAUSAL);
  store.put(receipt);
  const current = await requested<CausalReceipt[]>(store.index('documentId').getAll(receipt.documentId));
  current.sort((left, right) => right.finishedAt - left.finishedAt);
  for (const stale of current.slice(MAX_CAUSAL_PER_DOCUMENT)) store.delete(stale.id);
  await completed(transaction);
  database.close();
  emit(receipt.documentId);
}

export async function listContextSignals(documentId: string): Promise<ContextSignal[]> {
  return (await listByDocument<ContextSignal>(CONTEXT, documentId))
    .sort((left, right) => {
      const leftExpiry = (left.reviewedAt ?? left.firstSeenAt) + left.ttlMs;
      const rightExpiry = (right.reviewedAt ?? right.firstSeenAt) + right.ttlMs;
      return leftExpiry - rightExpiry;
    });
}

export async function reconcileContextSignals(documentId: string, discovered: readonly ContextSignal[]): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(CONTEXT, 'readwrite');
  const store = transaction.objectStore(CONTEXT);
  const current = await requested<ContextSignal[]>(store.index('documentId').getAll(documentId));
  const existing = new Map(current.map((signal) => [signal.id, signal]));
  const seen = new Set(discovered.map((signal) => signal.id));
  let remaining = Math.max(0, MAX_CONTEXT_PER_DOCUMENT - current.length);
  for (const signal of discovered.slice(0, MAX_CONTEXT_PER_DOCUMENT)) {
    const prior = existing.get(signal.id);
    if (prior) {
      store.put({
        ...signal,
        firstSeenAt: prior.firstSeenAt,
        reviewedAt: prior.reviewedAt,
        ttlMs: prior.ttlMs,
        dismissed: prior.dismissed,
        active: true,
      });
    } else if (remaining > 0) {
      store.put(signal);
      remaining -= 1;
    }
  }
  for (const signal of current) {
    if (signal.kind !== 'explicit' && signal.active && !seen.has(signal.id)) {
      store.put({ ...signal, active: false, lastSeenAt: Date.now() });
    }
  }
  await completed(transaction);
  database.close();
  emit(documentId);
}

export async function putContextSignal(signal: ContextSignal): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(CONTEXT, 'readwrite');
  const store = transaction.objectStore(CONTEXT);
  const current = await requested<ContextSignal[]>(store.index('documentId').getAll(signal.documentId));
  if (!current.some((item) => item.id === signal.id) && current.length >= MAX_CONTEXT_PER_DOCUMENT) {
    return abortWith(database, transaction, `Context half-life keeps at most ${MAX_CONTEXT_PER_DOCUMENT} signals per document.`);
  }
  store.put(signal);
  await completed(transaction);
  database.close();
  emit(signal.documentId);
}

export async function listCounterfactuals(documentId: string): Promise<CounterfactualPatch[]> {
  return (await listByDocument<CounterfactualPatch>(COUNTERFACTUALS, documentId))
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

export async function putCounterfactual(patch: CounterfactualPatch): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(COUNTERFACTUALS, 'readwrite');
  const store = transaction.objectStore(COUNTERFACTUALS);
  const current = await requested<CounterfactualPatch[]>(store.index('documentId').getAll(patch.documentId));
  const withoutCurrent = current.filter((item) => item.id !== patch.id);
  const totalBytes = withoutCurrent.reduce(
    (sum, item) => sum + textEncoder.encode(item.expected).byteLength + textEncoder.encode(item.replacement).byteLength,
    textEncoder.encode(patch.expected).byteLength + textEncoder.encode(patch.replacement).byteLength,
  );
  if (withoutCurrent.length >= MAX_COUNTERFACTUALS_PER_DOCUMENT || totalBytes > MAX_COUNTERFACTUAL_BYTES) {
    return abortWith(database, transaction, 'The counterfactual shelf reached its 80-item or 8 MiB per-document bound. Export and remove alternatives before adding more.');
  }
  store.put(patch);
  await completed(transaction);
  database.close();
  emit(patch.documentId);
}

export async function deleteCounterfactual(documentId: string, id: string): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(COUNTERFACTUALS, 'readwrite');
  const store = transaction.objectStore(COUNTERFACTUALS);
  const current = await requested<CounterfactualPatch | undefined>(store.get(id));
  if (!current || current.documentId !== documentId) {
    return abortWith(database, transaction, 'The counterfactual does not belong to this document.');
  }
  store.delete(id);
  await completed(transaction);
  database.close();
  emit(documentId);
}
