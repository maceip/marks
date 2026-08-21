import type { EngineName } from '../collab/types';

export interface DocumentMeta {
  id: string;
  title: string;
  engine: EngineName;
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
  return request('/api/documents');
}

export function getDocument(id: string): Promise<{ document: DocumentMeta; connections: number }> {
  return request(`/api/documents/${id}`);
}

export function createDocument(engine: EngineName): Promise<{ document: DocumentMeta }> {
  return request('/api/documents', { method: 'POST', body: JSON.stringify({ engine }) });
}

export function deleteDocument(id: string): Promise<{ deleted: boolean }> {
  return request(`/api/documents/${id}`, { method: 'DELETE' });
}

export function exportUrl(id: string): string {
  return `/api/documents/${id}/export`;
}
