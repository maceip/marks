import type { Extension } from '@codemirror/state';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { keymap } from '@codemirror/view';
import { IndexeddbPersistence } from 'y-indexeddb';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import * as Y from 'yjs';
import {
  COMMENTS_MAP,
  createCommentId,
  decodeBytes,
  encodeBytes,
  parseComment,
  readCommentMap,
  resolveCommentRange,
  serializeComment,
  TabChannel,
  tabChannelName,
  type CommentRecord,
} from '../browser';
import { colorVar } from './user';
import { TEXT_KEY, type CollabSession, type ConnectionStatus, type EngineStats, type Peer, type SessionOptions } from './types';

/** How often the encoded document size is recomputed for the metrics panel. */
const SNAPSHOT_MEASURE_INTERVAL_MS = 2_000;
const TAB_ORIGIN = 'marks-tab';

/**
 * Yjs engine: YATA, served by Hocuspocus.
 *
 * Kept alongside Loro because it is the CRDT with the deepest ecosystem — if
 * you need a binding or a backend that only exists for Yjs, switch a document
 * to this engine and everything above `CollabSession` is unchanged.
 */
export class YjsEngine implements CollabSession {
  readonly engine = 'yjs' as const;
  readonly docId: string;
  readonly extension: Extension;

  private readonly doc = new Y.Doc();
  private readonly text: Y.Text;
  private readonly provider: HocuspocusProvider;
  private readonly persistence: IndexeddbPersistence;
  private readonly undoManager: Y.UndoManager;

  private currentStatus: ConnectionStatus = 'connecting';
  private cachedPeers: Peer[] = [];
  private counters = { received: 0, sent: 0, snapshotBytes: 0 };
  private lastMeasured = 0;

  private readonly textListeners = new Set<(text: string) => void>();
  private readonly statusListeners = new Set<(status: ConnectionStatus) => void>();
  private readonly peerListeners = new Set<(peers: Peer[]) => void>();
  private readonly commentListeners = new Set<(comments: CommentRecord[]) => void>();
  private readonly hydratedListeners = new Set<() => void>();
  private readonly commentMap: Y.Map<string>;
  private cachedComments: CommentRecord[] = [];
  private isHydrated = false;
  private snapshotReplyTimer: number | null = null;
  private readonly tabs: TabChannel;
  private readonly user: SessionOptions['user'];

