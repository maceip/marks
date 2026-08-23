import { decodeBase64Url, encodeBase64Url } from '../auth/protocol.ts';
import type { ReviewAnchorRange } from '../collab/types.ts';
import { UI_DATA_MODE } from '../lib/product.ts';
import { loadServiceApi } from '../lib/service-api.ts';

/**
 * Review metadata deliberately lives outside ESBT. Only opaque anchors are
 * engine-owned; thread identity, ACLs, authors, and lifecycle belong to the
 * product metadata plane.
 */
export interface ReviewReply {
  id: string;
  author: string;
  own: boolean;
  body: string;
  createdAt: number;
  editedAt: number | null;
  deleted: boolean;
}

export interface ReviewComment {
  id: string;
  documentId: string;
  author: string;
  own: boolean;
  body: string;
  createdAt: number;
  editedAt: number | null;
  deleted: boolean;
  resolved: boolean;
  startAnchor: string | null;
  endAnchor: string | null;
  quote: string;
  startOffset: number;
  endOffset: number;
  replies: ReviewReply[];
}

export interface DocumentVersion {
  id: string;
  documentId: string;
  label: string;
  author: string;
  createdAt: number;
  chars: number;
  /** Loaded lazily in service mode; always present for local snapshots. */
  markdown?: string;
  current?: boolean;
}

export interface ReviewCommentPage {
  comments: ReviewComment[];
  nextCursor: string | null;
}

interface ReviewRepository {
  readonly mode: 'local' | 'service';
  listComments(documentId: string, cursor?: string): Promise<ReviewCommentPage>;
  addComment(
    documentId: string,
    author: string,
    body: string,
    range: ReviewAnchorRange,
  ): Promise<ReviewComment>;
  updateComment(
    documentId: string,
    id: string,
    patch: { resolved?: boolean; body?: string },
  ): Promise<void>;
  deleteComment(documentId: string, id: string): Promise<void>;
  addReply(documentId: string, commentId: string, author: string, body: string): Promise<void>;
  updateReply(documentId: string, commentId: string, replyId: string, body: string): Promise<void>;
  deleteReply(documentId: string, commentId: string, replyId: string): Promise<void>;
  listVersions(documentId: string, currentText: string): Promise<DocumentVersion[]>;
  createVersion(
    documentId: string,
    author: string,
    label: string,
    markdown: string,
  ): Promise<DocumentVersion>;
  getVersion(documentId: string, id: string): Promise<DocumentVersion | null>;
  deleteVersion(documentId: string, id: string): Promise<void>;
  subscribe(listener: () => void): () => void;
}

const COMMENT_KEY = 'marks:review-comments:v2';
const LEGACY_COMMENT_KEY = 'marks:review-comments:v1';
const VERSION_KEY = 'marks:review-versions:v1';
const REVIEW_EVENT = 'marks:review-change';
const REVIEW_CHANNEL = 'marks:review-change:v1';
const LOCAL_DATABASE = 'marks-local-review';
const LOCAL_DATABASE_VERSION = 1;
const COMMENT_STORE = 'comments';
const VERSION_STORE = 'versions';
const META_STORE = 'meta';
const LOCAL_COMMENT_PAGE_SIZE = 25;
const MAX_LOCAL_COMMENTS = 10_000;
const MAX_LOCAL_REPLIES = 200;
const MAX_LOCAL_VERSIONS = 100;
const MAX_LOCAL_VERSION_BYTES = 64 * 1024 * 1024;
const textEncoder = new TextEncoder();

interface LocalReviewMeta {
  documentId: string;
  versionCount: number;
  versionBytes: number;
}

let reviewChannel: BroadcastChannel | null | undefined;
let migration: Promise<void> | undefined;

function channel(): BroadcastChannel | null {
  if (reviewChannel !== undefined) return reviewChannel;
  reviewChannel = typeof BroadcastChannel === 'undefined'
    ? null
    : new BroadcastChannel(REVIEW_CHANNEL);
  return reviewChannel;
}

function emitReviewChange(): void {
  window.dispatchEvent(new CustomEvent(REVIEW_EVENT));
  channel()?.postMessage('change');
}

function readLegacyJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function openLocalDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(LOCAL_DATABASE, LOCAL_DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      const comments = database.createObjectStore(COMMENT_STORE, { keyPath: 'id' });
      comments.createIndex('documentId', 'documentId', { unique: false });
      comments.createIndex('documentCreated', ['documentId', 'createdAt', 'id'], {
        unique: true,
      });
      const versions = database.createObjectStore(VERSION_STORE, { keyPath: 'id' });
      versions.createIndex('documentId', 'documentId', { unique: false });
      versions.createIndex('documentCreated', ['documentId', 'createdAt', 'id'], {
        unique: true,
      });
      database.createObjectStore(META_STORE, { keyPath: 'documentId' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('review database unavailable'));
  });
}

