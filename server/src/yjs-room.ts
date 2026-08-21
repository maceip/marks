import { Database } from '@hocuspocus/extension-database';
import { Hocuspocus } from '@hocuspocus/server';
import type { IncomingMessage } from 'node:http';
import type { RawData, WebSocket } from 'ws';
import * as Y from 'yjs';
import { PERSIST_DEBOUNCE_MS, PERSIST_MAX_WAIT_MS } from './config.js';
import { createDocument, documentExists, getState, saveState } from './store.js';
import { deriveTitle } from './title.js';

/** Shared type holding the markdown source. Must match the client. */
export const YJS_TEXT_KEY = 'markdown';

/**
 * Yjs rooms are served by Hocuspocus, which already implements the y-protocols
 * sync/awareness handshake, debounced persistence and connection lifecycle. We
 * only supply storage and title derivation.
 */
export const hocuspocus = new Hocuspocus({
  name: 'marks',
  quiet: true,
  debounce: PERSIST_DEBOUNCE_MS,
  maxDebounce: PERSIST_MAX_WAIT_MS,
  extensions: [
    new Database({
      fetch: async ({ documentName }) => {
        if (!documentExists(documentName)) createDocument({ id: documentName, engine: 'yjs' });
        return getState(documentName)?.state ?? null;
      },
      store: async ({ documentName, state, document }) => {
        const markdown = document.getText(YJS_TEXT_KEY).toString();
        saveState(documentName, state, deriveTitle(markdown), markdown.length);
      },
    }),
  ],
});

/**
 * Bridge a raw `ws` socket into Hocuspocus.
 *
 * Since v4 Hocuspocus does not attach its own socket listeners — the
 * integration owns the transport and pushes frames in. Documents are
 * multiplexed over this one socket, with the document name carried in the
 * sync protocol rather than the URL.
 */
export function handleYjsConnection(socket: WebSocket, request: IncomingMessage): void {
  const client = hocuspocus.handleConnection(socket as never, request as never);

  socket.on('message', (data: RawData) => {
    client.handleMessage(toUint8Array(data));
  });

  socket.on('close', (code: number, reason: Buffer) => {
    client.handleClose({ code, reason: reason.toString() } as never);
  });

  socket.on('error', () => {
    client.handleClose({ code: 1011, reason: 'socket error' } as never);
  });
}

function toUint8Array(data: RawData): Uint8Array {
  if (Buffer.isBuffer(data)) return new Uint8Array(data);
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  return new Uint8Array(data as ArrayBuffer);
}

/** Current document state, for the REST fast-open endpoint. */
export function yjsSnapshot(id: string): Uint8Array | null {
  const stored = getState(id);
  if (!stored?.state) return null;
  return stored.state;
}

export function yjsTextFromState(state: Uint8Array): string {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  const text = doc.getText(YJS_TEXT_KEY).toString();
  doc.destroy();
  return text;
}