  constructor({ docId, user }: SessionOptions) {
    this.docId = docId;
    this.user = user;
    this.text = this.doc.getText(TEXT_KEY);
    this.commentMap = this.doc.getMap(COMMENTS_MAP);
    this.tabs = new TabChannel(tabChannelName('yjs', docId), {
      onHello: () => this.scheduleTabSnapshot(),
      onRequestSnapshot: () => this.scheduleTabSnapshot(),
      onUpdate: (bytes) => this.importFromTab(bytes),
      onSnapshot: (bytes) => this.importFromTab(bytes),
    });

    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    this.provider = new HocuspocusProvider({
      url: `${protocol}://${location.host}/collab/yjs`,
      name: docId,
      document: this.doc,
      onStatus: ({ status }) => {
        this.setStatus(status === 'connected' ? 'connected' : 'connecting');
      },
      onDisconnect: () => this.setStatus('offline'),
    });

    this.persistence = new IndexeddbPersistence(`marks:yjs:${docId}`, this.doc);
    this.persistence.on('synced', () => {
      this.emitText();
      this.emitComments();
      this.markHydrated();
    });

    this.provider.awareness?.setLocalStateField('user', {
      name: user.name,
      colorIndex: user.colorIndex,
      color: colorVar(user.colorIndex),
      colorLight: colorVar(user.colorIndex),
    });

    // y-codemirror.next registers its own transaction origin on this manager,
    // which is what scopes undo to this user's edits.
    this.undoManager = new Y.UndoManager(this.text);

    this.extension = [
      yCollab(this.text, this.provider.awareness, { undoManager: this.undoManager }),
      keymap.of(yUndoManagerKeymap),
    ];

    this.text.observe(() => this.emitText());
    this.commentMap.observe(() => this.emitComments());

    // Classify by transaction origin, which is the only way to tell the three
    // sources apart: the provider applies remote updates with itself as the
    // origin, y-indexeddb replays the local cache with itself as the origin,
    // a sibling tab applies with TAB_ORIGIN, and a local edit arrives with
    // none of those.
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === this.provider) this.counters.received += update.byteLength;
      else if (origin === this.persistence) {
        // replay
      } else if (origin === TAB_ORIGIN) {
        this.counters.sent += update.byteLength;
      } else {
        this.counters.sent += update.byteLength;
        this.tabs.sendUpdate(update);
      }
      this.measureSnapshot();
    });
    this.provider.awareness?.on('change', () => this.refreshPeers());
    this.refreshPeers();

    window.addEventListener('online', this.handleOnline);
    window.addEventListener('offline', this.handleOffline);
    document.addEventListener('visibilitychange', this.handleVisibility);
    window.addEventListener('pagehide', this.handlePageHide);

    // IndexedDB may be empty on a first open; do not leave the skeleton up.
    window.setTimeout(() => this.markHydrated(), 50);
    this.tabs.hello();
  }

  getText(): string {
    return this.text.toString();
  }

  setText(markdown: string): void {
    this.doc.transact(() => {
      this.text.delete(0, this.text.length);
      this.text.insert(0, markdown);
    });
  }

  replaceRange(from: number, to: number, insert: string): void {
    this.doc.transact(() => {
      const end = Math.min(to, this.text.length);
      if (end > from) this.text.delete(from, end - from);
      if (insert) this.text.insert(from, insert);
    });
  }

  status(): ConnectionStatus {
    return this.currentStatus;
  }

  peers(): Peer[] {
    return this.cachedPeers;
  }

  stats(): EngineStats {
    return { ...this.counters };
  }

  /**
   * Encoding the whole document is O(document), so it is sampled rather than
   * run on every keystroke.
   */
  private measureSnapshot(): void {
    const now = performance.now();
    if (now - this.lastMeasured < SNAPSHOT_MEASURE_INTERVAL_MS) return;
    this.lastMeasured = now;
    this.counters.snapshotBytes = Y.encodeStateAsUpdate(this.doc).byteLength;
  }

  onTextChange(listener: (text: string) => void): () => void {
    this.textListeners.add(listener);
    return () => this.textListeners.delete(listener);
  }

  onStatusChange(listener: (status: ConnectionStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  onPeersChange(listener: (peers: Peer[]) => void): () => void {
    this.peerListeners.add(listener);
    return () => this.peerListeners.delete(listener);
  }

  comments(): CommentRecord[] {
    return this.cachedComments;
  }

  addComment(input: { from: number; to: number; quote: string; body: string }): string {
    const id = createCommentId();
    let startCursor: string | undefined;
    let endCursor: string | undefined;
    try {
      startCursor = encodeBytes(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(this.text, input.from)));
      endCursor = encodeBytes(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(this.text, input.to)));
    } catch {
      // quote+offset still work
    }
    const record: CommentRecord = {
      id,
      body: input.body,
      author: this.user.name,
      colorIndex: this.user.colorIndex,
      createdAt: Date.now(),
      resolved: false,
      from: input.from,
      to: input.to,
      quote: input.quote,
      startCursor,
      endCursor,
    };
    this.commentMap.set(id, serializeComment(record));
    return id;
  }

  resolveComment(id: string): void {
    const existing = parseComment(this.commentMap.get(id));
    if (!existing || existing.resolved) return;
    this.commentMap.set(id, serializeComment({ ...existing, resolved: true }));
  }

  deleteComment(id: string): void {
    this.commentMap.delete(id);
  }

  onCommentsChange(listener: (comments: CommentRecord[]) => void): () => void {
    this.commentListeners.add(listener);
    return () => this.commentListeners.delete(listener);
  }

  hydrated(): boolean {
    return this.isHydrated;
  }

  onHydrated(listener: () => void): () => void {
    this.hydratedListeners.add(listener);
    if (this.isHydrated) queueMicrotask(listener);
    return () => this.hydratedListeners.delete(listener);
  }

  private emitText(): void {
    if (this.textListeners.size === 0) return;
    const text = this.getText();
    for (const listener of this.textListeners) listener(text);
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.currentStatus === status) return;
    this.currentStatus = status;
    for (const listener of this.statusListeners) listener(status);
  }

  private refreshPeers(): void {
    const awareness = this.provider.awareness;
    if (!awareness) return;

    const peers: Peer[] = [];
    for (const [clientId, state] of awareness.getStates()) {
      const user = (state as { user?: { name?: string; colorIndex?: number } }).user;
      if (!user) continue;
      peers.push({
        id: String(clientId),
        name: user.name ?? 'Anonymous',
        colorIndex: user.colorIndex ?? 1,
        self: clientId === awareness.clientID,
      });
    }

    peers.sort((a, b) => Number(b.self) - Number(a.self) || a.name.localeCompare(b.name));
    this.cachedPeers = peers;
    for (const listener of this.peerListeners) listener(peers);
  }

  destroy(): void {
    window.removeEventListener('online', this.handleOnline);
    window.removeEventListener('offline', this.handleOffline);
    document.removeEventListener('visibilitychange', this.handleVisibility);
    window.removeEventListener('pagehide', this.handlePageHide);
    if (this.snapshotReplyTimer !== null) window.clearTimeout(this.snapshotReplyTimer);
    this.tabs.destroy();
    this.undoManager.destroy();
    this.provider.destroy();
    void this.persistence.destroy();
    this.doc.destroy();
    this.textListeners.clear();
    this.statusListeners.clear();
    this.peerListeners.clear();
    this.commentListeners.clear();
    this.hydratedListeners.clear();
  }

  private handleOnline = (): void => {
    if (this.currentStatus === 'offline') this.setStatus('connecting');
  };

  private handleOffline = (): void => {
    this.setStatus('offline');
  };

  private handleVisibility = (): void => {
    if (document.visibilityState === 'visible') this.tabs.requestSnapshot();
  };

  private handlePageHide = (): void => {
    // y-indexeddb flushes on its own; request a last persist by encoding.
    this.measureSnapshot();
  };

  private importFromTab(bytes: Uint8Array): void {
    if (bytes.byteLength === 0) return;
    try {
      Y.applyUpdate(this.doc, bytes, TAB_ORIGIN);
    } catch (error) {
      console.error('[marks] rejected tab update', error);
    }
  }

  private scheduleTabSnapshot(): void {
    if (this.snapshotReplyTimer !== null) return;
    this.snapshotReplyTimer = window.setTimeout(() => {
      this.snapshotReplyTimer = null;
      try {
        this.tabs.sendSnapshot(Y.encodeStateAsUpdate(this.doc));
      } catch {
        // empty
      }
    }, 32);
  }

  private markHydrated(): void {
    if (this.isHydrated) return;
    this.isHydrated = true;
    this.emitComments();
    for (const listener of this.hydratedListeners) listener();
  }

  private emitComments(): void {
    this.cachedComments = this.readComments();
    for (const listener of this.commentListeners) listener(this.cachedComments);
  }

  private readComments(): CommentRecord[] {
    const entries: Array<[string, unknown]> = [];
    this.commentMap.forEach((value, key) => {
      entries.push([key, value]);
    });
    const text = this.getText();
    return readCommentMap(entries).map((comment) => {
      const fromCursors = this.rangeFromCursors(comment);
      const resolved = fromCursors ?? resolveCommentRange(comment, text);
      return resolved ? { ...comment, from: resolved.from, to: resolved.to } : comment;
    });
  }

  private rangeFromCursors(comment: CommentRecord): { from: number; to: number } | null {
    if (!comment.startCursor || !comment.endCursor) return null;
    try {
      const startBytes = decodeBytes(comment.startCursor);
      const endBytes = decodeBytes(comment.endCursor);
      if (!startBytes || !endBytes) return null;
      const start = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(startBytes), this.doc);
      const end = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(endBytes), this.doc);
      if (!start || !end) return null;
      return { from: Math.min(start.index, end.index), to: Math.max(start.index, end.index) };
    } catch {
      return null;
    }
  }
}
