import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  DocumentImportWorkerRequest,
  DocumentImportWorkerResponse,
} from './document-import-protocol.ts';
import {
  MAX_BROWSER_IMPORT_BYTES,
  readPdfImport,
} from './wasm-document-import.ts';

class FakeWorker {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  request: DocumentImportWorkerRequest | null = null;
  transfer: Transferable[] = [];
  terminated = false;
  private readonly response?: DocumentImportWorkerResponse;

  constructor(response?: DocumentImportWorkerResponse) {
    this.response = response;
  }

  postMessage(message: DocumentImportWorkerRequest, transfer: Transferable[]): void {
    this.request = message;
    this.transfer = transfer;
    if (this.response) queueMicrotask(() => this.onmessage?.({ data: this.response } as MessageEvent));
  }

  terminate(): void {
    this.terminated = true;
  }
}

test('PDF import transfers bytes to the Wasm worker and returns bounded Markdown', async () => {
  const worker = new FakeWorker({ type: 'converted', markdown: '# One\r\n\rTwo\r' });
  const imported = await readPdfImport({
    name: '  Product brief.pdf',
    size: 4,
    async arrayBuffer() { return new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer; },
  }, { createWorker: () => worker });

  assert.deepEqual(imported, { title: 'Product brief', content: '# One\n\nTwo\n' });
  assert.equal(worker.request?.format, 'pdf');
  assert.equal(worker.transfer.length, 1);
  assert.equal(worker.terminated, true);
});

test('PDF import rejects extension, byte overflow, and encrypted documents', async () => {
  await assert.rejects(
    readPdfImport({ name: 'notes.docx', size: 1, async arrayBuffer() { return new ArrayBuffer(1); } }),
    /\.pdf/,
  );
  await assert.rejects(
    readPdfImport({ name: 'huge.pdf', size: MAX_BROWSER_IMPORT_BYTES + 1, async arrayBuffer() { return new ArrayBuffer(0); } }),
    /12 MiB/,
  );
  await assert.rejects(
    readPdfImport(
      { name: 'locked.pdf', size: 1, async arrayBuffer() { return new ArrayBuffer(1); } },
      { createWorker: () => new FakeWorker({ type: 'error', code: 'encrypted', message: 'locked' }) },
    ),
    /Password-protected/,
  );
});

test('PDF import hard deadline terminates a non-cooperative Wasm worker', async () => {
  const worker = new FakeWorker();
  const started = Date.now();
  await assert.rejects(
    readPdfImport(
      { name: 'slow.pdf', size: 1, async arrayBuffer() { return new ArrayBuffer(1); } },
      { createWorker: () => worker, timeoutMs: 25 },
    ),
    /timed out/,
  );
  assert.equal(worker.terminated, true);
  assert.ok(Date.now() - started < 500);
});
