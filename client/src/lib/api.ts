export interface DocumentMeta {
  id: string;
  title: string;
  /**
   * `esbt` for every document this client can open. Rows created by the
   * retired Loro/Yjs engines keep their original value; they are listed but
   * refused, since their binary formats need runtimes marks no longer ships.
   */
  engine: string;
  chars: number;
  created_at: number;
  updated_at: number;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
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

export function createDocument(): Promise<{ document: DocumentMeta }> {
  return request('/v1/documents', { method: 'POST', body: JSON.stringify({}) });
}

export function deleteDocument(id: string): Promise<{ deleted: boolean }> {
  return request(`/v1/documents/${id}`, { method: 'DELETE' });
}

export function exportUrl(id: string): string {
  return `/v1/documents/${id}/export`;
}
