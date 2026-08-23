import { Annotation, Prec, type Extension } from '@codemirror/state';
import { ViewPlugin, keymap, type EditorView } from '@codemirror/view';
import { EphemeralStore } from '@marks/esbt';
import {
  readNetworkQuality,
  snapshotFetchTimeoutMs,
  TabChannel,
  tabChannelName,
} from '../browser';
import { roomTicketProtocols } from '../auth/room-access';
import {
  ABOUT_DOCUMENT,
  aboutMarkdownNeedsRefresh,
  isAboutDocument,
} from '../content/about';
import { readLocalDocumentText, seedAboutDocumentText, writeLocalDocumentText } from '../demo/workspace';
import {
  appendJournalUpdate,
  JOURNAL_RETAINED_THRESHOLD,
  readReplicaJournal,
  shouldPruneHistory,
  writeReplicaJournal,
  type ReplicaJournalRecord,
} from './journal';
import { HEARTBEAT_MS, esbtPresence } from './presence';
import {
  MSG_EPHEMERAL,
  MSG_SERVER_VV,
  MSG_SNAPSHOT,
  MSG_SYNCED,
  MSG_UPDATE,
  frame,
  toBase64Url,
} from './protocol';
import type {
  CollabSession,
  ConnectionStatus,
  EngineErrorNotice,
  EngineStats,
  Peer,
  RoomTicket,
  SessionOptions,
} from './types';
import {
  ESBT_ERROR,
  EsbtDocument,
  EsbtError,
  EsbtRuntime,
  MARKS_DOCUMENT_CONFIG,
  engineSiteToMarks,
  exportReconnectPayload,
  isEsbtError,
  isRefusedEdit,
  isSnapshotRefusal,
  marksSiteToEngine,
  userMessageForError,
} from './wasm';

const EPHEMERAL_TIMEOUT_MS = 30_000;
const LOCAL_SAVE_DEBOUNCE_MS = 800;
const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 8_000;
const CLOSE_DOCUMENT_DELETED = 4404;
const MAX_VV_QUERY_BYTES = 4_096;
const UNDO_MERGE_MS = 500;
const MARKDOWN_CHECKPOINT_MS = 220;

const userKey = (siteId: string) => `${siteId}-cm-user`;
const fromCrdt = Annotation.define<boolean>();
const EDITOR_ORIGIN = 'editor';

let sharedRuntime: Promise<EsbtRuntime> | null = null;

function loadRuntime(): Promise<EsbtRuntime> {
  sharedRuntime ??= EsbtRuntime.load();
  return sharedRuntime;
}

/**
 * Production Marks client for the Rust/Wasm ESBT document.
 *
 * Owns configuration, the IndexedDB journal, history compaction, reconnect
 * fallbacks, and transaction batching. The engine never schedules those
 * loops itself.
 */
export class EsbtEngine implements CollabSession {
  readonly engine = 'esbt' as const;
  readonly docId: string;
  readonly extension: Extension;

  private doc: EsbtDocument | null = null;
  private readonly ephemeral = new EphemeralStore(EPHEMERAL_TIMEOUT_MS);
  private readonly user: SessionOptions['user'];
  private readonly access: SessionOptions['access'];
  private readonly tabs: TabChannel;

  private socket: WebSocket | null = null;
  private admissionAbort: AbortController | null = null;
  private reconnectDelay = RECONNECT_MIN_MS;
  private reconnectTimer: number | null = null;
  private presenceHeartbeat: number | null = null;
  private snapshotReplyTimer: number | null = null;
  private lastServerVV: Uint8Array | null = null;
  private lastAckedVersion: Uint8Array | null = null;
  private lastPruneAt = 0;
  private pendingTicket: RoomTicket | null = null;
  private destroyed = false;
  private isHydrated = false;
  private localSaved = false;
  private undoGroup = 1n;
  private lastUndoAt = 0;
  private marksSiteId = '';

  private currentStatus: ConnectionStatus = 'connecting';
  private cachedPeers: Peer[] = [];
  private counters = {
    received: 0,
    sent: 0,
    snapshotBytes: 0,
    lastUpdateBytes: 0,
    retainedOperations: 0,
    pendingOperations: 0,
    historyFloorBytes: 0,
    currentDmax: 0,
  };

