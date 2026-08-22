export interface DocumentMeta {
  id: string;
  title: string;
  /** `esbt` for documents this client can open. Unknown engine tags stay closed. */
  engine: string;
  chars: number;
  created_at: number;
  updated_at: number;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  if (!response.ok) throw new Error(`${init?.method ?? 'GET'} ${path} failed: ${response.status}`);
  return (await response.json()) as T;
}

export function listDocuments(): Promise<{ documents: DocumentMeta[] }> {
  return request('/v1/documents');
}

export function getDocument(id: string): Promise<{ document: DocumentMeta; connections: number }> {
  return request(`/v1/documents/${id}`);
}

export function createDocument(draft?: { title?: string }): Promise<{ document: DocumentMeta }> {
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

export function exportUrl(id: string): string {
  return `/v1/documents/${id}/export`;
}
