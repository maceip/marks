import { applyServiceCallerHeaders, ensureServiceCaller } from '../auth/caller';
import { getCachedSession } from '../auth/session-cache.ts';
import { ServiceError } from './service-errors';

export interface DocumentMeta {
  id: string;
  /** Opaque, copyable collaboration slug. Service documents use the id itself. */
  slug?: string;
  title: string;
  /** `esbt` for documents this client can open. Unknown engine tags stay closed. */
  engine: string;
  chars: number;
  created_at: number;
  updated_at: number;
  deleted_at?: number | null;
  purge_at?: number | null;
  public?: boolean;
  public_role?: AccessRole | null;
  anonymous_edits?: number;
  persisted?: boolean;
  persisted_at?: number | null;
}

export type AccessRole = 'owner' | 'editor' | 'commenter' | 'viewer';

export interface DocumentShare {
  principalId: string;
  role: Exclude<AccessRole, 'owner'>;
}

export interface ReviewCommentDto {
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
  replies: ReviewReplyDto[];
}

export interface ReviewReplyDto {
  id: string;
  author: string;
  own: boolean;
  body: string;
  createdAt: number;
  editedAt: number | null;
  deleted: boolean;
}

export interface DocumentVersionDto {
  id: string;
  documentId: string;
  label: string;
  author: string;
  createdAt: number;
  chars: number;
}

export interface DocumentAssetDto {
  id: string;
  url: string;
  filename: string;
  mediaType: string;
  bytes: number;
}

export interface ImportedMarkdownDto {
  title: string;
  markdown: string;
  kind: 'markdown' | 'pdf' | 'word' | 'excel' | 'url';
  sourceUrl?: string | null;
}

export async function authenticatedResponse(path: string, init?: RequestInit): Promise<Response> {
  let caller = await ensureServiceCaller();
  const perform = () => {
    const headers = new Headers(init?.headers);
    applyServiceCallerHeaders(headers, caller);
    return fetch(path, { ...init, credentials: 'same-origin', headers });
  };
  let response = await perform();
  if (response.status === 401 && caller.kind === 'scratch') {
    caller = await ensureServiceCaller({ forceProbe: true });
    response = await perform();
  }
  if (!response.ok) throw new ServiceError(response.status);
  return response;
}

async function csrfRequest<T>(path: string, body: unknown): Promise<T> {
  let caller = await ensureServiceCaller();
  if (caller.kind === 'session' && !getCachedSession()) {
    caller = await ensureServiceCaller({ forceProbe: true });
  }
  const headers = new Headers({ 'Content-Type': 'application/json' });
  applyServiceCallerHeaders(headers, caller);
  if (caller.kind === 'session') {
    const session = getCachedSession();
    if (!session) throw new ServiceError(401);
    headers.set('X-Marks-CSRF', session.csrf);
  }
  const response = await fetch(path, {
    method: 'POST',
    body: JSON.stringify(body),
    headers,
    credentials: 'same-origin',
  });
  if (!response.ok) throw new ServiceError(response.status);
  return (await response.json()) as T;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set('Content-Type', 'application/json');
  const response = await authenticatedResponse(path, { ...init, headers });
  return (await response.json()) as T;
}

export function listDocuments(): Promise<{ documents: DocumentMeta[] }> {
  return request('/v1/documents');
}

export function getDocument(id: string): Promise<{ document: DocumentMeta; connections: number }> {
  return request(`/v1/documents/${id}`);
}

export function createDocument(draft?: { title?: string; markdown?: string }): Promise<{ document: DocumentMeta }> {
  return request('/v1/documents', { method: 'POST', body: JSON.stringify(draft ?? {}) });
}

export function renameDocument(id: string, title: string): Promise<{ document: DocumentMeta }> {
  return request(`/v1/documents/${id}`, { method: 'PATCH', body: JSON.stringify({ title }) });
}

export function duplicateDocument(id: string): Promise<{ document: DocumentMeta }> {
  return request(`/v1/documents/${id}/duplicate`, { method: 'POST', body: JSON.stringify({}) });
}

export function deleteDocument(id: string): Promise<{ deleted: boolean }> {
  return request(`/v1/documents/${id}`, { method: 'DELETE' });
}