  private saveTimer: number | null = null;
  private markdownTimer: number | null = null;
  private readonly unsubscribers: Array<() => void> = [];
  private readonly textListeners = new Set<(text: string) => void>();
  private readonly statusListeners = new Set<(status: ConnectionStatus) => void>();
  private readonly peerListeners = new Set<(peers: Peer[]) => void>();
  private readonly hydratedListeners = new Set<() => void>();
  private readonly errorListeners = new Set<(error: EngineErrorNotice) => void>();

  static async open(options: SessionOptions): Promise<EsbtEngine> {
    const engine = new EsbtEngine(options);
    await engine.start();
    return engine;
  }

  constructor({ docId, user, access }: SessionOptions) {
    this.docId = docId;
    this.user = user;
    this.access = access;
    this.tabs = new TabChannel(tabChannelName('esbt', docId), {
      onHello: () => this.scheduleTabSnapshot(),
      onRequestSnapshot: () => this.scheduleTabSnapshot(),
      onUpdate: (bytes) => this.importFromTab(bytes, 'update'),
      onSnapshot: (bytes) => this.importFromTab(bytes, 'snapshot'),
    });

    this.extension = [
      esbtPresence(() => this.presenceSiteId(), () => this.doc?.length ?? 0, this.ephemeral),
      this.syncExtension(),
      this.undoExtensions(),
    ];

    window.addEventListener('online', this.handleOnline);
    window.addEventListener('offline', this.handleOffline);
    document.addEventListener('visibilitychange', this.handleVisibility);
    window.addEventListener('pagehide', this.handlePageHide);
    window.addEventListener('beforeunload', this.handlePageHide);
  }

  private presenceSiteId(): string {
    return this.marksSiteId || this.doc?.siteId || 'local';
  }

  private requireDoc(): EsbtDocument {
    if (!this.doc) throw new Error('esbt: document is not ready');
    return this.doc;
  }

  private nextUndoGroup(): bigint {
    const now = Date.now();
    if (now - this.lastUndoAt > UNDO_MERGE_MS) this.undoGroup += 1n;
    this.lastUndoAt = now;
    return this.undoGroup;
  }

  private bindDocument(doc: EsbtDocument): void {
    this.doc = doc;
    this.marksSiteId = engineSiteToMarks(doc.siteId);
    this.unsubscribers.push(
      doc.onChange(() => {
        this.refreshTelemetry();
        this.emitText();
        this.scheduleLocalSave();
        this.scheduleMarkdownCheckpoint();
      }),
      doc.onLocalUpdate((bytes) => {
        this.counters.lastUpdateBytes = bytes.byteLength;
        this.localSaved = false;
        this.send(MSG_UPDATE, bytes);
        this.tabs.sendUpdate(bytes);
        void this.appendLocalUpdate(bytes);
      }),
    );
    this.publishUser();
    if (this.presenceHeartbeat === null) {
      this.presenceHeartbeat = window.setInterval(() => this.publishUser(), HEARTBEAT_MS);
    }
    this.unsubscribers.push(
      this.ephemeral.subscribe(() => this.refreshPeers()),
      this.ephemeral.subscribeLocalUpdates((bytes) => this.send(MSG_EPHEMERAL, bytes)),
    );
    this.refreshPeers();
    this.refreshTelemetry();
  }

  private publishUser(): void {
    this.ephemeral.set(userKey(this.presenceSiteId()), {
      name: this.user.name,
      colorClassName: `marks-user${this.user.colorIndex}`,
    });
  }

  private redo(): boolean {
    if (!this.doc?.canRedo) return true;
    this.doc.redo({ origin: 'redo' });
    return true;
  }