function requested<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('review request failed'));
  });
}

function completed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('review transaction aborted'));
    transaction.onerror = () => reject(transaction.error ?? new Error('review transaction failed'));
  });
}

async function migrateLegacyReview(): Promise<void> {
  const current = readLegacyJson<ReviewComment[]>(COMMENT_KEY, []);
  const comments = (current.length > 0
    ? current
    : readLegacyJson<ReviewComment[]>(LEGACY_COMMENT_KEY, [])).map(normalizeComment);
  const versions = readLegacyJson<DocumentVersion[]>(VERSION_KEY, []);
  if (comments.length === 0 && versions.length === 0) return;

  const database = await openLocalDatabase();
  const transaction = database.transaction(
    [COMMENT_STORE, VERSION_STORE, META_STORE],
    'readwrite',
  );
  const done = completed(transaction);
  const commentStore = transaction.objectStore(COMMENT_STORE);
  for (const comment of comments) commentStore.put(comment);
  const versionStore = transaction.objectStore(VERSION_STORE);
  const metadata = new Map<string, LocalReviewMeta>();
  for (const version of versions) {
    if (typeof version.markdown !== 'string') continue;
    const bytes = textEncoder.encode(version.markdown).byteLength;
    versionStore.put({ ...version, storedBytes: bytes });
    const meta = metadata.get(version.documentId) ?? {
      documentId: version.documentId,
      versionCount: 0,
      versionBytes: 0,
    };
    meta.versionCount += 1;
    meta.versionBytes += bytes;
    metadata.set(version.documentId, meta);
  }
  for (const meta of metadata.values()) transaction.objectStore(META_STORE).put(meta);
  await done;
  database.close();
  try {
    for (const key of [COMMENT_KEY, LEGACY_COMMENT_KEY, VERSION_KEY]) localStorage.removeItem(key);
  } catch {
    // The transactional IndexedDB copy is authoritative even if privacy mode
    // refuses cleanup of the obsolete synchronous keys.
  }
}

async function preparedDatabase(): Promise<IDBDatabase> {
  migration ??= migrateLegacyReview();
  await migration;
  return openLocalDatabase();
}

function normalizeComment(
  item: Partial<ReviewComment>
    & Pick<ReviewComment, 'id' | 'documentId' | 'author' | 'body' | 'createdAt'>,
): ReviewComment {
  return {
    id: item.id,
    documentId: item.documentId,
    author: item.author,
    own: item.own ?? true,
    body: item.body,
    createdAt: item.createdAt,
    editedAt: item.editedAt ?? null,
    deleted: item.deleted ?? false,
    resolved: item.resolved ?? false,
    startAnchor: item.startAnchor ?? null,
    endAnchor: item.endAnchor ?? null,
    quote: item.quote ?? '',
    startOffset: item.startOffset ?? 0,
    endOffset: item.endOffset ?? 0,
    replies: (item.replies ?? []).map((reply) => ({
      ...reply,
      own: reply.own ?? true,
      editedAt: reply.editedAt ?? null,
      deleted: reply.deleted ?? false,
    })),
  };
}

function subscribe(listener: () => void): () => void {
  const onChange = () => listener();
  const crossTab = channel();
  window.addEventListener(REVIEW_EVENT, onChange);
  crossTab?.addEventListener('message', onChange);
  return () => {
    window.removeEventListener(REVIEW_EVENT, onChange);
    crossTab?.removeEventListener('message', onChange);
  };
}

function storedRange(
  range: ReviewAnchorRange,
): {
  startAnchor: string;
  endAnchor: string;
  quote: string;
  startOffset: number;
  endOffset: number;
} {
  return {
    startAnchor: encodeBase64Url(range.start),
    endAnchor: encodeBase64Url(range.end),
    quote: range.quote,
    startOffset: range.startOffset,
    endOffset: range.endOffset,
  };
}

export function reviewRange(comment: ReviewComment): ReviewAnchorRange | null {
  if (!comment.startAnchor || !comment.endAnchor) return null;
  try {
    return {
      start: decodeBase64Url(comment.startAnchor),
      end: decodeBase64Url(comment.endAnchor),
      quote: comment.quote,
      startOffset: comment.startOffset,
      endOffset: comment.endOffset,
    };
  } catch {
    return null;
  }
}

