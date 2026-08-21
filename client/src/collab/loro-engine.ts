import { Annotation, Prec, type Extension } from '@codemirror/state';
import { ViewPlugin, keymap, type EditorView } from '@codemirror/view';
import { get as idbGet, set as idbSet } from 'idb-keyval';
import { LoroEphemeralPlugin } from 'loro-codemirror';
import { Cursor, EphemeralStore, LoroDoc, UndoManager, VersionVector } from 'loro-crdt';
import {
  COMMENT_ORIGIN,
  COMMENTS_MAP,
  createCommentId,
  decodeBytes,
  encodeBytes,
  parseComment,
  persistLockName,
  readCommentMap,
  readNetworkQuality,
  resolveCommentRange,
  serializeComment,
  snapshotFetchTimeoutMs,
  TabChannel,
  tabChannelName,
  withPersistLock,
  fetchWithTimeout,
  type CommentRecord,
} from '../browser';
import { MSG_EPHEMERAL, MSG_SERVER_VV, MSG_SNAPSHOT, MSG_SYNCED, MSG_UPDATE, frame, toBase64Url } from './protocol';
import { TEXT_KEY, type CollabSession, type ConnectionStatus, type EngineStats, type Peer, type SessionOptions } from './types';

const EPHEMERAL_TIMEOUT_MS = 30_000;
const LOCAL_SAVE_DEBOUNCE_MS = 800;
const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 8_000;
/** The server's close code for a document that no longer exists. */
const CLOSE_DOCUMENT_DELETED = 4404;

/** Version vectors above this size are not worth putting in a URL. */
const MAX_VV_QUERY_BYTES = 4_096;

const userKey = (peerId: string) => `${peerId}-cm-user`;

/** The single container every layer agrees on. */
const getMarkdownText = (doc: LoroDoc) => doc.getText(TEXT_KEY);

/** Marks an editor transaction as replaying the CRDT, not as a user edit. */
const fromCrdt = Annotation.define<boolean>();

/**
 * Commit origin for changes the editor already shows.
 *
 * Everything else that mutates the document locally — a checkbox ticked in the
 * preview, an import, undo — has to be pushed into the editor, so the origin is
 * what tells the two directions apart.
 */
const EDITOR_ORIGIN = 'editor';

/**
 * Loro engine: Fugue over an Eg-walker style event graph.
 *
 * Operations are stored as plain indices and the CRDT structure is only
 * materialised while merging, which is what keeps steady-state memory and
 * document load times flat as edit history grows.
 */
export class LoroEngine implements CollabSession {
  readonly engine = 'loro' as const;
  readonly docId: string;
  readonly extension: Extension;

  private readonly doc = new LoroDoc();
  private readonly ephemeral = new EphemeralStore(EPHEMERAL_TIMEOUT_MS);
  private readonly undoManager: UndoManager;
  private readonly user: SessionOptions['user'];

  private socket: WebSocket | null = null;
  private reconnectDelay = RECONNECT_MIN_MS;
  private reconnectTimer: number | null = null;
  private destroyed = false;

  private currentStatus: ConnectionStatus = 'connecting';
  private cachedPeers: Peer[] = [];
  private counters = { received: 0, sent: 0, snapshotBytes: 0 };

  private saveTimer: number | null = null;
  private readonly unsubscribers: Array<() => void> = [];
  private readonly textListeners = new Set<(text: string) => void>();
  private readonly statusListeners = new Set<(status: ConnectionStatus) => void>();
  private readonly peerListeners = new Set<(peers: Peer[]) => void>();
  private readonly commentListeners = new Set<(comments: CommentRecord[]) => void>();
  private readonly hydratedListeners = new Set<() => void>();
  private cachedComments: CommentRecord[] = [];
  private isHydrated = false;
  private lastServerVV: Uint8Array | null = null;
  private snapshotReplyTimer: number | null = null;
  private readonly tabs: TabChannel;

