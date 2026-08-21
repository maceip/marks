import compression from 'compression';
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { api } from './api.js';
import { CLIENT_DIST, HOST, PORT } from './config.js';
import { LoroRoom } from './loro-room.js';
import { seedIfEmpty } from './seed.js';
import { databaseFile, getDocument, isRecentlyDeleted } from './store.js';
import { handleYjsConnection, hocuspocus } from './yjs-room.js';

const app = express();
app.use(compression());
app.use(express.json({ limit: '1mb' }));
app.use('/api', api);

const hasClientBuild = fs.existsSync(path.join(CLIENT_DIST, 'index.html'));
if (hasClientBuild) {
  app.use(
    express.static(CLIENT_DIST, {
      index: false,
      setHeaders: (res, filePath) => {
        // Vite fingerprints everything under /assets, so it can be cached hard.
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    }),
  );
  // SPA fallback: any non-API path renders the client shell.
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api')) return next();
    res.sendFile(path.join(CLIENT_DIST, 'index.html'));
  });
}

function safeBase64(value: string): Uint8Array | undefined {
  try {
    const bytes = Buffer.from(value, 'base64url');
    return bytes.length > 0 && bytes.length <= 8_192 ? new Uint8Array(bytes) : undefined;
  } catch {
    return undefined;
  }
}

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

/**
 * `/collab/loro/<documentId>` — one socket per document.
 * `/collab/yjs` — Hocuspocus multiplexes every document over one socket and
 * carries the document name in the sync protocol, so no id appears in the path.
 */
const COLLAB_PATH = /^\/collab\/(loro|yjs)(?:\/([\w-]{1,64}))?$/;

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const match = COLLAB_PATH.exec(url.pathname);

  if (!match) {
    socket.destroy();
    return;
  }

  const [, engine, documentId] = match;
  if (engine === 'loro' && !documentId) {
    socket.destroy();
    return;
  }

  // The two CRDTs have incompatible binary formats. Connecting the wrong
  // protocol to an existing document would hand it an empty replica, and the
  // first edit would overwrite the stored state with an unreadable one.
  // Unknown ids are still allowed through, so a URL can create a document.
  if (documentId) {
    const existing = getDocument(documentId);
    if (existing && existing.engine !== engine) {
      socket.destroy();
      return;
    }
    // A client that was connected when the document was deleted will try to
    // reconnect; letting it through would recreate what was just deleted.
    if (!existing && isRecentlyDeleted(documentId)) {
      socket.destroy();
      return;
    }
  }

  // Clients that already hold state announce it, so we can answer with a delta.
  const have = url.searchParams.get('vv');
  const vv = have ? safeBase64(have) : undefined;

  wss.handleUpgrade(request, socket, head, (ws) => {
    if (engine === 'loro') {
      LoroRoom.open(documentId).join(ws, vv);
    } else {
      handleYjsConnection(ws, request);
    }
  });
});

seedIfEmpty();

server.listen(PORT, HOST, () => {
  console.log(`[marks] listening on http://${HOST}:${PORT}`);
  console.log(`[marks] database ${databaseFile()}`);
  if (!hasClientBuild) {
    console.log('[marks] no client build found — run the Vite dev server for the UI');
  }
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[marks] ${signal} received, flushing documents`);
  await LoroRoom.flushAll();
  hocuspocus.flushPendingStores();
  hocuspocus.closeConnections();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3_000).unref();
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