export async function purgeLocalReviewMetadata(documentId: string): Promise<void> {
  const database = await preparedDatabase();
  const transaction = database.transaction(
    [COMMENT_STORE, VERSION_STORE, META_STORE],
    'readwrite',
  );
  const done = completed(transaction);
  for (const storeName of [COMMENT_STORE, VERSION_STORE]) {
    const store = transaction.objectStore(storeName);
    const keys = await requested<IDBValidKey[]>(
      store.index('documentId').getAllKeys(IDBKeyRange.only(documentId)),
    );
    for (const key of keys) store.delete(key);
  }
  transaction.objectStore(META_STORE).delete(documentId);
  await done;
  database.close();
  emitReviewChange();
}

type LocalVersionRecord = DocumentVersion & { storedBytes: number };

function checkedMessage(value: string): string {
  const text = value.trim();
  if (!text || textEncoder.encode(text).byteLength > 16 * 1024) {
    throw new Error('Review messages must be between 1 byte and 16 KiB.');
  }
  return text;
}

function parseLocalCommentCursor(cursor?: string): { createdAt: number; id: string } | null {
  if (!cursor) return null;
  const matched = /^local:(\d+):([A-Za-z0-9_-]{8,128})$/u.exec(cursor);
  if (!matched) throw new Error('Invalid local comment cursor.');
  const createdAt = Number(matched[1]);
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
    throw new Error('Invalid local comment cursor.');
  }
  return { createdAt, id: matched[2] };
}

async function listLocalComments(
  documentId: string,
  cursor?: string,
): Promise<ReviewCommentPage> {
  const parsed = parseLocalCommentCursor(cursor);
  const database = await preparedDatabase();
  const transaction = database.transaction(COMMENT_STORE, 'readonly');
  const done = completed(transaction);
  const lower: [string, number, string] = [documentId, 0, ''];
  const upper: [string, number, string] = parsed
    ? [documentId, parsed.createdAt, parsed.id]
    : [documentId, Number.MAX_SAFE_INTEGER, '\uffff'];
  const range = IDBKeyRange.bound(lower, upper, false, Boolean(parsed));
  const comments = await new Promise<ReviewComment[]>((resolve, reject) => {
    const collected: ReviewComment[] = [];
    const request = transaction
      .objectStore(COMMENT_STORE)
      .index('documentCreated')
      .openCursor(range, 'prev');
    request.onerror = () => reject(request.error ?? new Error('comment cursor failed'));
    request.onsuccess = () => {
      const current = request.result;
      if (!current) {
        resolve(collected);
        return;
      }
      collected.push(normalizeComment(current.value as ReviewComment));
      if (collected.length > LOCAL_COMMENT_PAGE_SIZE) {
        resolve(collected);
        return;
      }
      current.continue();
    };
  });
  await done;
  database.close();
  const hasMore = comments.length > LOCAL_COMMENT_PAGE_SIZE;
  if (hasMore) comments.length = LOCAL_COMMENT_PAGE_SIZE;
  const final = comments.at(-1);
  return {
    comments,
    nextCursor: hasMore && final ? `local:${final.createdAt}:${final.id}` : null,
  };
}

async function mutateLocalComment(
  documentId: string,
  id: string,
  mutate: (comment: ReviewComment) => ReviewComment,
): Promise<void> {
  const database = await preparedDatabase();
  const transaction = database.transaction(COMMENT_STORE, 'readwrite');
  const done = completed(transaction);
  const store = transaction.objectStore(COMMENT_STORE);
  const comment = await requested<ReviewComment | undefined>(store.get(id));
  if (!comment || comment.documentId !== documentId) {
    await done;
    database.close();
    throw new Error('Review thread not found.');
  }
  let updated: ReviewComment;
  try {
    updated = mutate(normalizeComment(comment));
  } catch (error) {
    transaction.abort();
    await done.catch(() => undefined);
    database.close();
    throw error;
  }
  store.put(updated);
  await done;
  database.close();
  emitReviewChange();
}

function publicVersion(record: LocalVersionRecord): DocumentVersion {
  const { storedBytes: _, ...version } = record;
  return version;
}

async function abortReviewTransaction(
  database: IDBDatabase,
  transaction: IDBTransaction,
  done: Promise<void>,
  message: string,
): Promise<never> {
  transaction.abort();
  await done.catch(() => undefined);
  database.close();
  throw new Error(message);
}

