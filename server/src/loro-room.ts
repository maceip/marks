import { EphemeralStore, LoroDoc, VersionVector } from 'loro-crdt';
import type { WebSocket } from 'ws';
import { PERSIST_DEBOUNCE_MS, PERSIST_MAX_WAIT_MS, ROOM_IDLE_TIMEOUT_MS } from './config.js';
import { MSG_EPHEMERAL, MSG_SERVER_VV, MSG_SNAPSHOT, MSG_SYNCED, MSG_UPDATE, frame, unframe } from './protocol.js';
import { createDocument, documentExists, getState, saveState } from './store.js';
import { deriveTitle } from './title.js';

/** Container id holding the markdown source. Must match the client. */
export const TEXT_CONTAINER = 'markdown';

/** Presence entries older than this are dropped by the ephemeral store. */
const EPHEMERAL_TIMEOUT_MS = 30_000;

/**
 * One in-memory Loro replica per document, shared by every connected client.
 *
 * The server is a full peer rather than a dumb relay: it imports updates so it
 * can answer cold opens with a single snapshot instead of a replay of history,
 * which is what keeps document open latency flat as history grows.
 */
export class LoroRoom {
  private static rooms = new Map<string, LoroRoom>();

  readonly doc = new LoroDoc();
  private readonly ephemeral = new EphemeralStore(EPHEMERAL_TIMEOUT_MS);
  private readonly sockets = new Set<WebSocket>();

  private dirty = false;
  private persistTimer: NodeJS.Timeout | null = null;
  private maxWaitTimer: NodeJS.Timeout | null = null;
  private evictTimer: NodeJS.Timeout | null = null;

  private constructor(readonly id: string) {
    const stored = getState(id);
    if (stored?.state && stored.state.length > 0) {
      try {
        this.doc.import(stored.state);
      } catch (error) {
        console.error(`[loro] ${id}: stored snapshot could not be imported`, error);
      }
    }
  }

  static open(id: string): LoroRoom {
    let room = LoroRoom.rooms.get(id);
    if (!room) {
      if (!documentExists(id)) createDocument({ id, engine: 'loro' });
      room = new LoroRoom(id);
      LoroRoom.rooms.set(id, room);
    }
    room.cancelEviction();
    return room;
  }

  /** The live replica if the room is resident, otherwise undefined. */
  static resident(id: string): LoroRoom | undefined {
    return LoroRoom.rooms.get(id);
  }

  static async flushAll(): Promise<void> {
    for (const room of LoroRoom.rooms.values()) room.persistNow();
  }

  get connections(): number {
    return this.sockets.size;
  }

  text(): string {
    return this.doc.getText(TEXT_CONTAINER).toString();
  }

  snapshot(): Uint8Array {
    return this.doc.export({ mode: 'snapshot' });
  }

  /**
   * A history-trimmed snapshot: same document state, without the operations
   * needed to reconstruct older versions. Cheaper to ship and to load.
   */
  shallowSnapshot(): Uint8Array {
    try {
      return this.doc.export({ mode: 'shallow-snapshot', frontiers: this.doc.frontiers() });
    } catch {
      return this.snapshot();
    }
  }

  /**
   * @param have - the client's version vector, if it already holds state (a
   * warm open from IndexedDB, an HTTP snapshot, or a reconnect). When present
   * we answer with just the operations it is missing instead of a snapshot.
   */
  join(socket: WebSocket, have?: Uint8Array): void {
    this.sockets.add(socket);
    this.cancelEviction();

    // Version vector first: it lets the client ship only the operations we are
    // missing instead of its whole oplog.
    this.send(socket, MSG_SERVER_VV, this.doc.oplogVersion().encode());

    let sentDelta = false;
    if (have && have.length > 0) {
      try {
        const delta = this.doc.export({ mode: 'update', from: VersionVector.decode(have) });
        if (delta.length > 0) this.send(socket, MSG_UPDATE, delta);
        sentDelta = true;
      } catch (error) {
        console.error(`[loro] ${this.id}: unusable client version vector`, error);
      }
    }
    if (!sentDelta) this.send(socket, MSG_SNAPSHOT, this.snapshot());
    if (this.ephemeral.keys().length > 0) {
      this.send(socket, MSG_EPHEMERAL, this.ephemeral.encodeAll());
    }
    this.send(socket, MSG_SYNCED, new Uint8Array(0));

    socket.on('message', (data: Buffer) => this.onMessage(socket, new Uint8Array(data)));
    socket.on('close', () => this.leave(socket));
    socket.on('error', () => this.leave(socket));
  }

  private leave(socket: WebSocket): void {
    if (!this.sockets.delete(socket)) return;
    if (this.sockets.size === 0) {
      this.persistNow();
      this.scheduleEviction();
    }
  }

  private onMessage(from: WebSocket, data: Uint8Array): void {
    if (data.length === 0) return;
    const { tag, payload } = unframe(data);

    switch (tag) {
      case MSG_UPDATE: {
        try {
          this.doc.import(payload);
        } catch (error) {
          console.error(`[loro] ${this.id}: rejected update`, error);
          return;
        }
        this.broadcast(from, data);
        this.markDirty();
        break;
      }
      case MSG_EPHEMERAL: {
        try {
          this.ephemeral.apply(payload);
        } catch {
          return; // presence is best-effort; a bad frame is not fatal
        }
        this.broadcast(from, data);
        break;
      }
      case MSG_SERVER_VV: {
        // Client asked for a diff against the version vector it holds.
        try {
          const vv = VersionVector.decode(payload);
          const missing = this.doc.export({ mode: 'update', from: vv });
          if (missing.length > 0) this.send(from, MSG_UPDATE, missing);
        } catch (error) {
          console.error(`[loro] ${this.id}: bad version vector`, error);
        }
        break;
      }
      default:
        break;
    }
  }

  private broadcast(from: WebSocket, data: Uint8Array): void {
    for (const socket of this.sockets) {
      if (socket === from) continue;
      if (socket.readyState === socket.OPEN) socket.send(data);
    }
  }

  private send(socket: WebSocket, tag: number, payload: Uint8Array): void {
    if (socket.readyState === socket.OPEN) socket.send(frame(tag, payload));
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => this.persistNow(), PERSIST_DEBOUNCE_MS);
    // A steady stream of keystrokes must not defer the write forever.
    this.maxWaitTimer ??= setTimeout(() => this.persistNow(), PERSIST_MAX_WAIT_MS);
  }

  private persistNow(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    if (this.maxWaitTimer) clearTimeout(this.maxWaitTimer);
    this.persistTimer = null;
    this.maxWaitTimer = null;
    if (!this.dirty) return;
    this.dirty = false;

    const markdown = this.text();
    try {
      saveState(this.id, this.snapshot(), deriveTitle(markdown), markdown.length);
    } catch (error) {
      console.error(`[loro] ${this.id}: persist failed`, error);
      this.dirty = true;
    }
  }

  private scheduleEviction(): void {
    this.cancelEviction();
    this.evictTimer = setTimeout(() => {
      if (this.sockets.size > 0) return;
      this.persistNow();
      this.ephemeral.destroy();
      LoroRoom.rooms.delete(this.id);
    }, ROOM_IDLE_TIMEOUT_MS);
  }

  private cancelEviction(): void {
    if (this.evictTimer) {
      clearTimeout(this.evictTimer);
      this.evictTimer = null;
    }
  }
}
