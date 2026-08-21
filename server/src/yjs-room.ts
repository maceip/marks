import { Database } from '@hocuspocus/extension-database';
import { Hocuspocus } from '@hocuspocus/server';
import type { IncomingMessage } from 'node:http';
import type { RawData, WebSocket } from 'ws';
import * as Y from 'yjs';
import { PERSIST_DEBOUNCE_MS, PERSIST_MAX_WAIT_MS } from './config.js';
import { createDocument, getState, isRecentlyDeleted, saveState } from './store.js';
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
        const stored = getState(documentName);
        if (!stored) {
          if (isRecentlyDeleted(documentName)) {
            throw new Error(`document ${documentName} was deleted`);
          }
          createDocument({ id: documentName, engine: 'yjs' });
          return null;
        }
        // The two CRDTs have incompatible binary formats; opening a Loro
        // document with this engine would hand it an empty replica and let it
        // overwrite the stored state.
        if (stored.engine !== 'yjs') {
          throw new Error(`document ${documentName} is a ${stored.engine} document`);
        }
        return stored.state ?? null;
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

/**
 * Markdown from the live document, if Hocuspocus still holds it.
 *
 * Its store runs on a debounce, so the row in SQLite can trail the editor by
 * seconds; anything reading a document for a user needs the resident copy.
 */
export function yjsLiveText(id: string): string | undefined {
  const document = hocuspocus.documents.get(id);
  return document?.getText(YJS_TEXT_KEY).toString();
}

/**
 * Drop a deleted document: close its connections and forget it, so nothing
 * writes it back out after the row is gone.
 */
export function discardYjsDocument(id: string): void {
  hocuspocus.closeConnections(id);
  hocuspocus.documents.delete(id);
}

export function yjsTextFromState(state: Uint8Array): string {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  const text = doc.getText(YJS_TEXT_KEY).toString();
  doc.destroy();
  return text;
}
