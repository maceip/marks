import { MARKS_MAX_DOCUMENT_UNITS } from '../collab/profile.ts';
import { materializeDocumentDraft, type LocalDocumentDraft } from '../demo/workspace.ts';

const DOCUMENT_CREATE_REQUEST_PREFIX = 'marks:document-create-request:v1:';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_REQUEST_SCOPE_UNITS = MARKS_MAX_DOCUMENT_UNITS + 8_192;

type RequestStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
interface PendingDocumentCreateRequest {
  requestId: string;
  draft: {
    title?: string;
    content: string;
  };
}

interface StoredDocumentCreateRequest extends PendingDocumentCreateRequest {
  scope: string;
}

const volatilePendingRequests = new Map<string, StoredDocumentCreateRequest>();

/** The semantic action identity; request UUIDs themselves are never derived. */
export function documentCreateRequestScope(draft: LocalDocumentDraft = {}): string {
  if (draft.requestScope) return `named\0${draft.requestScope}`;
  if (draft.templateId) return `template\0${draft.templateId}`;
  const materialized = materializeDocumentDraft(draft);
  if (!materialized.title && !materialized.content) return 'blank';
  const title = materialized.title;
  const titleIdentity = title === undefined ? 'none' : `some:${title.length}:${title}`;
  return `content\0${titleIdentity}\0${materialized.content.length}:${materialized.content}`;
}

export function documentDuplicateRequestScope(documentId: string): string {
  return `duplicate\0${documentId}`;
}

/**
 * Keep one retry identity per create action until the server confirms its
 * slug. A committed POST whose response was lost can therefore replay after
 * a reload instead of publishing a second anonymous page.
 */
export function pendingDocumentCreateRequestId(
  scope: string,
  storage: RequestStorage = sessionStorage,
  makeId: () => string = () => crypto.randomUUID(),
): string {
  return pendingDocumentCreateRequest(scope, { content: '' }, storage, makeId).requestId;
}

/**
 * Preserve the exact normalized payload alongside its retry UUID. If a client
 * update changes starter or template copy after the first POST commits, the
 * retry still has the original server payload hash and can recover that slug.
 */
export function pendingDocumentCreateRequest(
  scope: string,
  draft: PendingDocumentCreateRequest['draft'],
  storage: RequestStorage = sessionStorage,
  makeId: () => string = () => crypto.randomUUID(),
): PendingDocumentCreateRequest {
  validateScopeAndDraft(scope, draft);
  const key = requestStorageKey(scope);
  let persisted: StoredDocumentCreateRequest | null;
  try {
    persisted = parseStoredRequest(storage.getItem(key), scope);
  } catch {
    persisted = null;
  }
  if (persisted && (!scope.startsWith('content\0') || sameDraft(persisted.draft, draft))) {
    return { requestId: persisted.requestId, draft: persisted.draft };
  }
  const volatile = volatilePendingRequests.get(scope);
  if (volatile) {
    return { requestId: volatile.requestId, draft: volatile.draft };
  }
  const requestId = makeId();
  if (!UUID.test(requestId)) throw new TypeError('document create request id must be a UUID');
  const created: StoredDocumentCreateRequest = {
    scope: storedScope(scope),
    requestId,
    draft: { ...draft },
  };
  volatilePendingRequests.set(scope, created);
  try {
    storage.setItem(key, JSON.stringify(created));
  } catch {
    // Storage-denied or quota-limited browsers retain the full request for the
    // current page lifetime. The request remains idempotent within that page.
  }
  return { requestId, draft: created.draft };
}

export function confirmDocumentCreateRequest(
  scope: string,
  requestId: string,
  storage: RequestStorage = sessionStorage,
): void {
  const key = requestStorageKey(scope);
  if (volatilePendingRequests.get(scope)?.requestId === requestId) {
    volatilePendingRequests.delete(scope);
  }
  try {
    if (parseStoredRequest(storage.getItem(key), scope)?.requestId === requestId) {
      storage.removeItem(key);
    }
  } catch {
    // The volatile identity above still prevents duplicate work on this page.
  }
}

function parseStoredRequest(raw: string | null, scope: string): StoredDocumentCreateRequest | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<StoredDocumentCreateRequest>;
    if (
      value.scope !== storedScope(scope) ||
      typeof value.requestId !== 'string' ||
      !UUID.test(value.requestId) ||
      !value.draft ||
      typeof value.draft.content !== 'string' ||
      (value.draft.title !== undefined && typeof value.draft.title !== 'string')
    ) {
      return null;
    }
    validateScopeAndDraft(scope, value.draft);
    return {
      scope: storedScope(scope),
      requestId: value.requestId,
      draft: { title: value.draft.title, content: value.draft.content },
    };
  } catch {
    return null;
  }
}

function validateScopeAndDraft(
  scope: string,
  draft: PendingDocumentCreateRequest['draft'],
): void {
  if (!scope || scope.length > MAX_REQUEST_SCOPE_UNITS) {
    throw new TypeError('document create request scope is invalid');
  }
  if (
    typeof draft.content !== 'string' ||
    draft.content.length > MARKS_MAX_DOCUMENT_UNITS ||
    (draft.title !== undefined &&
      (typeof draft.title !== 'string' || new TextEncoder().encode(draft.title).byteLength > 512))
  ) {
    throw new TypeError('document create request draft is invalid');
  }
}

function requestStorageKey(scope: string): string {
  // Two independent 32-bit accumulators keep storage keys short. The stored
  // record carries either the exact semantic scope or the exact normalized
  // draft, so this non-cryptographic digest is never treated as authority.
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < scope.length; index += 1) {
    const unit = scope.charCodeAt(index);
    first = Math.imul(first ^ unit, 0x01000193);
    second = Math.imul(second ^ (unit + index), 0x85ebca6b);
  }
  const digest = `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0)
    .toString(16)
    .padStart(8, '0')}`;
  return `${DOCUMENT_CREATE_REQUEST_PREFIX}${scope.length}:${digest}`;
}

function storedScope(scope: string): string {
  // The normalized draft itself distinguishes content actions, so do not
  // duplicate up to one million Markdown units in sessionStorage metadata.
  return scope.startsWith('content\0') ? 'content' : scope;
}

function sameDraft(
  left: PendingDocumentCreateRequest['draft'],
  right: PendingDocumentCreateRequest['draft'],
): boolean {
  return left.title === right.title && left.content === right.content;
}
