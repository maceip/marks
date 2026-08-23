import type { Extension } from '@codemirror/state';
import type { TextEdit } from '../text/change';
export type { TextEdit } from '../text/change';

/**
 * The CRDT engine documents are stored in. ESBT is the only engine; the
 * client refuses any other engine tag (see `documentIsOpenable`).
 */
export type EngineName = 'esbt';

export type DocumentRole = 'owner' | 'editor' | 'commenter' | 'viewer';

export interface DocumentCapabilities {
  /** Null while a service admission has not resolved yet. */
  role: DocumentRole | 'scratch' | 'local' | null;
  edit: boolean;
  comment: boolean;
  saveVersion: boolean;
  manageShares: boolean;
}

export type ConnectionStatus = 'connecting' | 'saving' | 'connected' | 'offline';

export interface Peer {
  id: string;
  name: string;
  /** Palette index 1-8, matching the `.marks-user{n}` CSS classes. */
  colorIndex: number;
  self: boolean;
  /** Stable person key. Several live site ids (tabs) may belong to one person. */
  participantId?: string;
  avatarUrl?: string;
  authenticated?: boolean;
  /** Most recent remote selection; presence UI treats a selection as editing. */
  selection?: { from: number; to: number };
  section?: string;
  joinedAt?: number;
  connectionIds?: string[];
}

export interface LocalUser {
  name: string;
  colorIndex: number;
  /** Browser identity shared by this person's tabs, never displayed. */
  id?: string;
}

export interface RoomTicket {
  roomUrl: string;
  ticketId: string;
  ticketSecret: string;
  /** Room-allocated u32 site, decimal string. Persist and reuse. */
  siteId: string;
  /** Validated server role; null only for scratch authority. */
  role: DocumentRole | null;
  authority: 'session' | 'scratch';
}

export interface DocumentAccessProvider {
  fetchSnapshot(documentId: string, signal: AbortSignal): Promise<Response>;
  admit(documentId: string, siteId: string | undefined, signal: AbortSignal): Promise<RoomTicket>;
}

export interface EngineErrorNotice {
  code: number;
  message: string;
}

export interface EngineStats {
  /** Size of the document's current snapshot, in bytes. */
  snapshotBytes: number;
  /** Bytes received from the network since the session opened. */
  received: number;
  /** Bytes sent to the network since the session opened. */
  sent: number;
  lastUpdateBytes: number;
  retainedOperations: number;
  pendingOperations: number;
  historyFloorBytes: number;
  currentDmax: number;
  /** True after the local IndexedDB journal accepted the latest edit. */
  localSaved: boolean;
}

export interface DocumentChange {
  edits: readonly TextEdit[];
  origin?: string;
  local: boolean;
}

/** An engine-owned range that survives edits while an asynchronous task runs. */
export interface StableTextRange {
  start: Uint8Array;
  end: Uint8Array;
  startOffset: number;
  endOffset: number;
}

/** A review range persisted outside the CRDT as two stable ESBT anchors. */
export interface ReviewAnchorRange extends StableTextRange {
  /** Selected UTF-16 source at creation time, used when both identities vanish. */
  quote: string;
  /** Last-known UTF-16 offsets provide a bounded tie-breaker for quote fallback. */
}

export interface ResolvedTextRange {
  from: number;
  to: number;
}

export interface ResolvedReviewRange extends ResolvedTextRange {
  /** True when the live text at the anchored range still equals the quote. */
  exact: boolean;
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
  length(): number;
  /** Replace the whole document — used by import, never by typing. */
  setText(markdown: string): void;
  /**
   * Replace a character range of the markdown source. Preview interactions
   * (ticking a checkbox, say) use this so they keep working when the editor
   * pane is not mounted.
   */
  replaceRange(from: number, to: number, insert: string): void;

  /** Capture explicit UTF-16 offsets for an async insert/upload operation. */
  captureTextRange(from: number, to: number): StableTextRange;
  /** Resolve a previously captured engine-owned range against current text. */
  resolveTextRange(range: StableTextRange): ResolvedTextRange;

  /** Capture the focused editor selection as stable engine-owned positions. */
  captureReviewRange(): ReviewAnchorRange;
  /** Resolve anchors, falling back to quoted source near its old offset. */
  resolveReviewRange(range: ReviewAnchorRange): ResolvedReviewRange;
  /** Focus and reveal a resolved review range when an editor surface exists. */
  revealReviewRange(range: ReviewAnchorRange): ResolvedReviewRange;

  /** Resolve only after every edit made before this call is durably committed. */
  whenDurable(timeoutMs?: number): Promise<void>;

  status(): ConnectionStatus;
  capabilities(): DocumentCapabilities;
  peers(): Peer[];
  stats(): EngineStats;

  /** Subscribe to exact replacements; hot edits never copy the full source. */
  onChange(listener: (change: DocumentChange) => void): () => void;
  onStatusChange(listener: (status: ConnectionStatus) => void): () => void;
  onPeersChange(listener: (peers: Peer[]) => void): () => void;
  onError?(listener: (error: EngineErrorNotice) => void): () => void;

  /** True once the local replica has been read, even if the document is empty. */
  hydrated(): boolean;
  onHydrated(listener: () => void): () => void;

  destroy(): void;
}

export interface SessionOptions {
  docId: string;
  user: LocalUser;
  access?: DocumentAccessProvider;
}