  constructor({ docId, user }: SessionOptions) {
    this.docId = docId;
    this.user = user;
    this.undoManager = new UndoManager(this.doc, { excludeOriginPrefixes: [COMMENT_ORIGIN] });
    this.tabs = new TabChannel(tabChannelName('loro', docId), {
      onHello: () => this.scheduleTabSnapshot(),
      onRequestSnapshot: () => this.scheduleTabSnapshot(),
      onUpdate: (bytes) => this.importFromTab(bytes, 'update'),
      onSnapshot: (bytes) => this.importFromTab(bytes, 'snapshot'),
    });

    this.extension = [
      // The binding's cursor and selection layers, which are the parts of
      // loro-codemirror we want. Document sync and undo are ours: see
      // `syncExtension` and `undoExtensions` for why.
      LoroEphemeralPlugin(
        this.doc,
        this.ephemeral,
        { name: user.name, colorClassName: `marks-user${user.colorIndex}` },
        getMarkdownText,
      ),
      this.syncExtension(),
      this.undoExtensions(),
    ];

    this.unsubscribers.push(
      this.doc.subscribe(() => {
        this.emitText();
        this.emitComments();
        this.scheduleLocalSave();
      }),
      this.doc.subscribeLocalUpdates((bytes) => {
        this.send(MSG_UPDATE, bytes);
        this.tabs.sendUpdate(bytes);
      }),
      this.ephemeral.subscribe(() => this.refreshPeers()),
      this.ephemeral.subscribeLocalUpdates((bytes) => this.send(MSG_EPHEMERAL, bytes)),
    );

    window.addEventListener('online', this.handleOnline);
    window.addEventListener('offline', this.handleOffline);
    document.addEventListener('visibilitychange', this.handleVisibility);
    window.addEventListener('pagehide', this.handlePageHide);

    void this.start();
  }

  private redo(): boolean {
    if (this.undoManager.canRedo()) this.undoManager.redo();
    return true;
  }

  /**
   * Bring the editor in line with the CRDT using the smallest edit that does
   * it, so the cursor, scroll position and any selection survive.
   */
  private reconcile(view: EditorView): void {
    const target = this.doc.getText(TEXT_KEY).toString();
    const current = view.state.doc.toString();
    if (current === target) return;

    let from = 0;
    const shortest = Math.min(current.length, target.length);
    while (from < shortest && current[from] === target[from]) from += 1;

    let currentEnd = current.length;
    let targetEnd = target.length;
    while (
      currentEnd > from &&
      targetEnd > from &&
      current[currentEnd - 1] === target[targetEnd - 1]
    ) {
      currentEnd -= 1;
      targetEnd -= 1;
    }

    view.dispatch({
      changes: { from, to: currentEnd, insert: target.slice(from, targetEnd) },
      annotations: [fromCrdt.of(true)],
    });
  }

