/**
 * Presence store. Not in the ESBT paper — marks needs it for avatars and
 * remote cursors. Values are JSON-cloneable. Entries expire after `ttlMs`
 * without a local or remote refresh, and expiry notifies subscribers so a
 * vanished peer's cursor disappears without any traffic.
 *
 * Never persisted, never part of a document snapshot.
 */

import { Reader, TAG_EPHEMERAL, Writer } from './codec.js';

export interface EphemeralStore {
  set(key: string, value: unknown): void;
  get(key: string): unknown;
  delete(key: string): void;
  /** Keys of every live (unexpired) entry. */
  keys(): string[];
  getAllStates(): Record<string, unknown>;

  /** Encode every live entry. Sent on socket open and on local change. */
  encodeAll(): Uint8Array;
  /** Merge remote presence. Unknown keys are added; expired keys dropped. */
  apply(bytes: Uint8Array): void;

  subscribe(listener: () => void): () => void;
  subscribeLocalUpdates(listener: (bytes: Uint8Array) => void): () => void;
  destroy(): void;
}

export interface EphemeralStoreStatic {
  /**
   * @param ttlMs - marks uses 30_000. An entry not refreshed in that window
   *   disappears from `getAllStates`.
   */
  new (ttlMs: number): EphemeralStore;
}

interface Entry {
  value: unknown;
  /** Local clock at the last write or refresh. */
  at: number;
  /** True while a removal still needs to be gossiped. */
  deleted: boolean;
}

const FLAG_DELETED = 1;

class EphemeralStoreImpl implements EphemeralStore {
  private readonly ttlMs: number;
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<() => void>();
  private readonly updateListeners = new Set<(bytes: Uint8Array) => void>();
  private sweeper: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;

  constructor(ttlMs: number) {
    this.ttlMs = Math.max(1, ttlMs);
    const interval = Math.min(Math.max(500, Math.floor(this.ttlMs / 2)), 5_000);
    this.sweeper = setInterval(() => this.sweep(), interval);
    // Node: a presence store must not keep the process alive.
    (this.sweeper as { unref?: () => void }).unref?.();
  }

  private live(entry: Entry | undefined, now: number): entry is Entry {
    return entry !== undefined && !entry.deleted && now - entry.at <= this.ttlMs;
  }

  private sweep(): void {
    const now = Date.now();
    let dropped = false;
    for (const [key, entry] of this.entries) {
      if (entry.deleted || now - entry.at > this.ttlMs) {
        this.entries.delete(key);
        if (!entry.deleted) dropped = true;
      }
    }
    if (dropped) this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private emitLocal(keys: string[]): void {
    if (this.updateListeners.size === 0) return;
    const bytes = this.encodeKeys(keys);
    for (const listener of this.updateListeners) listener(bytes);
  }

  set(key: string, value: unknown): void {
    if (this.destroyed) return;
    this.entries.set(key, { value, at: Date.now(), deleted: false });
    this.emitLocal([key]);
    this.notify();
  }

  get(key: string): unknown {
    const entry = this.entries.get(key);
    return this.live(entry, Date.now()) ? entry.value : undefined;
  }

  delete(key: string): void {
    if (this.destroyed) return;
    const entry = this.entries.get(key);
    if (!entry || entry.deleted) return;
    this.entries.set(key, { value: undefined, at: Date.now(), deleted: true });
    this.emitLocal([key]);
    this.notify();
  }

  keys(): string[] {
    const now = Date.now();
    const out: string[] = [];
    for (const [key, entry] of this.entries) {
      if (this.live(entry, now)) out.push(key);
    }
    return out;
  }

  getAllStates(): Record<string, unknown> {
    const now = Date.now();
    const out: Record<string, unknown> = {};
    for (const [key, entry] of this.entries) {
      if (this.live(entry, now)) out[key] = entry.value;
    }
    return out;
  }

  private encodeKeys(keys: string[]): Uint8Array {
    const now = Date.now();
    const w = new Writer();
    w.u8(TAG_EPHEMERAL);
    w.uint(keys.length);
    for (const key of keys) {
      const entry = this.entries.get(key);
      w.str(key);
      if (!entry || entry.deleted) {
        w.u8(FLAG_DELETED);
        continue;
      }
      w.u8(0);
      // Age instead of a wall-clock timestamp: tolerant of clock skew
      // between peers, exact enough for a 30-second TTL.
      w.uint(Math.max(0, now - entry.at));
      w.str(JSON.stringify(entry.value ?? null));
    }
    return w.done();
  }

  encodeAll(): Uint8Array {
    return this.encodeKeys(this.keys());
  }

  apply(bytes: Uint8Array): void {
    if (this.destroyed || bytes.length === 0) return;
    const r = new Reader(bytes);
    const tag = r.u8();
    if (tag !== TAG_EPHEMERAL) throw new Error(`esbt: not a presence payload (tag ${tag})`);

    const now = Date.now();
    const count = r.uint();
    let changed = false;

    for (let i = 0; i < count; i++) {
      const key = r.str();
      const flags = r.u8();
      if (flags & FLAG_DELETED) {
        const existing = this.entries.get(key);
        if (existing && !existing.deleted) {
          this.entries.delete(key);
          changed = true;
        }
        continue;
      }
      const age = r.uint();
      const value = JSON.parse(r.str()) as unknown;
      if (age > this.ttlMs) continue; // arrived already expired
      const at = now - age;
      const existing = this.entries.get(key);
      if (!existing || at > existing.at || existing.deleted) {
        this.entries.set(key, { value, at, deleted: false });
        changed = true;
      }
    }

    if (changed) this.notify();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeLocalUpdates(listener: (bytes: Uint8Array) => void): () => void {
    this.updateListeners.add(listener);
    return () => this.updateListeners.delete(listener);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.sweeper !== null) clearInterval(this.sweeper);
    this.sweeper = null;
    this.entries.clear();
    this.listeners.clear();
    this.updateListeners.clear();
  }
}

export const EphemeralStore: EphemeralStoreStatic = EphemeralStoreImpl;