export function listTrash(): Promise<{ documents: DocumentMeta[]; retentionMs: number }> {
  return request('/v1/trash');
}

export function restoreDocument(id: string): Promise<{ document: DocumentMeta }> {
  return request(`/v1/documents/${encodeURIComponent(id)}/restore`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export function purgeDocument(id: string): Promise<{ purged: boolean }> {
  return request(`/v1/documents/${encodeURIComponent(id)}/purge`, { method: 'DELETE' });
}

export function exportUrl(id: string): string {
  return `/v1/documents/${id}/export`;
}

function assetFilename(name: string): string {
  const safe = name
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._ -]+/gu, '_')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 160);
  return safe || 'image';
}

export async function uploadDocumentAsset(
  id: string,
  file: Blob & { name?: string },
): Promise<{ asset: DocumentAssetDto }> {
  const response = await authenticatedResponse(
    `/v1/documents/${encodeURIComponent(id)}/assets`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Marks-Filename': assetFilename(file.name ?? 'image'),
      },
      body: file,
    },
  );
  return (await response.json()) as { asset: DocumentAssetDto };
}

export async function importDocumentFile(file: File): Promise<ImportedMarkdownDto> {
  const response = await authenticatedResponse('/v1/import/file', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Marks-Filename': assetFilename(file.name),
    },
    body: file,
  });
  return (await response.json()) as ImportedMarkdownDto;
}

export function importWebPage(url: string): Promise<ImportedMarkdownDto> {
  return csrfRequest('/v1/import/url', { url });
}

export async function downloadDocumentBundle(id: string): Promise<Blob> {
  const response = await authenticatedResponse(
    `/v1/documents/${encodeURIComponent(id)}/export-bundle`,
    { headers: { Accept: 'application/zip' } },
  );
  return response.blob();
}

export async function downloadDocumentMarkdown(id: string): Promise<string> {
  const response = await authenticatedResponse(
    `/v1/documents/${encodeURIComponent(id)}/export`,
    { headers: { Accept: 'text/markdown' } },
  );
  return response.text();
}

export function listDocumentAssets(id: string): Promise<{ assets: DocumentAssetDto[] }> {
  return request(`/v1/documents/${encodeURIComponent(id)}/assets`);
}

export interface ExternalLinkCheckDto {
  url: string;
  status: 'reachable' | 'redirected' | 'missing' | 'blocked' | 'unavailable';
  httpStatus: number | null;
  finalUrl: string | null;
  checkedAtMs: number;
}

export function checkDocumentLinks(
  id: string,
  urls: string[],
): Promise<{ checks: ExternalLinkCheckDto[] }> {
  return csrfRequest(`/v1/documents/${encodeURIComponent(id)}/link-checks`, { urls });
}

export interface CitationLookupDto {
  doi: string;
  title: string;
  authors: string[];
  publisher: string;
  published: string | null;
  url: string;
  citation: string;
}

export function lookupDocumentCitation(
  id: string,
  doi: string,
): Promise<{ citation: CitationLookupDto }> {
  return csrfRequest(`/v1/documents/${encodeURIComponent(id)}/citation-lookup`, { doi });
}

export function listDocumentShares(id: string): Promise<{ shares: DocumentShare[] }> {
  return request(`/v1/documents/${encodeURIComponent(id)}/shares`);
}

export function putDocumentShare(
  id: string,
  principalId: string,
  role: Exclude<AccessRole, 'owner'>,
): Promise<{ role: Exclude<AccessRole, 'owner'> }> {
  return request(
    `/v1/documents/${encodeURIComponent(id)}/shares/${encodeURIComponent(principalId)}`,
    { method: 'PUT', body: JSON.stringify({ role }) },
  );
}

export function deleteDocumentShare(
  id: string,
  principalId: string,
): Promise<{ revoked: boolean }> {
  return request(
    `/v1/documents/${encodeURIComponent(id)}/shares/${encodeURIComponent(principalId)}`,
    { method: 'DELETE' },
  );
}

