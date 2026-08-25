/// <reference lib="webworker" />

import initAnydoc, { toMarkdownBytes } from '@firecrawl/anydoc-wasm';
import type {
  DocumentImportWorkerRequest,
  DocumentImportWorkerResponse,
} from '../lib/document-import-protocol.ts';

const ready = initAnydoc();

function post(message: DocumentImportWorkerResponse): void {
  (self as unknown as Worker).postMessage(message);
}

function errorDetail(error: unknown): { code?: string; message: string } {
  if (!(error instanceof Error)) return { message: 'The PDF converter failed.' };
  const code = (error as Error & { code?: unknown }).code;
  return {
    ...(typeof code === 'string' ? { code } : {}),
    message: error.message || 'The PDF converter failed.',
  };
}

(self as unknown as Worker).onmessage = async (
  event: MessageEvent<DocumentImportWorkerRequest>,
) => {
  const request = event.data;
  if (request?.type !== 'convert' || request.format !== 'pdf' || !(request.bytes instanceof ArrayBuffer)) {
    post({ type: 'error', code: 'malformed', message: 'The PDF import request was malformed.' });
    return;
  }

  try {
    await ready;
    const markdown = toMarkdownBytes(new Uint8Array(request.bytes), request.format);
    post({ type: 'converted', markdown });
  } catch (error) {
    post({ type: 'error', ...errorDetail(error) });
  }
};
