import type { Extension } from '@codemirror/state';

/**
 * The CRDT engine documents are stored in. ESBT is the only engine; the
 * client refuses any other engine tag (see `documentIsOpenable`).
 */
export type EngineName = 'esbt';

export type ConnectionStatus = 'connecting' | 'connected' | 'offline';

export interface Peer {
  id: string;
  name: string;
  /** Palette index 1-8, matching the `.marks-user{n}` CSS classes. */
  colorIndex: number;
  self: boolean;
}

export interface LocalUser {
  name: string;
  colorIndex: number;
}

export interface RoomTicket {
  roomUrl: string;
  ticketId: string;
  ticketSecret: string;
}

export interface DocumentAccessProvider {
  fetchSnapshot(documentId: string, signal: AbortSignal): Promise<Response>;
  admit(documentId: string, siteId: string, signal: AbortSignal): Promise<RoomTicket>;
}

export interface EngineStats {
  /** Size of the document's current snapshot, in bytes. */
  snapshotBytes: number;
  /** Bytes received from the network since the session opened. */
  received: number;
  /** Bytes sent to the network since the session opened. */
  sent: number;
}

/**
 * A live editing session for one document.
 *
 * The ESBT engine exposes this surface so the UI never branches on storage
 * details. Everything above this interface is engine-agnostic.
 */
export interface CollabSession {
  readonly engine: EngineName;
  readonly docId: string;

  /** CodeMirror extensions wiring the editor to the CRDT (sync, cursors, undo). */
  readonly extension: Extension;

  getText(): string;
  /** Replace the whole document — used by import, never by typing. */
  setText(markdown: string): void;
  /**
   * Replace a character range of the markdown source. Preview interactions
   * (ticking a checkbox, say) use this so they keep working when the editor
   * pane is not mounted.
   */
  replaceRange(from: number, to: number, insert: string): void;

  status(): ConnectionStatus;
  peers(): Peer[];
  stats(): EngineStats;

  onTextChange(listener: (text: string) => void): () => void;
  onStatusChange(listener: (status: ConnectionStatus) => void): () => void;
  onPeersChange(listener: (peers: Peer[]) => void): () => void;

  /** True once the local replica has been read, even if the document is empty. */
  hydrated(): boolean;
  onHydrated(listener: () => void): () => void;

  destroy(): void;
}

export interface SessionOptions {
  docId: string;
  user: LocalUser;
  access: DocumentAccessProvider;
}
