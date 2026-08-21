import { Router } from 'express';
import { LoroDoc } from 'loro-crdt';
import { LoroRoom, TEXT_CONTAINER } from './loro-room.js';
import {
  createDocument,
  deleteDocument,
  getDocument,
  getState,
  listDocuments,
  type Engine,
} from './store.js';
import { yjsTextFromState } from './yjs-room.js';

export const api = Router();

const isEngine = (value: unknown): value is Engine => value === 'loro' || value === 'yjs';

api.get('/health', (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

api.get('/documents', (_req, res) => {
  res.json({ documents: listDocuments() });
});

api.post('/documents', (req, res) => {
  const engine = isEngine(req.body?.engine) ? req.body.engine : 'loro';
  const title = typeof req.body?.title === 'string' ? req.body.title : undefined;
  res.status(201).json({ document: createDocument({ engine, title }) });
});

api.get('/documents/:id', (req, res) => {
  const doc = getDocument(req.params.id);
  if (!doc) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const room = LoroRoom.resident(req.params.id);
  res.json({ document: doc, connections: room?.connections ?? 0 });
});

api.delete('/documents/:id', (req, res) => {
  res.json({ deleted: deleteDocument(req.params.id) });
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

  const shallow = req.query.shallow === '1' && meta.engine === 'loro';
  const room = LoroRoom.resident(id);
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
  const room = LoroRoom.resident(id);
  if (room) return room.text();

  const stored = getState(id);
  if (!stored?.state || stored.state.length === 0) return '';

  if (stored.engine === 'yjs') {
    try {
      return yjsTextFromState(stored.state);
    } catch {
      return '';
    }
  }

  const doc = new LoroDoc();
  try {
    doc.import(stored.state);
    return doc.getText(TEXT_CONTAINER).toString();
  } catch {
    return '';
  }
}
