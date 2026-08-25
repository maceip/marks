export type BrowserDocumentFormat = 'pdf';

export interface DocumentImportWorkerRequest {
  type: 'convert';
  format: BrowserDocumentFormat;
  bytes: ArrayBuffer;
}

export type DocumentImportWorkerResponse =
  | { type: 'converted'; markdown: string }
  | { type: 'error'; code?: string; message: string };

export function isDocumentImportWorkerResponse(
  value: unknown,
): value is DocumentImportWorkerResponse {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.type === 'converted') return typeof candidate.markdown === 'string';
  return candidate.type === 'error'
    && (candidate.code === undefined || typeof candidate.code === 'string')
    && typeof candidate.message === 'string';
}