  private reconcile(view: EditorView): void {
    if (!this.doc) return;
    const target = this.doc.getText();
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

  private syncExtension(): Extension {
    return ViewPlugin.define((view) => {
      let disposed = false;

      queueMicrotask(() => {
        if (!disposed) this.reconcile(view);
      });

      const unsubscribe = () => {
        /* replaced after bind */
      };
      let off = unsubscribe;
      const attach = (): void => {
        if (!this.doc || disposed) return;
        off();
        off = this.doc.onChange((event) => {
          if (event.origin === EDITOR_ORIGIN) return;
          this.reconcile(view);
        });
        this.reconcile(view);
      };
      attach();
      const ready = window.setInterval(() => {
        if (this.doc) {
          window.clearInterval(ready);
          attach();
        }
      }, 16);

      return {
        update: (update) => {
          if (!update.docChanged || !this.doc) return;
          if (update.transactions.some((transaction) => transaction.annotation(fromCrdt))) return;

          try {
            this.doc.transact(
              () => {
                let adjust = 0;
                update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
                  const insert = inserted.sliceString(0, inserted.length, '\n');
                  if (toA > fromA) this.doc?.delete(fromA + adjust, toA - fromA);
                  if (insert.length > 0) this.doc?.insert(fromA + adjust, insert);
                  adjust += insert.length - (toA - fromA);
                });
              },
              { origin: EDITOR_ORIGIN, undoGroup: this.nextUndoGroup() },
            );
          } catch (error) {
            if (isEsbtError(error) && error.code === ESBT_ERROR.MessageTooLarge) {
              this.applyChangesInHalves(update, view);
              return;
            }
            if (isRefusedEdit(error) && isEsbtError(error)) {
              this.reconcile(view);
              this.emitEngineError(error);
              return;
            }
            throw error;
          }
        },
        destroy: () => {
          disposed = true;
          window.clearInterval(ready);
          off();
        },
      };
    });
  }

  private applyChangesInHalves(
    update: {
      changes: {
        iterChanges(
          fn: (
            fromA: number,
            toA: number,
            fromB: number,
            toB: number,
            inserted: { sliceString(from: number, to: number, lineSep: string): string },
          ) => void,
        ): void;
      };
    },
    view: EditorView,
  ): void {
    try {
      update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
        const insert = inserted.sliceString(0, 1e9, '\n');
        this.replaceRangeChunked(fromA, toA, insert);
      });
    } catch (error) {
      if (isEsbtError(error)) {
        this.reconcile(view);
        this.emitEngineError(error);
        return;
      }
      throw error;
    }
  }

  private replaceRangeChunked(from: number, to: number, insert: string): void {
    const doc = this.requireDoc();
    const options = { origin: EDITOR_ORIGIN, undoGroup: this.nextUndoGroup() };
    try {
      doc.transact(() => {
        if (to > from) doc.delete(from, to - from);
        if (insert.length > 0) doc.insert(from, insert);
      }, options);
    } catch (error) {
      if (!isEsbtError(error) || error.code !== ESBT_ERROR.MessageTooLarge || insert.length <= 1) {
        throw error;
      }
      const mid = Math.floor(insert.length / 2);
      this.replaceRangeChunked(from, to, insert.slice(0, mid));
      this.replaceRangeChunked(from + mid, from + mid, insert.slice(mid));
    }
  }

  private undoExtensions(): Extension {
    return Prec.high(
      keymap.of([
        {
          key: 'Mod-z',
          preventDefault: true,
          run: () => {
            if (this.doc?.canUndo) this.doc.undo({ origin: 'undo' });
            return true;
          },
        },
        { key: 'Mod-y', preventDefault: true, run: () => this.redo() },
        { key: 'Mod-Shift-z', preventDefault: true, run: () => this.redo() },
      ]),
    );
  }

  getText(): string {
    return this.doc?.getText() ?? '';
  }

  setText(markdown: string): void {
    if (!this.doc) return;
    try {
      this.doc.setText(markdown, { origin: 'import' });
    } catch (error) {
      if (isEsbtError(error)) this.emitEngineError(error);
      else throw error;
    }
  }

  replaceRange(from: number, to: number, insert: string): void {
    if (!this.doc) return;
    try {
      this.replaceRangeChunked(from, to, insert);
    } catch (error) {
      if (isEsbtError(error)) this.emitEngineError(error);
      else throw error;
    }
  }

  status(): ConnectionStatus {
    return this.currentStatus;
  }

  peers(): Peer[] {
    return this.cachedPeers;
  }

  stats(): EngineStats {
    return {
      snapshotBytes: this.counters.snapshotBytes,
      received: this.counters.received,
      sent: this.counters.sent,
      lastUpdateBytes: this.counters.lastUpdateBytes,
      retainedOperations: this.counters.retainedOperations,
      pendingOperations: this.counters.pendingOperations,
      historyFloorBytes: this.counters.historyFloorBytes,
      currentDmax: this.counters.currentDmax,
      localSaved: this.localSaved,
    };
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

  onError(listener: (error: EngineErrorNotice) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  hydrated(): boolean {
    return this.isHydrated;
  }

  onHydrated(listener: () => void): () => void {
    this.hydratedListeners.add(listener);
    if (this.isHydrated) queueMicrotask(listener);
    return () => this.hydratedListeners.delete(listener);
  }

  private async start(): Promise<void> {
    const runtime = await loadRuntime();
    if (this.destroyed) return;

    const stored = await readReplicaJournal(this.docId);
    if (stored && stored.snapshot.byteLength > 0) {
      const doc = await EsbtDocument.create({
        runtime,
        siteId: marksSiteToEngine(stored.siteId),
        config: MARKS_DOCUMENT_CONFIG,
      });
      this.bindDocument(doc);
      doc.applySnapshot(stored.snapshot);
      for (const update of stored.updates) {
        try {
          doc.import(update);
        } catch (error) {
          console.error('[marks] rejected journaled update', error);
        }
      }
      this.lastAckedVersion = stored.ackedVersion;
      this.lastPruneAt = stored.lastPruneAt;
      this.localSaved = true;
      this.emitText();
    } else if (this.access) {
      const ticket = await this.access.admit(this.docId, stored?.siteId, new AbortController().signal);
      if (this.destroyed) return;
      this.pendingTicket = ticket;
      this.marksSiteId = ticket.siteId;
      const doc = await EsbtDocument.create({
        runtime,
        siteId: marksSiteToEngine(ticket.siteId),
        config: MARKS_DOCUMENT_CONFIG,
      });
      this.bindDocument(doc);
    } else {
      const localSite = stored?.siteId ?? randomLocalSite();
      const doc = await EsbtDocument.create({
        runtime,
        siteId: marksSiteToEngine(localSite),
        config: MARKS_DOCUMENT_CONFIG,
      });
      this.bindDocument(doc);
      const markdown = readLocalDocumentText(this.docId);
      if (markdown.length > 0) doc.setText(markdown, { origin: 'import' });
    }

    if (this.destroyed) {
      this.doc?.destroy();
      return;
    }

    if (isAboutDocument(this.docId) && this.doc) {
      seedAboutDocumentText();
      if (aboutMarkdownNeedsRefresh(this.getText())) {
        this.doc.setText(ABOUT_DOCUMENT, { origin: 'import' });
      }
    }

    this.markHydrated();
    this.tabs.hello();
    await this.loadServerSnapshot();
    if (this.destroyed) return;
    void this.checkpointJournal();
    this.connect();
  }

  private async loadServerSnapshot(): Promise<void> {
    if (!this.access || !this.doc) return;
    const quality = readNetworkQuality();
    const hasLocal = this.getText().length > 0 || this.counters.snapshotBytes > 0;
    const timeoutMs = snapshotFetchTimeoutMs(quality, hasLocal);
    if (timeoutMs <= 0) return;

    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.access.fetchSnapshot(this.docId, controller.signal);
      if (!response.ok || response.status === 204 || this.destroyed) return;
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength === 0) return;
      this.counters.received += bytes.byteLength;
      this.importRemote(bytes);
      this.emitText();
    } catch {
      // Offline, aborted, or slow: the local journal and the WebSocket retry
      // loop cover us.
    } finally {
      window.clearTimeout(timer);
    }
  }

  private connect(): void {
    if (!this.access || this.destroyed || this.socket || this.admissionAbort) return;
    if (this.pendingTicket) {
      this.openSocket(this.pendingTicket);
      this.pendingTicket = null;
      return;
    }

    const controller = new AbortController();
    this.admissionAbort = controller;
    this.setStatus('connecting');
    void this.admitAndConnect(controller);
  }

  private async admitAndConnect(controller: AbortController): Promise<void> {
    if (!this.access) return;
    try {
      const ticket = await this.access.admit(
        this.docId,
        this.marksSiteId || undefined,
        controller.signal,
      );
      if (this.destroyed || controller.signal.aborted || this.admissionAbort !== controller) return;
      this.admissionAbort = null;
      this.marksSiteId = ticket.siteId;
      this.openSocket(ticket);
    } catch (error) {
      if (this.admissionAbort === controller) this.admissionAbort = null;
      if (this.destroyed || controller.signal.aborted) return;
      this.setStatus('offline');
      if (shouldRetryAdmission(error)) this.scheduleReconnect();
    }
  }

  private openSocket(ticket: RoomTicket): void {
    const url = new URL(ticket.roomUrl);
    try {
      const vv = this.doc?.version() ?? new Uint8Array();
      if (vv.byteLength > 0 && vv.byteLength <= MAX_VV_QUERY_BYTES) {
        url.searchParams.set('vv', toBase64Url(vv));
      }
    } catch {
      // No version vector: the server falls back to a snapshot.
    }

    const socket = new WebSocket(url, roomTicketProtocols(ticket));
    socket.binaryType = 'arraybuffer';
    this.socket = socket;

    socket.addEventListener('message', (event) => this.onMessage(event.data as ArrayBuffer));
    socket.addEventListener('open', () => {
      this.reconnectDelay = RECONNECT_MIN_MS;
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
    if (code === CLOSE_DOCUMENT_DELETED) {
      this.destroyed = true;
      return;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null || this.destroyed || !this.access) return;
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
    if (this.access && !this.socket) this.connect();
  };

  private handleOffline = (): void => {
    this.admissionAbort?.abort();
    this.admissionAbort = null;
    if (this.access) this.setStatus('offline');
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

  private importRemote(bytes: Uint8Array): void {
    if (!this.doc || bytes.byteLength === 0) return;
    try {
      this.doc.import(bytes);
    } catch (error) {
      if (isSnapshotRefusal(error) && isEsbtError(error)) {
        this.emitEngineError(error);
        return;
      }
      if (isEsbtError(error)) {
        console.error('[marks] rejected remote update', error);
        return;
      }
      throw error;
    }
  }

  private importFromTab(bytes: Uint8Array, kind: 'update' | 'snapshot'): void {
    if (this.destroyed || bytes.byteLength === 0) return;
    try {
      this.doc?.import(bytes);
    } catch (error) {
      console.error('[marks] rejected tab update', error);
      return;
    }
    if (kind === 'update') this.send(MSG_UPDATE, bytes);
    else if (this.lastServerVV) this.sendMissingSince(this.lastServerVV);
  }

  private scheduleTabSnapshot(): void {
    if (this.snapshotReplyTimer !== null || this.destroyed || !this.doc) return;
    this.snapshotReplyTimer = window.setTimeout(() => {
      this.snapshotReplyTimer = null;
      if (this.destroyed || !this.doc) return;
      try {
        this.tabs.sendSnapshot(this.doc.exportFullSnapshot());
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
    void this.checkpointJournal();
    this.flushMarkdownCheckpoint();
  }

  private onMessage(raw: ArrayBuffer): void {
    const data = new Uint8Array(raw);
    if (data.length === 0) return;
    this.counters.received += data.byteLength;

    const tag = data[0];
    const payload = data.subarray(1);

    switch (tag) {
      case MSG_UPDATE:
      case MSG_SNAPSHOT:
        this.importRemote(payload);
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
        this.lastAckedVersion = payload;
        this.sendMissingSince(payload);
        void this.maybePrune(payload);
        break;
      case MSG_SYNCED:
        this.setStatus('connected');
        break;
      default:
        break;
    }
  }

  private sendMissingSince(encodedVersion: Uint8Array): void {
    if (!this.doc) return;
    try {
      const payload = exportReconnectPayload(this.doc, encodedVersion);
      if (payload.bytes.byteLength === 0) {
        this.setStatus('connected');
        return;
      }
      this.send(payload.kind === 'snapshot' ? MSG_SNAPSHOT : MSG_UPDATE, payload.bytes);
      this.setStatus('connected');
    } catch (error) {
      if (isEsbtError(error)) this.emitEngineError(error);
      else console.error('[marks] could not diff against server version', error);
    }
  }

  private send(tag: number, payload: Uint8Array): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN || payload.byteLength === 0) return;
    const message = frame(tag, payload);
    socket.send(message);
    this.counters.sent += message.byteLength;
  }

  private scheduleLocalSave(): void {
    if (this.saveTimer !== null) clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.checkpointJournal();
    }, LOCAL_SAVE_DEBOUNCE_MS);
  }

  private scheduleMarkdownCheckpoint(): void {
    if (!this.access && this.markdownTimer !== null) window.clearTimeout(this.markdownTimer);
    if (this.access) return;
    this.markdownTimer = window.setTimeout(() => {
      this.markdownTimer = null;
      this.flushMarkdownCheckpoint();
    }, MARKDOWN_CHECKPOINT_MS);
  }

  private flushMarkdownCheckpoint(): void {
    if (this.access || !this.doc) return;
    writeLocalDocumentText(this.docId, this.doc.getText());
  }

  private async appendLocalUpdate(bytes: Uint8Array): Promise<void> {
    if (!this.doc || bytes.byteLength === 0) return;
    const current = (await readReplicaJournal(this.docId)) ?? this.emptyRecord();
    await writeReplicaJournal(this.docId, appendJournalUpdate(current, bytes));
    this.localSaved = true;
  }

  private emptyRecord(): ReplicaJournalRecord {
    return {
      version: 1,
      siteId: this.marksSiteId,
      snapshot: new Uint8Array(),
      updates: [],
      ackedVersion: this.lastAckedVersion,
      lastPruneAt: this.lastPruneAt,
    };
  }

  private async checkpointJournal(): Promise<void> {
    if (!this.doc) return;
    const doc = this.doc;
    try {
      const snapshot = doc.exportFullSnapshot();
      await writeReplicaJournal(this.docId, {
        version: 1,
        siteId: this.marksSiteId,
        snapshot,
        updates: [],
        ackedVersion: this.lastAckedVersion,
        lastPruneAt: this.lastPruneAt,
      });
      this.counters.snapshotBytes = snapshot.byteLength;
      this.refreshTelemetry();
      this.localSaved = true;
    } catch {
      // Storage pressure or private mode: the server copy is authoritative.
    }
  }

  private async maybePrune(ackedVersion: Uint8Array): Promise<void> {
    if (!this.doc) return;
    if (!shouldPruneHistory(this.doc.retainedOperations, this.lastPruneAt)) return;
    if (this.doc.retainedOperations > JOURNAL_RETAINED_THRESHOLD || this.lastPruneAt > 0) {
      try {
        this.doc.pruneHistoryThrough(ackedVersion);
        this.lastPruneAt = Date.now();
        this.lastAckedVersion = ackedVersion;
        await this.checkpointJournal();
      } catch (error) {
        console.error('[marks] history prune failed', error);
      }
    }
  }

  private refreshTelemetry(): void {
    if (!this.doc) return;
    try {
      this.counters.retainedOperations = this.doc.retainedOperations;
      this.counters.pendingOperations = this.doc.pendingOperations;
      this.counters.historyFloorBytes = this.doc.historyFloor().byteLength;
      this.counters.currentDmax = this.doc.currentDmax();
      this.counters.snapshotBytes = Math.max(
        this.counters.snapshotBytes,
        this.counters.lastUpdateBytes,
      );
    } catch {
      // Destroyed between the mutation and the readout.
    }
  }

  private emitText(): void {
    if (this.textListeners.size === 0) return;
    const text = this.getText();
    for (const listener of this.textListeners) listener(text);
  }

  private emitEngineError(error: EsbtError): void {
    const notice = { code: error.code, message: userMessageForError(error) };
    for (const listener of this.errorListeners) listener(notice);
  }

  private setStatus(status: ConnectionStatus): void {
    if (!this.access) {
      if (this.currentStatus === 'connected') return;
      status = 'connected';
    }
    if (this.currentStatus === status) return;
    this.currentStatus = status;
    for (const listener of this.statusListeners) listener(status);
  }

  private markHydrated(): void {
    if (this.isHydrated) return;
    this.isHydrated = true;
    if (!this.access) this.setStatus('connected');
    for (const listener of this.hydratedListeners) listener();
  }

  private refreshPeers(): void {
    const states = this.ephemeral.getAllStates();
    const selfKey = userKey(this.presenceSiteId());
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
        id: this.presenceSiteId(),
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
    this.flushLocalSave();
    this.destroyed = true;
    window.removeEventListener('online', this.handleOnline);
    window.removeEventListener('offline', this.handleOffline);
    document.removeEventListener('visibilitychange', this.handleVisibility);
    window.removeEventListener('pagehide', this.handlePageHide);
    window.removeEventListener('beforeunload', this.handlePageHide);
    this.admissionAbort?.abort();
    this.admissionAbort = null;
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    if (this.snapshotReplyTimer !== null) clearTimeout(this.snapshotReplyTimer);
    if (this.presenceHeartbeat !== null) clearInterval(this.presenceHeartbeat);
    if (this.markdownTimer !== null) window.clearTimeout(this.markdownTimer);
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.tabs.destroy();
    this.socket?.close();
    this.socket = null;
    this.doc?.destroy();
    this.doc = null;
    this.ephemeral.destroy();
    this.textListeners.clear();
    this.statusListeners.clear();
    this.peerListeners.clear();
    this.hydratedListeners.clear();
    this.errorListeners.clear();
  }
}

function randomLocalSite(): string {
  const bytes = crypto.getRandomValues(new Uint32Array(1));
  const site = (bytes[0] % 0x7fff_fffe) + 2;
  return String(site);
}

function shouldRetryAdmission(error: unknown): boolean {
  return !(
    typeof error === 'object' &&
    error !== null &&
    'retryable' in error &&
    error.retryable === false
  );
}
