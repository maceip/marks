import { runWithTimeout } from '../browser/network.ts';
import { MARKS_MAX_DOCUMENT_UNITS } from '../collab/profile.ts';
import {
  isDocumentImportWorkerResponse,
  type DocumentImportWorkerRequest,
  type DocumentImportWorkerResponse,
} from './document-import-protocol.ts';
import { MarkdownImportError, type MarkdownImport } from './markdown-import.ts';

/** Matches the edge and native import ceiling. */
export const MAX_BROWSER_IMPORT_BYTES = 12 * 1024 * 1024;
/** Leaves the server's 30-second worker budget plus a small browser margin. */
export const BROWSER_IMPORT_TIMEOUT_MS = 35_000;

export interface PdfImportFile {
  name: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

interface ImportWorker {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: DocumentImportWorkerRequest, transfer: Transferable[]): void;
  terminate(): void;
}

export interface PdfImportOptions {
  timeoutMs?: number;
  createWorker?: () => ImportWorker;
}

function createImportWorker(): ImportWorker {
  return new Worker(
    new URL('../workers/document-import.worker.ts', import.meta.url),
    { type: 'module', name: 'marks-document-import' },
  );
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The PDF import was cancelled.', 'AbortError');
}

function titleFromFilename(name: string): string {
  return name.replace(/\.pdf$/iu, '').trim().slice(0, 90) || 'Imported PDF';
}

function conversionError(response: Extract<DocumentImportWorkerResponse, { type: 'error' }>): Error {
  switch (response.code) {
    case 'encrypted':
      return new MarkdownImportError('Password-protected PDFs cannot be imported.');
    case 'unsupported':
      return new MarkdownImportError('This PDF has no extractable text. Scanned pages require OCR.');
    case 'resourceLimit':
      return new MarkdownImportError('The PDF exceeds the browser converter safety limits.');
    case 'malformed':
    case 'missingPart':
      return new MarkdownImportError('This PDF is incomplete or malformed.');
    default:
      return new Error(response.message || 'Marks could not convert this PDF.');
  }
}

function convertPdfBytes(
  bytes: ArrayBuffer,
  signal: AbortSignal,
  createWorker: () => ImportWorker,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const worker = createWorker();
    let settled = false;

    const settle = (result: { markdown: string } | { error: unknown }): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      worker.terminate();
      if ('error' in result) reject(result.error);
      else resolve(result.markdown);
    };
    const onAbort = () => settle({ error: abortReason(signal) });

    worker.onmessage = (event) => {
      if (!isDocumentImportWorkerResponse(event.data)) {
        settle({ error: new Error('The PDF converter returned an invalid response.') });
        return;
      }
      if (event.data.type === 'error') settle({ error: conversionError(event.data) });
      else settle({ markdown: event.data.markdown });
    };
    worker.onmessageerror = () => {
      settle({ error: new Error('The PDF converter returned an unreadable response.') });
    };
    worker.onerror = () => {
      settle({ error: new Error('The browser PDF converter stopped unexpectedly.') });
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }

    try {
      worker.postMessage({ type: 'convert', format: 'pdf', bytes }, [bytes]);
    } catch (error) {
      settle({ error });
    }
  });
}

/**
 * Convert PDF bytes entirely in a disposable browser worker. The worker owns
 * the synchronous Wasm call, so the main thread remains responsive and a hard
 * deadline can terminate conversion even if Wasm itself cannot be interrupted.
 */
export async function readPdfImport(
  file: PdfImportFile,
  options: PdfImportOptions = {},
): Promise<MarkdownImport> {
  if (!/\.pdf$/iu.test(file.name)) {
    throw new MarkdownImportError('Choose a .pdf file.');
  }
  if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_BROWSER_IMPORT_BYTES) {
    throw new MarkdownImportError('PDF imports are limited to 12 MiB.');
  }

  try {
    return await runWithTimeout(async (signal) => {
      const bytes = await file.arrayBuffer();
      if (signal.aborted) throw abortReason(signal);
      if (bytes.byteLength !== file.size || bytes.byteLength > MAX_BROWSER_IMPORT_BYTES) {
        throw new MarkdownImportError('The PDF changed while it was being read or exceeds 12 MiB.');
      }

      const markdown = (await convertPdfBytes(
        bytes,
        signal,
        options.createWorker ?? createImportWorker,
      )).replace(/\r\n?/gu, '\n');
      if (!markdown.trim()) {
        throw new MarkdownImportError('This PDF has no extractable text. Scanned pages require OCR.');
      }
      if (markdown.length > MARKS_MAX_DOCUMENT_UNITS) {
        throw new MarkdownImportError('The converted Markdown exceeds the shared document-size policy.');
      }
      return { title: titleFromFilename(file.name), content: markdown };
    }, options.timeoutMs ?? BROWSER_IMPORT_TIMEOUT_MS);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      throw new Error('PDF conversion timed out. Try a smaller or simpler document.', { cause: error });
    }
    throw error;
  }
}
