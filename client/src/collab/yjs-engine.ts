import type { Extension } from '@codemirror/state';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { keymap } from '@codemirror/view';
import { IndexeddbPersistence } from 'y-indexeddb';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import * as Y from 'yjs';
import { colorVar } from './user';

/** How often the encoded document size is recomputed for the metrics panel. */
const SNAPSHOT_MEASURE_INTERVAL_MS = 2_000;
import { TEXT_KEY, type CollabSession, type ConnectionStatus, type EngineStats, type Peer, type SessionOptions } from './types';

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

  constructor({ docId, user }: SessionOptions) {
    this.docId = docId;
    this.text = this.doc.getText(TEXT_KEY);

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
    this.persistence.on('synced', () => this.emitText());

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

    // Classify by transaction origin, which is the only way to tell the three
    // sources apart: the provider applies remote updates with itself as the
    // origin, y-indexeddb replays the local cache with itself as the origin,
    // and a local edit arrives with neither.
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === this.provider) this.counters.received += update.byteLength;
      else if (origin !== this.persistence) this.counters.sent += update.byteLength;
      this.measureSnapshot();
    });
    this.provider.awareness?.on('change', () => this.refreshPeers());
    this.refreshPeers();
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
    this.undoManager.destroy();
    this.provider.destroy();
    void this.persistence.destroy();
    this.doc.destroy();
    this.textListeners.clear();
    this.statusListeners.clear();
    this.peerListeners.clear();
  }
}
