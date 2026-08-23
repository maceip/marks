import {
  Annotation,
  EditorState,
  Prec,
  StateEffect,
  StateField,
  type Extension,
} from '@codemirror/state';
import { EditorView, ViewPlugin, keymap } from '@codemirror/view';
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
  acknowledgePendingMutation,
  appendPendingMutation,
  checkpointReplicaJournal,
  JOURNAL_RETAINED_THRESHOLD,
  readReplicaJournal,
  shouldPruneHistory,
  type JournalMutation,
  type ReplicaJournalRecord,
} from './journal';
import { HEARTBEAT_MS, esbtPresence } from './presence';
import { PresenceStore } from './presence-store';
import { EDITOR_CHUNK_UNITS } from './profile';
import {
  MSG_EPHEMERAL,
  MSG_PRESENCE_DELTA,
  MSG_PRESENCE_REMOVAL,
  MSG_PRESENCE_SNAPSHOT,
  MSG_COMMITTED,
  MSG_MUTATION,
  MSG_SERVER_VV,
  MSG_SNAPSHOT,
  MSG_SYNCED,
  MSG_UPDATE,
  decodeCommitted,
  encodeMutation,
  frame,
  randomMutationId,
  toBase64Url,
} from './protocol';
import type {
  CollabSession,
  ConnectionStatus,
  DocumentCapabilities,
  DocumentChange,
  EngineErrorNotice,
  EngineStats,
  Peer,
  ResolvedReviewRange,
  ResolvedTextRange,
  ReviewAnchorRange,
  RoomTicket,
  SessionOptions,
  StableTextRange,
  TextEdit,
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
const CLOSE_AUTHORITY_CHANGED = 4401;
const MAX_VV_QUERY_BYTES = 4_096;
const UNDO_MERGE_MS = 500;
const MARKDOWN_CHECKPOINT_MS = 220;

const userKey = (siteId: string) => `${siteId}-cm-user`;
const fromCrdt = Annotation.define<boolean>();
const setEditorEditable = StateEffect.define<boolean>();
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
  private readonly ephemeral = new PresenceStore(EPHEMERAL_TIMEOUT_MS);
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
  private committedRevision = 0n;
  private lastPruneAt = 0;
  private pendingTicket: RoomTicket | null = null;
  private permissionRole: DocumentCapabilities['role'];
  /**
   * Authority is resolved asynchronously, before or after CodeMirror mounts.
   * A StateField samples the current role when each editor state is created,
   * then accepts explicit changes for a live revocation/grant. A Compartment
   * cannot safely do both: a reconfigure dispatched before a view exists is
   * lost, leaving a newly admitted scratch/owner session read-only.
   */
  private readonly editable = StateField.define<boolean>({
    create: () => this.capabilities().edit,
    update: (value, transaction) => {
      for (const effect of transaction.effects) {
        if (effect.is(setEditorEditable)) return effect.value;
      }
      return value;
    },
    provide: (field) => EditorView.editable.from(field),
  });
  private readonly editorViews = new Set<EditorView>();
  private destroyed = false;
  private isHydrated = false;
  private localSaved = false;
  private serverSynced = false;
  private readonly pendingMutations = new Map<string, JournalMutation>();
  private reconcileQueued = false;
  private reconcileTarget: { view: EditorView; text: string } | null = null;
  private editorPatchQueued = false;
  private editorPatchTarget: { view: EditorView; edits: TextEdit[] } | null = null;
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
  private readonly changeListeners = new Set<(change: DocumentChange) => void>();
  private readonly statusListeners = new Set<(status: ConnectionStatus) => void>();
  private readonly peerListeners = new Set<(peers: Peer[]) => void>();
  private readonly hydratedListeners = new Set<() => void>();
  private readonly errorListeners = new Set<(error: EngineErrorNotice) => void>();
  private readonly durabilityWaiters = new Set<{
    resolve: () => void;
    reject: (error: Error) => void;
    timer: number;
  }>();
  private storageError: EngineErrorNotice | null = null;
  private historyMaintenance: Promise<void> | null = null;

  static async open(options: SessionOptions): Promise<EsbtEngine> {
    const engine = new EsbtEngine(options);
    await engine.start();
    return engine;
  }

  constructor({ docId, user, access }: SessionOptions) {
    this.docId = docId;
    this.user = user;
    this.access = access;
    this.permissionRole = access ? null : 'local';
    this.tabs = new TabChannel(tabChannelName('esbt', docId), {
      onHello: () => this.scheduleTabSnapshot(),
      onRequestSnapshot: () => this.scheduleTabSnapshot(),
      onUpdate: (bytes) => this.importFromTab(bytes, 'update'),
      onSnapshot: (bytes) => this.importFromTab(bytes, 'snapshot'),
    });

    this.extension = [
      this.editable,
      EditorState.transactionFilter.of((transaction) => {
        if (
          !transaction.docChanged ||
          transaction.annotation(fromCrdt) ||
          this.capabilities().edit
        ) {
          return transaction;
        }
        return [];
      }),
      esbtPresence(() => this.presenceSiteId(), () => this.doc, this.ephemeral),
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
      doc.onChange((event) => {
        this.refreshTelemetry();
        this.emitChange(event);
        this.scheduleLocalSave();
        this.scheduleMarkdownCheckpoint();
      }),
      doc.onLocalUpdate((bytes) => {
        this.counters.lastUpdateBytes = bytes.byteLength;
        this.localSaved = false;
        void this.persistAndSendMutation(bytes, 'update', true);
      }),
    );
    this.publishUser();
    if (this.presenceHeartbeat === null) {
      this.presenceHeartbeat = window.setInterval(() => this.publishUser(), HEARTBEAT_MS);
    }
    this.unsubscribers.push(
      this.ephemeral.subscribe(() => this.refreshPeers()),
      this.ephemeral.subscribeLocalUpdates((bytes) => this.send(MSG_PRESENCE_DELTA, bytes)),
    );
    this.refreshPeers();
    this.refreshTelemetry();
  }

  private publishUser(): void {
    this.ephemeral.set(userKey(this.presenceSiteId()), {
      active: true,
      colorPreference: this.user.colorIndex,
    });
  }

  private redo(): boolean {
    if (!this.doc?.canRedo) return true;
    this.doc.redo({ origin: 'redo' });
    return true;
  }

  private reconcile(view: EditorView, target: string): void {
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

  /** CodeMirror forbids dispatch during a ViewPlugin update callback. */
  private scheduleReconcile(view: EditorView, text = this.doc?.getText() ?? ''): void {
    this.reconcileTarget = { view, text };
    if (this.reconcileQueued) return;
    this.reconcileQueued = true;
    queueMicrotask(() => {
      this.reconcileQueued = false;
      const target = this.reconcileTarget;
      this.reconcileTarget = null;
      if (target && !this.destroyed) this.reconcile(target.view, target.text);
    });
  }

  /** Apply engine-provided sequential UTF-16 edits after the current
   * CodeMirror callback returns. No full document string crosses this path. */
  private scheduleEditorPatch(view: EditorView, edits: readonly TextEdit[]): void {
    if (edits.length === 0) return;
    if (!this.editorPatchTarget || this.editorPatchTarget.view !== view) {
      this.editorPatchTarget = { view, edits: [] };
    }
    this.editorPatchTarget.edits.push(...edits.map((edit) => ({ ...edit })));
    if (this.editorPatchQueued) return;
    this.editorPatchQueued = true;
    queueMicrotask(() => {
      this.editorPatchQueued = false;
      const target = this.editorPatchTarget;
      this.editorPatchTarget = null;
      if (!target || this.destroyed) return;
      for (const edit of target.edits) {
        const length = target.view.state.doc.length;
        if (edit.from > edit.to || edit.to > length) {
          // A protocol/consumer invariant failed. Recover from the authoritative
          // replica once, rather than applying a guessed offset.
          this.scheduleReconcile(target.view);
          return;
        }
        target.view.dispatch({
          changes: { from: edit.from, to: edit.to, insert: edit.insert },
          annotations: [fromCrdt.of(true)],
        });
      }
    });
  }

  private syncExtension(): Extension {
    return ViewPlugin.define((view) => {
      let disposed = false;
      this.editorViews.add(view);

      queueMicrotask(() => {
        if (!disposed) this.scheduleReconcile(view);
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
          this.scheduleEditorPatch(view, event.edits);
        });
        this.scheduleReconcile(view);
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
            if (
              isEsbtError(error) &&
              (error.code === ESBT_ERROR.MessageTooLarge ||
                error.code === ESBT_ERROR.TooManyOperations)
            ) {
              this.applyChangesInHalves(update, view);
              return;
            }
            if (isRefusedEdit(error) && isEsbtError(error)) {
              this.scheduleReconcile(view);
              this.emitEngineError(error);
              return;
            }
            throw error;
          }
        },
        destroy: () => {
          disposed = true;
          this.editorViews.delete(view);
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
        this.scheduleReconcile(view);
        this.emitEngineError(error);
        return;
      }
      throw error;
    }
  }

  private replaceRangeChunked(from: number, to: number, insert: string): void {
    const doc = this.requireDoc();
    const options = { origin: EDITOR_ORIGIN, undoGroup: this.nextUndoGroup() };
    if (to - from + insert.length <= EDITOR_CHUNK_UNITS) {
      doc.transact(() => {
        if (to > from) doc.delete(from, to - from);
        if (insert.length > 0) doc.insert(from, insert);
      }, options);
      return;
    }

    // Large replacements are bounded CRDT mutations sharing one undo group.
    // Delete at a stable offset, then advance through insertion chunks; no
    // failed mega-transaction is needed to discover the product limit.
    let remainingDelete = to - from;
    while (remainingDelete > 0) {
      const count = Math.min(remainingDelete, EDITOR_CHUNK_UNITS);
      doc.transact(() => doc.delete(from, count), options);
      remainingDelete -= count;
    }
    for (let offset = 0; offset < insert.length; offset += EDITOR_CHUNK_UNITS) {
      const chunk = insert.slice(offset, offset + EDITOR_CHUNK_UNITS);
      doc.transact(() => doc.insert(from + offset, chunk), options);
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

  length(): number {
    return this.doc?.length ?? 0;
  }

  setText(markdown: string): void {
    if (!this.doc || !this.capabilities().edit) return;
    try {
      this.doc.setText(markdown, { origin: 'import' });
    } catch (error) {
      if (isEsbtError(error)) this.emitEngineError(error);
      else throw error;
    }
  }

  replaceRange(from: number, to: number, insert: string): void {
    if (!this.doc || !this.capabilities().edit) return;
    try {
      this.replaceRangeChunked(from, to, insert);
    } catch (error) {
      if (isEsbtError(error)) this.emitEngineError(error);
      else throw error;
    }
  }

  captureTextRange(from: number, to: number): StableTextRange {
    const doc = this.requireDoc();
    const length = doc.length;
    const startOffset = Math.max(0, Math.min(Math.trunc(from), length));
    const endOffset = Math.max(startOffset, Math.min(Math.trunc(to), length));
    return {
      // The range excludes concurrent insertions at either boundary. This is
      // right for both review selections and an async replacement target.
      start: doc.indexToAnchor(startOffset, 'after'),
      end: doc.indexToAnchor(endOffset, 'before'),
      startOffset,
      endOffset,
    };
  }

  resolveTextRange(range: StableTextRange): ResolvedTextRange {
    const doc = this.requireDoc();
    const length = doc.length;
    const from = Math.min(doc.anchorToIndex(range.start), length);
    return { from, to: Math.max(from, Math.min(doc.anchorToIndex(range.end), length)) };
  }

  captureReviewRange(): ReviewAnchorRange {
    const doc = this.requireDoc();
    const focused = [...this.editorViews].find((view) => view.hasFocus);
    const view = focused ?? this.editorViews.values().next().value;
    const selection = view?.state.selection.main;
    const startOffset = selection?.from ?? 0;
    // Quote fallback is product metadata, not a second copy of an arbitrarily
    // large document selection. Bound a review range to 4,096 UTF-16 units;
    // its UTF-8 representation is at most the server's 16 KiB quote budget.
    const endOffset = Math.min(selection?.to ?? startOffset, startOffset + 4_096);
    const quote = doc.getText().slice(startOffset, endOffset);
    return { ...this.captureTextRange(startOffset, endOffset), quote };
  }

  resolveReviewRange(range: ReviewAnchorRange): ResolvedReviewRange {
    const doc = this.requireDoc();
    const text = doc.getText();
    let { from, to } = this.resolveTextRange(range);
    if (!range.quote || text.slice(from, to) === range.quote) {
      return { from, to, exact: true };
    }

    // Deleted anchor identities collapse safely in ESBT. If the selected text
    // moved or both identities disappeared, prefer the closest quoted match
    // to the creation offset instead of the first global occurrence.
    let match = -1;
    let distance = Number.POSITIVE_INFINITY;
    for (
      let cursor = text.indexOf(range.quote);
      cursor >= 0;
      cursor = text.indexOf(range.quote, cursor + 1)
    ) {
      const candidateDistance = Math.abs(cursor - range.startOffset);
      if (candidateDistance < distance) {
        match = cursor;
        distance = candidateDistance;
      }
    }
    if (match >= 0) {
      from = match;
      to = match + range.quote.length;
    }
    return { from, to, exact: match >= 0 };
  }

  revealReviewRange(range: ReviewAnchorRange): ResolvedReviewRange {
    const resolved = this.resolveReviewRange(range);
    const view = [...this.editorViews].find((candidate) => candidate.hasFocus)
      ?? this.editorViews.values().next().value;
    if (view) {
      view.dispatch({
        selection: { anchor: resolved.from, head: resolved.to },
        effects: EditorView.scrollIntoView(resolved.from, { y: 'center' }),
      });
      view.focus();
    }
    return resolved;
  }

  whenDurable(timeoutMs = 15_000): Promise<void> {
    if (this.isDurable()) return Promise.resolve();
    if (this.destroyed) return Promise.reject(new Error('document session is closed'));
    return new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve: () => {
          window.clearTimeout(waiter.timer);
          resolve();
        },
        reject: (error: Error) => {
          window.clearTimeout(waiter.timer);
          reject(error);
        },
        timer: 0,
      };
      waiter.timer = window.setTimeout(() => {
        this.durabilityWaiters.delete(waiter);
        reject(new Error('timed out waiting for a durable document commit'));
      }, Math.max(1, timeoutMs));
      this.durabilityWaiters.add(waiter);
    });
  }

  status(): ConnectionStatus {
    return this.currentStatus;
  }

  capabilities(): DocumentCapabilities {
    switch (this.permissionRole) {
      case 'local':
        return { role: 'local', edit: true, comment: true, saveVersion: true, manageShares: false };
      case 'scratch':
        return { role: 'scratch', edit: true, comment: false, saveVersion: false, manageShares: false };
      case 'owner':
        return { role: 'owner', edit: true, comment: true, saveVersion: true, manageShares: true };
      case 'editor':
        return { role: 'editor', edit: true, comment: true, saveVersion: true, manageShares: false };
      case 'commenter':
        return { role: 'commenter', edit: false, comment: true, saveVersion: false, manageShares: false };
      case 'viewer':
        return { role: 'viewer', edit: false, comment: false, saveVersion: false, manageShares: false };
      default:
        return { role: null, edit: false, comment: false, saveVersion: false, manageShares: false };
    }
  }

  private applyTicketPermissions(ticket: RoomTicket): void {
    const next: DocumentCapabilities['role'] =
      ticket.authority === 'scratch' ? 'scratch' : ticket.role;
    this.applyPermissionRole(next);
  }

  private applyPermissionRole(next: DocumentCapabilities['role']): void {
    if (next === this.permissionRole) return;
    this.permissionRole = next;
    const editable = setEditorEditable.of(this.capabilities().edit);
    for (const view of this.editorViews) view.dispatch({ effects: editable });
    if (this.doc) void this.checkpointJournal();
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

  onChange(listener: (change: DocumentChange) => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
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
    if (this.storageError) queueMicrotask(() => listener(this.storageError!));
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

    let stored: ReplicaJournalRecord | null = null;
    try {
      stored = await readReplicaJournal(this.docId);
    } catch (error) {
      this.recordStorageError('The offline journal could not be read. Server sync will continue.', error);
    }
    if (stored) {
      this.permissionRole = this.access
        ? stored.role === 'local' ? null : stored.role
        : 'local';
      const doc = await EsbtDocument.create({
        runtime,
        siteId: marksSiteToEngine(stored.siteId),
        config: MARKS_DOCUMENT_CONFIG,
      });
      for (const mutation of stored.pending) this.pendingMutations.set(mutation.id, mutation);
      this.bindDocument(doc);
      if (stored.snapshot.byteLength > 0) doc.applySnapshot(stored.snapshot);
      for (const mutation of stored.pending) {
        try {
          doc.import(mutation.bytes);
        } catch (error) {
          this.recordStorageError('A journaled edit was corrupt and could not be restored.', error);
        }
      }
      this.lastAckedVersion = stored.ackedVersion;
      this.committedRevision = BigInt(stored.committedRevision ?? '0');
      this.lastPruneAt = stored.lastPruneAt;
      this.localSaved = true;
    } else if (this.access) {
      const ticket = await this.access.admit(this.docId, undefined, new AbortController().signal);
      if (this.destroyed) return;
      this.pendingTicket = ticket;
      this.applyTicketPermissions(ticket);
      this.marksSiteId = ticket.siteId;
      const doc = await EsbtDocument.create({
        runtime,
        siteId: marksSiteToEngine(ticket.siteId),
        config: MARKS_DOCUMENT_CONFIG,
      });
      this.bindDocument(doc);
    } else {
      const localSite = randomLocalSite();
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
      this.applyTicketPermissions(ticket);
      this.openSocket(ticket);
    } catch (error) {
      if (this.admissionAbort === controller) this.admissionAbort = null;
      if (this.destroyed || controller.signal.aborted) return;
      this.setStatus('offline');
      if (shouldRetryAdmission(error)) this.scheduleReconnect();
    }
  }

  private openSocket(ticket: RoomTicket): void {
    // A presence instance is scoped to exactly one WebSocket lifecycle. This
    // happens before construction so even a failed handshake cannot reuse it.
    this.ephemeral.beginConnectionLifecycle();
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
    this.serverSynced = false;

    socket.addEventListener('message', (event) => this.onMessage(event.data as ArrayBuffer));
    socket.addEventListener('open', () => {
      this.reconnectDelay = RECONNECT_MIN_MS;
      this.send(MSG_PRESENCE_DELTA, this.ephemeral.encodeAll());
    });
    socket.addEventListener('close', (event) => this.onDisconnect(socket, event.code));
    socket.addEventListener('error', () => this.onDisconnect(socket));
  }

  private onDisconnect(socket: WebSocket, code?: number): void {
    if (this.socket !== socket) return;
    this.socket = null;
    this.serverSynced = false;
    if (this.destroyed) return;

    this.setStatus('offline');
    if (code === CLOSE_DOCUMENT_DELETED) {
      this.destroyed = true;
      return;
    }
    if (code === CLOSE_AUTHORITY_CHANGED && this.permissionRole !== 'scratch') {
      // An ACL/session epoch changed. Keep the replica readable, but do not
      // admit offline edits under stale authority while a fresh ticket is
      // being resolved.
      this.applyPermissionRole(null);
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
    if (kind === 'update') void this.persistAndSendMutation(bytes, 'update', false);
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

  private flushLocalSave(): Promise<void> {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const checkpoint = this.checkpointJournal();
    this.flushMarkdownCheckpoint();
    return checkpoint;
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
      case MSG_PRESENCE_DELTA:
      case MSG_PRESENCE_SNAPSHOT:
      case MSG_PRESENCE_REMOVAL:
        try {
          // WebSocket messages are processed synchronously in receive order.
          // Thus every durable frame already received on this socket has been
          // imported before any presence identity is exposed to renderers.
          this.ephemeral.apply(payload);
        } catch {
          // presence is best-effort
        }
        break;
      case MSG_SERVER_VV:
        this.lastServerVV = payload;
        void this.maybePrune(payload);
        break;
      case MSG_SYNCED:
        this.serverSynced = true;
        this.synchronizeWithServer();
        break;
      case MSG_COMMITTED:
        this.handleCommitted(payload);
        break;
      default:
        break;
    }
  }

  private sendMissingSince(encodedVersion: Uint8Array): void {
    if (!this.doc) return;
    if (this.pendingMutations.size > 0) {
      this.sendPendingMutations();
      return;
    }
    try {
      // Version encodings are canonical. Avoid manufacturing and journaling a
      // valid-but-empty update whenever both replicas are already equal.
      if (equalBytes(this.doc.version(), encodedVersion)) {
        if (this.serverSynced) this.setStatus('connected');
        return;
      }
      const payload = exportReconnectPayload(this.doc, encodedVersion);
      if (payload.bytes.byteLength === 0) {
        if (this.serverSynced) this.setStatus('connected');
        return;
      }
      void this.persistAndSendMutation(payload.bytes, payload.kind, false);
    } catch (error) {
      if (isEsbtError(error)) this.emitEngineError(error);
      else console.error('[marks] could not diff against server version', error);
    }
  }

  private synchronizeWithServer(): void {
    if (!this.serverSynced) return;
    if (this.pendingMutations.size > 0) {
      this.setStatus('saving');
      this.sendPendingMutations();
      return;
    }
    if (this.lastServerVV) this.sendMissingSince(this.lastServerVV);
    else this.setStatus('connected');
  }

  private sendPendingMutations(): void {
    for (const mutation of this.pendingMutations.values()) this.sendMutation(mutation);
  }

  private sendMutation(mutation: JournalMutation): void {
    this.send(MSG_MUTATION, encodeMutation(mutation.id, mutation.kind, mutation.bytes));
  }

  private handleCommitted(payload: Uint8Array): void {
    let receipt;
    try {
      receipt = decodeCommitted(payload);
    } catch (error) {
      console.error('[marks] invalid commit receipt', error);
      this.socket?.close(1002, 'invalid commit receipt');
      return;
    }
    this.pendingMutations.delete(receipt.id);
    this.lastAckedVersion = receipt.version;
    this.lastServerVV = receipt.version;
    if (receipt.revision > this.committedRevision) this.committedRevision = receipt.revision;

    const doc = this.doc;
    if (doc) {
      void acknowledgePendingMutation(
        this.docId,
        this.emptyRecord(),
        receipt.id,
        receipt.version,
        receipt.revision,
        () => doc.exportFullSnapshot(),
      )
        .then((record) => {
          this.localSaved = true;
          this.counters.snapshotBytes = record.snapshot.byteLength;
        })
        .catch((error) => {
          this.localSaved = false;
          this.recordStorageError('The server saved this edit, but its offline checkpoint failed.', error);
        });
    }
    void this.maybePrune(receipt.version);
    if (this.pendingMutations.size === 0) this.sendMissingSince(receipt.version);
    else if (this.serverSynced) this.setStatus('saving');
    this.resolveDurabilityWaiters();
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

  private async persistAndSendMutation(
    bytes: Uint8Array,
    kind: 'update' | 'snapshot',
    broadcastTab: boolean,
  ): Promise<void> {
    if (!this.doc || bytes.byteLength === 0) return;
    const mutation: JournalMutation = {
      id: randomMutationId(),
      kind,
      bytes: bytes.slice(),
      createdAt: Date.now(),
    };
    this.pendingMutations.set(mutation.id, mutation);
    if (this.access && this.serverSynced) this.setStatus('saving');

    try {
      await appendPendingMutation(this.docId, this.emptyRecord(), mutation);
      this.localSaved = true;
    } catch (error) {
      this.localSaved = false;
      this.recordStorageError('This edit could not be written to the offline journal.', error);
    }

    // Teardown queues a final checkpoint after every persistence request
    // already made in this isolate. Do not start transport/history work behind
    // that barrier; this pending mutation is itself restart-complete.
    if (this.destroyed) return;

    if (broadcastTab) {
      if (kind === 'update') this.tabs.sendUpdate(bytes);
      else this.tabs.sendSnapshot(bytes);
    }

    if (this.access) {
      if (this.serverSynced) this.sendMutation(mutation);
      void this.compactDurableLocalHistory();
      return;
    }

    // A local-only document commits to IndexedDB rather than a server. Capture
    // the state and retire the transient append in the same locked write.
    const doc = this.doc;
    try {
      const record = await acknowledgePendingMutation(
        this.docId,
        this.emptyRecord(),
        mutation.id,
        doc.version(),
        0n,
        () => doc.exportFullSnapshot(),
      );
      this.pendingMutations.delete(mutation.id);
      this.localSaved = true;
      this.counters.snapshotBytes = record.snapshot.byteLength;
      this.resolveDurabilityWaiters();
      void this.compactDurableLocalHistory();
    } catch (error) {
      this.recordStorageError('The local document checkpoint failed.', error);
    }
  }

  private emptyRecord(): ReplicaJournalRecord {
    return {
      version: 3,
      siteId: this.marksSiteId,
      role: this.permissionRole,
      snapshot: new Uint8Array(),
      pending: [...this.pendingMutations.values()].map((mutation) => ({
        ...mutation,
        bytes: mutation.bytes.slice(),
      })),
      ackedVersion: this.lastAckedVersion,
      committedRevision: this.committedRevision.toString(),
      lastPruneAt: this.lastPruneAt,
    };
  }

  private async checkpointJournal(): Promise<void> {
    if (!this.doc) return;
    const doc = this.doc;
    try {
      const record = await checkpointReplicaJournal(this.docId, this.emptyRecord(), () =>
        doc.exportFullSnapshot(),
      );
      this.counters.snapshotBytes = record.snapshot.byteLength;
      this.refreshTelemetry();
      this.localSaved = true;
      this.resolveDurabilityWaiters();
    } catch (error) {
      this.localSaved = false;
      this.recordStorageError('The offline checkpoint could not be written.', error);
    }
  }

  /**
   * Bound the in-memory/full-checkpoint operation log even while offline. Every
   * local operation is already in the atomic pending tail, so a compacted
   * replica can still resend those exact updates before asking for a delta.
   */
  private compactDurableLocalHistory(): Promise<void> {
    return this.runHistoryMaintenance(async () => {
      const doc = this.doc;
      if (!doc || doc.retainedOperations <= JOURNAL_RETAINED_THRESHOLD) return;
      try {
        // First checkpoint the unpruned archive. If the second write loses power,
        // this copy plus the pending tail remains restart-complete.
        const archive = await checkpointReplicaJournal(this.docId, this.emptyRecord(), () =>
          doc.exportFullSnapshot(),
        );
        this.counters.snapshotBytes = archive.snapshot.byteLength;
        this.localSaved = true;
        const localVersion = doc.version();
        doc.pruneHistoryThrough(localVersion);
        this.lastPruneAt = Date.now();
        await this.checkpointJournal();
      } catch (error) {
        this.recordStorageError('Local CRDT history could not be compacted safely.', error);
      }
    });
  }

  private maybePrune(ackedVersion: Uint8Array): Promise<void> {
    return this.runHistoryMaintenance(async () => {
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
    });
  }

  /** Pruning mutates the replica as well as its durable checkpoint. Coalesce
   * concurrent ACK/edit triggers so two maintenance passes can never archive
   * and prune against different floors. */
  private runHistoryMaintenance(work: () => Promise<void>): Promise<void> {
    if (this.historyMaintenance) return this.historyMaintenance;
    const current = work().finally(() => {
      if (this.historyMaintenance === current) this.historyMaintenance = null;
    });
    this.historyMaintenance = current;
    return current;
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

  private emitChange(change: DocumentChange): void {
    if (this.changeListeners.size === 0) return;
    for (const listener of this.changeListeners) listener(change);
  }

  private emitEngineError(error: EsbtError): void {
    const notice = { code: error.code, message: userMessageForError(error) };
    for (const listener of this.errorListeners) listener(notice);
  }

  private recordStorageError(message: string, cause: unknown): void {
    console.error(`[marks] ${message}`, cause);
    this.storageError = { code: -1, message };
    for (const listener of this.errorListeners) listener(this.storageError);
  }

  private setStatus(status: ConnectionStatus): void {
    if (!this.access) {
      if (this.currentStatus === 'connected') return;
      status = 'connected';
    }
    if (this.currentStatus === status) return;
    this.currentStatus = status;
    for (const listener of this.statusListeners) listener(status);
    this.resolveDurabilityWaiters();
  }

  private isDurable(): boolean {
    if (this.pendingMutations.size !== 0 || !this.localSaved) return false;
    return !this.access || (this.serverSynced && this.currentStatus === 'connected');
  }

  private resolveDurabilityWaiters(): void {
    if (!this.isDurable()) return;
    for (const waiter of this.durabilityWaiters) waiter.resolve();
    this.durabilityWaiters.clear();
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
      const user = value as { participantId?: unknown; connectionId?: unknown; name?: unknown; colorIndex?: unknown };
      const name = typeof user.name === 'string' ? user.name : 'Anonymous';
      const connectionId = typeof user.connectionId === 'string' ? user.connectionId : key.replace(/-cm-user$/, '');
      peers.push({
        participantId: typeof user.participantId === 'string' ? user.participantId : connectionId,
        connectionId,
        name,
        colorIndex: typeof user.colorIndex === 'number' && user.colorIndex >= 1 && user.colorIndex <= 8 ? user.colorIndex : 1,
        self: key === selfKey,
      });
    }

    if (!peers.some((peer) => peer.self)) {
      peers.unshift({
        participantId: `self-${this.presenceSiteId()}`,
        connectionId: `self-${this.presenceSiteId()}`,
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
    // The final checkpoint is also a FIFO barrier for this document's earlier
    // IndexedDB work. Queued exporters need the Wasm replica to remain alive
    // until that barrier completes.
    const finalCheckpoint = this.flushLocalSave();
    this.destroyed = true;
    for (const waiter of this.durabilityWaiters) {
      waiter.reject(new Error('document session closed before the edit became durable'));
    }
    this.durabilityWaiters.clear();
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
    const replica = this.doc;
    this.doc = null;
    void finalCheckpoint.then(
      () => replica?.destroy(),
      () => replica?.destroy(),
    );
    this.ephemeral.destroy();
    this.changeListeners.clear();
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

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength
    && left.every((byte, index) => byte === right[index]);
}
