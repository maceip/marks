import { Router } from 'express';
import { EsbtDoc } from '@marks/esbt';
import { EsbtRoom } from './esbt-room.js';
import {
  createDocument,
  deleteDocument,
  getDocument,
  getState,
  listDocuments,
} from './store.js';

export const api = Router();

api.get('/health', (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

api.get('/documents', (_req, res) => {
  res.json({ documents: listDocuments() });
});

api.post('/documents', (req, res) => {
  const title = typeof req.body?.title === 'string' ? req.body.title : undefined;
  res.status(201).json({ document: createDocument({ engine: 'esbt', title }) });
});

api.get('/documents/:id', (req, res) => {
  const doc = getDocument(req.params.id);
  if (!doc) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const room = EsbtRoom.resident(req.params.id);
  res.json({ document: doc, connections: room?.connections ?? 0 });
});

api.delete('/documents/:id', (req, res) => {
  const id = req.params.id;

  // Remove the row first: any store still in flight for this document then
  // finds it missing and becomes a no-op, rather than racing the teardown.
  const deleted = deleteDocument(id);
  EsbtRoom.discard(id);

  res.json({ deleted });
});

/**
 * Cold-open fast path.
 *
 * A client fetches this over plain HTTP in parallel with opening its
 * WebSocket, so the document paints before the sync handshake finishes. With
 * `?shallow=1` the history is trimmed away, which keeps the payload
 * proportional to the document rather than to how long it has been edited.
 */
api.get('/documents/:id/snapshot', (req, res) => {
  const id = req.params.id;
  const meta = getDocument(id);
  if (!meta) {
    res.status(404).json({ error: 'not found' });
    return;
  }

  const shallow = req.query.shallow === '1' && meta.engine === 'esbt';
  const room = EsbtRoom.resident(id);
  const bytes = room
    ? shallow
      ? room.shallowSnapshot()
      : room.snapshot()
    : (getState(id)?.state ?? null);

  if (!bytes || bytes.length === 0) {
    res.status(204).end();
    return;
  }

  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('X-Marks-Engine', meta.engine);
  res.setHeader('X-Marks-Shallow', shallow ? '1' : '0');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('ETag', `W/"${meta.updated_at}-${bytes.length}"`);
  if (req.headers['if-none-match'] === `W/"${meta.updated_at}-${bytes.length}"`) {
    res.status(304).end();
    return;
  }
  res.end(Buffer.from(bytes));
});

api.get('/documents/:id/export', (req, res) => {
  const meta = getDocument(req.params.id);
  if (!meta) {
    res.status(404).json({ error: 'not found' });
    return;
  }

  const markdown = readMarkdown(req.params.id);
  const filename = `${meta.title.replace(/[^\w.-]+/g, '-').slice(0, 60) || 'document'}.md`;
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.end(markdown);
});

function readMarkdown(id: string): string {
  // Prefer a resident replica: the room persists on a debounce, so the
  // stored row can trail what the editor is showing by several seconds.
  const room = EsbtRoom.resident(id);
  if (room) return room.text();

  const stored = getState(id);
  if (!stored?.state || stored.state.length === 0) return '';

  // Rows written by the retired Loro/Yjs engines are unreadable without
  // their runtimes; they export as empty rather than as garbage.
  if (stored.engine !== 'esbt') return '';

  const doc = new EsbtDoc();
  try {
    doc.import(stored.state);
    return doc.getText();
  } catch {
    return '';
  }
}