export function createDocumentLink(
  id: string,
  role: Exclude<AccessRole, 'owner'>,
  ttlMs: number,
): Promise<{ token: string; role: Exclude<AccessRole, 'owner'>; expiresAtMs: number }> {
  return request(`/v1/documents/${encodeURIComponent(id)}/link`, {
    method: 'POST',
    body: JSON.stringify({ role, ttlMs }),
  });
}

export function revokeDocumentLink(id: string): Promise<{ revoked: boolean }> {
  return request(`/v1/documents/${encodeURIComponent(id)}/link`, { method: 'DELETE' });
}

export function redeemDocumentLink(id: string, token: string): Promise<{ role: AccessRole }> {
  return request(`/v1/documents/${encodeURIComponent(id)}/link/redeem`, {
    method: 'POST',
    body: JSON.stringify({ token }),
  });
}

export function listDocumentComments(id: string, cursor?: string): Promise<{
  comments: ReviewCommentDto[];
  hasMore: boolean;
  nextCursor: string | null;
  repliesTruncated: boolean;
}> {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
  return request(`/v1/documents/${encodeURIComponent(id)}/comments${query}`);
}

export function createDocumentComment(
  id: string,
  comment: {
    body: string;
    startAnchor?: string;
    endAnchor?: string;
    quote?: string;
    startOffset?: number;
    endOffset?: number;
  },
): Promise<{ comment: ReviewCommentDto }> {
  return request(`/v1/documents/${encodeURIComponent(id)}/comments`, {
    method: 'POST',
    body: JSON.stringify(comment),
  });
}

export function updateDocumentComment(
  id: string,
  commentId: string,
  patch: { resolved?: boolean; body?: string },
): Promise<{ updated: boolean }> {
  return request(
    `/v1/documents/${encodeURIComponent(id)}/comments/${encodeURIComponent(commentId)}`,
    { method: 'PUT', body: JSON.stringify(patch) },
  );
}

export function deleteDocumentComment(
  id: string,
  commentId: string,
): Promise<{ deleted: boolean }> {
  return request(
    `/v1/documents/${encodeURIComponent(id)}/comments/${encodeURIComponent(commentId)}`,
    { method: 'DELETE' },
  );
}

export function createDocumentCommentReply(
  id: string,
  commentId: string,
  body: string,
): Promise<{ reply: ReviewReplyDto }> {
  return request(
    `/v1/documents/${encodeURIComponent(id)}/comments/${encodeURIComponent(commentId)}/replies`,
    { method: 'POST', body: JSON.stringify({ body }) },
  );
}

export function updateDocumentCommentReply(
  id: string,
  commentId: string,
  replyId: string,
  body: string,
): Promise<{ updated: boolean }> {
  return request(
    `/v1/documents/${encodeURIComponent(id)}/comments/${encodeURIComponent(commentId)}/replies/${encodeURIComponent(replyId)}`,
    { method: 'PUT', body: JSON.stringify({ body }) },
  );
}

export function deleteDocumentCommentReply(
  id: string,
  commentId: string,
  replyId: string,
): Promise<{ deleted: boolean }> {
  return request(
    `/v1/documents/${encodeURIComponent(id)}/comments/${encodeURIComponent(commentId)}/replies/${encodeURIComponent(replyId)}`,
    { method: 'DELETE' },
  );
}

export function listDocumentVersions(
  id: string,
): Promise<{ versions: DocumentVersionDto[]; retention: number }> {
  return request(`/v1/documents/${encodeURIComponent(id)}/versions`);
}

export function createDocumentVersion(
  id: string,
  label: string,
): Promise<{ version: DocumentVersionDto }> {
  return request(`/v1/documents/${encodeURIComponent(id)}/versions`, {
    method: 'POST',
    body: JSON.stringify({ label }),
  });
}

export function getDocumentVersion(
  id: string,
  versionId: string,
): Promise<{ version: DocumentVersionDto; markdown: string }> {
  return request(
    `/v1/documents/${encodeURIComponent(id)}/versions/${encodeURIComponent(versionId)}`,
  );
}

export function deleteDocumentVersion(
  id: string,
  versionId: string,
): Promise<{ deleted: boolean }> {
  return request(
    `/v1/documents/${encodeURIComponent(id)}/versions/${encodeURIComponent(versionId)}`,
    { method: 'DELETE' },
  );
}