  /**
   * Two-way document sync between CodeMirror and Loro.
   *
   * loro-codemirror ships its own sync plugin, but it ignores locally
   * originated events — which is what an undo produces — and its annotation is
   * module-private, so an undo applied from outside the binding is echoed
   * straight back into the CRDT and corrupts it. Owning both directions here
   * costs about forty lines and makes undo, remote updates and local typing
   * follow the same, single path.
   */
  private syncExtension(): Extension {
    return ViewPlugin.define((view) => {
      let disposed = false;

      // A freshly mounted editor starts empty — switching view modes or
      // reopening a document builds a new EditorView — so pull the current
      // text in once. Deferred by a microtask because CodeMirror forbids
      // dispatching while the view is still being constructed.
      queueMicrotask(() => {
        if (!disposed) this.reconcile(view);
      });

      const unsubscribe = this.doc.subscribe((event) => {
        // Skip only the changes the editor itself just made; remote updates,
        // undo, redo and local writes from elsewhere in the UI all need to be
        // reflected back into it.
        if (event.origin === EDITOR_ORIGIN) return;
        this.reconcile(view);
      });

      return {
        update: (update) => {
          if (!update.docChanged) return;
          if (update.transactions.some((transaction) => transaction.annotation(fromCrdt))) return;

          const text = this.doc.getText(TEXT_KEY);
          let adjust = 0;
          update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
            const insert = inserted.sliceString(0, inserted.length, '\n');
            if (toA > fromA) text.delete(fromA + adjust, toA - fromA);
            if (insert.length > 0) text.insert(fromA + adjust, insert);
            adjust += insert.length - (toA - fromA);
          });
          this.doc.commit({ origin: EDITOR_ORIGIN });
        },
        destroy: () => {
          disposed = true;
          unsubscribe();
        },
      };
    });
  }

  /**
   * Undo/redo driven straight from Loro's UndoManager, which scopes each step
   * to this peer's own edits rather than the shared document's history.
   */
  private undoExtensions(): Extension {
    return Prec.high(
      keymap.of([
        {
          key: 'Mod-z',
          preventDefault: true,
          run: () => {
            if (this.undoManager.canUndo()) this.undoManager.undo();
            return true;
          },
        },
        // Both redo conventions, on every platform.
        { key: 'Mod-y', preventDefault: true, run: () => this.redo() },
        { key: 'Mod-Shift-z', preventDefault: true, run: () => this.redo() },
      ]),
    );
  }

  /* ---------------------------------------------------------------- reads */

  getText(): string {
    return this.doc.getText(TEXT_KEY).toString();
  }

  setText(markdown: string): void {
    const text = this.doc.getText(TEXT_KEY);
    const length = text.length;
    if (length > 0) text.delete(0, length);
    text.insert(0, markdown);
    this.doc.commit();
  }

  replaceRange(from: number, to: number, insert: string): void {
    const text = this.doc.getText(TEXT_KEY);
    const end = Math.min(to, text.length);
    if (end > from) text.delete(from, end - from);
    if (insert) text.insert(from, insert);
    this.doc.commit();
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
    const text = this.doc.getText(TEXT_KEY);
    let startCursor: string | undefined;
    let endCursor: string | undefined;
    try {
      const start = text.getCursor(input.from);
      const end = text.getCursor(input.to);
      if (start) startCursor = encodeBytes(start.encode());
      if (end) endCursor = encodeBytes(end.encode());
    } catch {
      // Cursors are an optimisation; quote+offset still work.
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
    this.doc.getMap(COMMENTS_MAP).set(id, serializeComment(record));
    this.doc.commit({ origin: COMMENT_ORIGIN });
    return id;
  }

  resolveComment(id: string): void {
    const existing = this.commentById(id);
    if (!existing || existing.resolved) return;
    this.doc.getMap(COMMENTS_MAP).set(id, serializeComment({ ...existing, resolved: true }));
    this.doc.commit({ origin: COMMENT_ORIGIN });
  }

  deleteComment(id: string): void {
    this.doc.getMap(COMMENTS_MAP).delete(id);
    this.doc.commit({ origin: COMMENT_ORIGIN });
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

  /* ------------------------------------------------------------- lifecycle */

  private async start(): Promise<void> {
    // Local cache first: it is the fastest path to visible content.
    await this.loadLocalSnapshot();
    this.markHydrated();
    this.tabs.hello();
    // Then the server's snapshot over plain HTTP, which is cacheable and
    // arrives without waiting for a WebSocket handshake. A local copy plus a
    // slow network means we do not block the editor on that request.
    await this.loadServerSnapshot();
    if (this.destroyed) return;

    // Cache what we just loaded, which also seeds the encoded-size readout.
    void this.saveLocalSnapshot();
    this.connect();
  }

  private async loadLocalSnapshot(): Promise<void> {
    try {
      const cached = await idbGet<Uint8Array>(this.cacheKey);
      if (cached && cached.byteLength > 0 && !this.destroyed) {
        this.doc.import(cached);
        this.emitText();
      }
    } catch {
      // A missing or unreadable cache is not an error, just a slower open.
    }
  }

  private async loadServerSnapshot(): Promise<void> {
    const quality = readNetworkQuality();
    const hasLocal = this.getText().length > 0 || this.counters.snapshotBytes > 0;
    const timeoutMs = snapshotFetchTimeoutMs(quality, hasLocal);
    if (timeoutMs <= 0) return;

    try {
      const response = await fetchWithTimeout(
        `/api/documents/${this.docId}/snapshot?shallow=1`,
        { headers: { Accept: 'application/octet-stream' } },
        timeoutMs,
      );
      if (!response.ok || response.status === 204 || this.destroyed) return;
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength === 0) return;
      this.counters.received += bytes.byteLength;
      this.doc.import(bytes);
      this.emitText();
      this.emitComments();
    } catch {
      // Offline, aborted, or slow: the local cache and the WebSocket retry
      // loop cover us. Do not surface a failed snapshot as a document error.
    }
  }

  private connect(): void {
    if (this.destroyed) return;

    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = new URL(`${protocol}://${location.host}/collab/loro/${this.docId}`);

    // Tell the server what we already have so it can reply with a delta
    // instead of a full snapshot.
    try {
      const vv = this.doc.oplogVersion().encode();
      if (vv.byteLength > 0 && vv.byteLength <= MAX_VV_QUERY_BYTES) {
        url.searchParams.set('vv', toBase64Url(vv));
      }
    } catch {
      // No version vector: the server falls back to a snapshot.
    }

    this.setStatus('connecting');
    const socket = new WebSocket(url);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;

    socket.addEventListener('message', (event) => this.onMessage(event.data as ArrayBuffer));
    socket.addEventListener('open', () => {
      this.reconnectDelay = RECONNECT_MIN_MS;
      // Push anything the server is missing (edits made while offline).
      this.send(MSG_EPHEMERAL, this.ephemeral.encodeAll());
    });
    socket.addEventListener('close', (event) => this.onDisconnect(socket, event.code));
    socket.addEventListener('error', () => this.onDisconnect(socket));
  }

  private onDisconnect(socket: WebSocket, code?: number): void {
    if (this.socket !== socket) return;
    this.socket = null;
    if (this.destroyed) return;

    this.setStatus('offline');

    // The document was deleted. Retrying would recreate it from this replica.
    if (code === CLOSE_DOCUMENT_DELETED) {
      this.destroyed = true;
      return;
    }

    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null || this.destroyed) return;
    const jitter = Math.random() * 0.3 + 0.85;
    const delay = Math.min(this.reconnectDelay * jitter, RECONNECT_MAX_MS);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private handleOnline = (): void => {
    this.reconnectDelay = RECONNECT_MIN_MS;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (!this.socket) this.connect();
  };

  private handleOffline = (): void => {
    this.setStatus('offline');
  };

  private handleVisibility = (): void => {
    if (document.visibilityState === 'hidden') {
      this.flushLocalSave();
      return;
    }
    this.tabs.requestSnapshot();
  };

  private handlePageHide = (): void => {
    this.flushLocalSave();
  };

  private importFromTab(bytes: Uint8Array, kind: 'update' | 'snapshot'): void {
    if (this.destroyed || bytes.byteLength === 0) return;
    try {
      this.doc.import(bytes);
    } catch (error) {
      console.error('[marks] rejected tab update', error);
      return;
    }
    // Another tab typed this. If we are the one still on the socket, the
    // server will not see it unless we forward. Import is idempotent.
    if (kind === 'update') this.send(MSG_UPDATE, bytes);
    else if (this.lastServerVV) this.sendMissingSince(this.lastServerVV);
  }

  private scheduleTabSnapshot(): void {
    if (this.snapshotReplyTimer !== null || this.destroyed) return;
    this.snapshotReplyTimer = window.setTimeout(() => {
      this.snapshotReplyTimer = null;
      if (this.destroyed) return;
      try {
        this.tabs.sendSnapshot(this.doc.export({ mode: 'snapshot' }));
      } catch {
        // An empty replica has nothing to share.
      }
    }, 32);
  }

  private flushLocalSave(): void {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    void this.saveLocalSnapshot();
  }

  /* -------------------------------------------------------------- messages */

  private onMessage(raw: ArrayBuffer): void {
    const data = new Uint8Array(raw);
    if (data.length === 0) return;
    this.counters.received += data.byteLength;

    const tag = data[0];
    const payload = data.subarray(1);

    switch (tag) {
      case MSG_UPDATE:
      case MSG_SNAPSHOT:
        try {
          this.doc.import(payload);
        } catch (error) {
          console.error('[marks] rejected remote update', error);
        }
        break;
      case MSG_EPHEMERAL:
        try {
          this.ephemeral.apply(payload);
        } catch {
          // presence is best-effort
        }
        break;
      case MSG_SERVER_VV:
        this.lastServerVV = payload;
        this.sendMissingSince(payload);
        break;
      case MSG_SYNCED:
        this.setStatus('connected');
        break;
      default:
        break;
    }
  }

  /** Answer the server's version vector with whatever it has not seen. */
  private sendMissingSince(encodedVersionVector: Uint8Array): void {
    try {
      const missing = this.doc.export({
        mode: 'update',
        from: VersionVector.decode(encodedVersionVector),
      });
      if (missing.byteLength > 0) this.send(MSG_UPDATE, missing);
      this.setStatus('connected');
    } catch (error) {
      console.error('[marks] could not diff against server version', error);
    }
  }

  private send(tag: number, payload: Uint8Array): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN || payload.byteLength === 0) return;
    const message = frame(tag, payload);
    socket.send(message);
    this.counters.sent += message.byteLength;
  }

  /* ------------------------------------------------------------ persistence */

  private get cacheKey(): string {
    return `marks:loro:${this.docId}`;
  }

  private scheduleLocalSave(): void {
    if (this.saveTimer !== null) clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.saveLocalSnapshot();
    }, LOCAL_SAVE_DEBOUNCE_MS);
  }

  private async saveLocalSnapshot(): Promise<void> {
    // Export first, synchronously, so a destroy() that flips `destroyed`
    // while we wait for the persist lock still writes the bytes we hold.
    let snapshot: Uint8Array;
    try {
      snapshot = this.doc.export({ mode: 'snapshot' });
      this.counters.snapshotBytes = snapshot.byteLength;
    } catch {
      return;
    }
    try {
      await withPersistLock(persistLockName('loro', this.docId), async () => {
        await idbSet(this.cacheKey, snapshot);
      });
    } catch {
      // Storage pressure or private mode: the server copy is authoritative.
    }
  }

  /* --------------------------------------------------------------- emitters */

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
    const states = this.ephemeral.getAllStates() as Record<string, unknown>;
    const selfKey = userKey(this.doc.peerIdStr);
    const peers: Peer[] = [];

    for (const [key, value] of Object.entries(states)) {
      if (!key.endsWith('-cm-user') || !value || typeof value !== 'object') continue;
      const user = value as { name?: unknown; colorClassName?: unknown };
      const name = typeof user.name === 'string' ? user.name : 'Anonymous';
      const match = /marks-user(\d)/.exec(String(user.colorClassName ?? ''));
      peers.push({
        id: key.replace(/-cm-user$/, ''),
        name,
        colorIndex: match ? Number(match[1]) : 1,
        self: key === selfKey,
      });
    }

    if (!peers.some((peer) => peer.self)) {
      peers.unshift({
        id: this.doc.peerIdStr,
        name: this.user.name,
        colorIndex: this.user.colorIndex,
        self: true,
      });
    }

    peers.sort((a, b) => Number(b.self) - Number(a.self) || a.name.localeCompare(b.name));
    this.cachedPeers = peers;
    for (const listener of this.peerListeners) listener(peers);
  }

  destroy(): void {
    // Flush before the destroyed flag goes up: `saveLocalSnapshot` bails on it,
    // so edits still sitting inside the save debounce — everything typed in the
    // last 800 ms, which offline is the only copy of — would be lost.
    this.flushLocalSave();

    this.destroyed = true;
    window.removeEventListener('online', this.handleOnline);
    window.removeEventListener('offline', this.handleOffline);
    document.removeEventListener('visibilitychange', this.handleVisibility);
    window.removeEventListener('pagehide', this.handlePageHide);
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    if (this.snapshotReplyTimer !== null) clearTimeout(this.snapshotReplyTimer);
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.tabs.destroy();
    this.socket?.close();
    this.socket = null;
    this.ephemeral.destroy();
    this.textListeners.clear();
    this.statusListeners.clear();
    this.peerListeners.clear();
    this.commentListeners.clear();
    this.hydratedListeners.clear();
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

  private commentById(id: string): CommentRecord | null {
    const json = this.doc.getMap(COMMENTS_MAP).toJSON() as Record<string, unknown>;
    return parseComment(json[id]);
  }

  private readComments(): CommentRecord[] {
    const map = this.doc.getMap(COMMENTS_MAP);
    const raw = readCommentMap(map.entries());
    const text = this.getText();
    return raw.map((comment) => {
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
      const start = this.doc.getCursorPos(Cursor.decode(startBytes));
      const end = this.doc.getCursorPos(Cursor.decode(endBytes));
      if (!start || !end) return null;
      return {
        from: Math.min(start.offset, end.offset),
        to: Math.max(start.offset, end.offset),
      };
    } catch {
      return null;
    }
  }
}