const localRepository: ReviewRepository = {
  mode: 'local',
  async listComments(documentId, cursor) {
    return listLocalComments(documentId, cursor);
  },
  async addComment(documentId, author, body, range) {
    const text = checkedMessage(body);
    const item: ReviewComment = {
      id: `comment-${crypto.randomUUID()}`,
      documentId,
      author,
      own: true,
      body: text,
      createdAt: Date.now(),
      editedAt: null,
      deleted: false,
      resolved: false,
      replies: [],
      ...storedRange(range),
    };
    const database = await preparedDatabase();
    const transaction = database.transaction(COMMENT_STORE, 'readwrite');
    const done = completed(transaction);
    const store = transaction.objectStore(COMMENT_STORE);
    const count = await requested(store.index('documentId').count(IDBKeyRange.only(documentId)));
    if (count >= MAX_LOCAL_COMMENTS) {
      return abortReviewTransaction(database, transaction, done, 'Local comment limit reached.');
    }
    store.add(item);
    await done;
    database.close();
    emitReviewChange();
    return item;
  },
  async updateComment(documentId, id, patch) {
    if (patch.body === undefined && patch.resolved === undefined) {
      throw new Error('No review thread change was requested.');
    }
    const text = patch.body === undefined ? undefined : checkedMessage(patch.body);
    await mutateLocalComment(documentId, id, (item) => ({
      ...item,
      ...(patch.resolved === undefined ? {} : { resolved: patch.resolved }),
      ...(text === undefined
        ? {}
        : { body: text, deleted: false, editedAt: Date.now() }),
    }));
  },
  async deleteComment(documentId, id) {
    await mutateLocalComment(documentId, id, (item) => ({
      ...item,
      body: '',
      deleted: true,
    }));
  },
  async addReply(documentId, commentId, author, body) {
    const text = checkedMessage(body);
    const reply: ReviewReply = {
      id: `reply-${crypto.randomUUID()}`,
      author,
      own: true,
      body: text,
      createdAt: Date.now(),
      editedAt: null,
      deleted: false,
    };
    await mutateLocalComment(documentId, commentId, (item) => {
      if (item.replies.length >= MAX_LOCAL_REPLIES) {
        throw new Error('Local reply limit reached.');
      }
      return { ...item, replies: [...item.replies, reply] };
    });
  },
  async updateReply(documentId, commentId, replyId, body) {
    const text = checkedMessage(body);
    await mutateLocalComment(documentId, commentId, (item) => {
      let found = false;
      const replies = item.replies.map((reply) => {
        if (reply.id !== replyId) return reply;
        found = true;
        return { ...reply, body: text, editedAt: Date.now(), deleted: false };
      });
      if (!found) throw new Error('Review reply not found.');
      return { ...item, replies };
    });
  },
  async deleteReply(documentId, commentId, replyId) {
    await mutateLocalComment(documentId, commentId, (item) => {
      let found = false;
      const replies = item.replies.map((reply) => {
        if (reply.id !== replyId) return reply;
        found = true;
        return { ...reply, body: '', deleted: true };
      });
      if (!found) throw new Error('Review reply not found.');
      return { ...item, replies };
    });
  },
  async listVersions(documentId, currentText) {
    const current: DocumentVersion = {
      id: `current-${documentId}`,
      documentId,
      label: 'Current document',
      author: 'This browser',
      createdAt: Date.now(),
      chars: currentText.length,
      markdown: currentText,
      current: true,
    };
    const database = await preparedDatabase();
    const transaction = database.transaction(VERSION_STORE, 'readonly');
    const done = completed(transaction);
    const records = await requested<LocalVersionRecord[]>(
      transaction.objectStore(VERSION_STORE).index('documentId').getAll(documentId),
    );
    await done;
    database.close();
    records.sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
    return [current, ...records.map(publicVersion)];
  },
  async createVersion(documentId, author, label, markdown) {
    const versionLabel = label.trim();
    if (!versionLabel || textEncoder.encode(versionLabel).byteLength > 160) {
      throw new Error('Invalid local version label.');
    }
    const storedBytes = textEncoder.encode(markdown).byteLength;
    const version: DocumentVersion = {
      id: `version-${crypto.randomUUID()}`,
      documentId,
      label: versionLabel,
      author,
      createdAt: Date.now(),
      chars: markdown.length,
      markdown,
    };
    const database = await preparedDatabase();
    const transaction = database.transaction([VERSION_STORE, META_STORE], 'readwrite');
    const done = completed(transaction);
    const metadataStore = transaction.objectStore(META_STORE);
    const meta = await requested<LocalReviewMeta | undefined>(metadataStore.get(documentId)) ?? {
      documentId,
      versionCount: 0,
      versionBytes: 0,
    };
    if (
      meta.versionCount >= MAX_LOCAL_VERSIONS
      || meta.versionBytes + storedBytes > MAX_LOCAL_VERSION_BYTES
    ) {
      return abortReviewTransaction(
        database,
        transaction,
        done,
        'Local version storage limit reached.',
      );
    }
    transaction.objectStore(VERSION_STORE).add({ ...version, storedBytes });
    metadataStore.put({
      documentId,
      versionCount: meta.versionCount + 1,
      versionBytes: meta.versionBytes + storedBytes,
    } satisfies LocalReviewMeta);
    await done;
    database.close();
    emitReviewChange();
    return version;
  },
  async getVersion(documentId, id) {
    const database = await preparedDatabase();
    const transaction = database.transaction(VERSION_STORE, 'readonly');
    const done = completed(transaction);
    const record = await requested<LocalVersionRecord | undefined>(
      transaction.objectStore(VERSION_STORE).get(id),
    );
    await done;
    database.close();
    return record?.documentId === documentId ? publicVersion(record) : null;
  },
  async deleteVersion(documentId, id) {
    const database = await preparedDatabase();
    const transaction = database.transaction([VERSION_STORE, META_STORE], 'readwrite');
    const done = completed(transaction);
    const versionStore = transaction.objectStore(VERSION_STORE);
    const record = await requested<LocalVersionRecord | undefined>(versionStore.get(id));
    if (!record || record.documentId !== documentId) {
      await done;
      database.close();
      return;
    }
    versionStore.delete(id);
    const metadataStore = transaction.objectStore(META_STORE);
    const meta = await requested<LocalReviewMeta | undefined>(metadataStore.get(documentId));
    metadataStore.put({
      documentId,
      versionCount: Math.max(0, (meta?.versionCount ?? 1) - 1),
      versionBytes: Math.max(0, (meta?.versionBytes ?? record.storedBytes) - record.storedBytes),
    } satisfies LocalReviewMeta);
    await done;
    database.close();
    emitReviewChange();
  },
  subscribe,
};

const serviceRepository: ReviewRepository = {
  mode: 'service',
  async listComments(documentId, cursor) {
    const page = await (await loadServiceApi()).listDocumentComments(documentId, cursor);
    if (page.repliesTruncated) {
      throw new Error('service violated the bounded reply-page invariant');
    }
    return { comments: page.comments, nextCursor: page.nextCursor };
  },
  async addComment(documentId, _author, body, range) {
    const { comment } = await (await loadServiceApi()).createDocumentComment(
      documentId,
      { body, ...storedRange(range) },
    );
    emitReviewChange();
    return comment;
  },
  async updateComment(documentId, id, patch) {
    await (await loadServiceApi()).updateDocumentComment(documentId, id, patch);
    emitReviewChange();
  },
  async deleteComment(documentId, id) {
    await (await loadServiceApi()).deleteDocumentComment(documentId, id);
    emitReviewChange();
  },
  async addReply(documentId, commentId, _author, body) {
    await (await loadServiceApi()).createDocumentCommentReply(documentId, commentId, body);
    emitReviewChange();
  },
  async updateReply(documentId, commentId, replyId, body) {
    await (await loadServiceApi()).updateDocumentCommentReply(documentId, commentId, replyId, body);
    emitReviewChange();
  },
  async deleteReply(documentId, commentId, replyId) {
    await (await loadServiceApi()).deleteDocumentCommentReply(documentId, commentId, replyId);
    emitReviewChange();
  },
  async listVersions(documentId, currentText) {
    const { versions: saved } = await (await loadServiceApi()).listDocumentVersions(documentId);
    return [
      {
        id: `current-${documentId}`,
        documentId,
        label: 'Current document',
        author: 'Live document',
        createdAt: Date.now(),
        chars: currentText.length,
        markdown: currentText,
        current: true,
      },
      ...saved,
    ];
  },
  async createVersion(documentId, _author, label, _markdown) {
    const { version } = await (await loadServiceApi()).createDocumentVersion(
      documentId,
      label.trim() || 'Untitled version',
    );
    emitReviewChange();
    return version;
  },
  async getVersion(documentId, id) {
    const { version, markdown } = await (await loadServiceApi()).getDocumentVersion(documentId, id);
    return { ...version, markdown };
  },
  async deleteVersion(documentId, id) {
    await (await loadServiceApi()).deleteDocumentVersion(documentId, id);
    emitReviewChange();
  },
  subscribe,
};

export const reviewRepository = UI_DATA_MODE === 'service' ? serviceRepository : localRepository;
