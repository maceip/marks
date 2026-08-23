/**
 * Marks-owned transient presence state.
 *
 * Presence is deliberately outside ESBT: it is lossy, expires locally, is
 * never part of document history, and is only relayed by a room.  Keeping the
 * codec here prevents a second CRDT implementation from becoming an accidental
 * production dependency.
 *
 * Wire format v1 is retained from the original Marks client so rolling deploys
 * can exchange presence:
 *   tag:u8 (=5), count:uleb128,
 *   repeated key:utf8, flags:u8, [age_ms:uleb128, value:json-utf8]
 */

const PRESENCE_TAG = 5;
const FLAG_DELETED = 1;
const MAX_PRESENCE_BYTES = 64 * 1024;
const MAX_PRESENCE_ENTRIES = 256;
const MAX_KEY_BYTES = 256;
const MAX_VALUE_BYTES = 16 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export interface PresenceStoreApi {
  set(key: string, value: unknown): void;
  get(key: string): unknown;
  delete(key: string): void;
  keys(): string[];
  getAllStates(): Record<string, unknown>;
  encodeAll(): Uint8Array;
  apply(bytes: Uint8Array): void;
  subscribe(listener: () => void): () => void;
  subscribeLocalUpdates(listener: (bytes: Uint8Array) => void): () => void;
  destroy(): void;
}

interface Entry {
  value: unknown;
  at: number;
  /** A short-lived removal marker which is sent once, then swept. */
  deleted: boolean;
}

interface DecodedEntry {
  key: string;
  deleted: boolean;
  age: number;
  value?: unknown;
}

class Writer {
  private buffer = new Uint8Array(256);
  private length = 0;

  private grow(extra: number): void {
    const required = this.length + extra;
    if (required > MAX_PRESENCE_BYTES) {
      throw new RangeError('marks: presence payload exceeds 64 KiB');
    }
    if (required <= this.buffer.length) return;
    let next = this.buffer.length;
    while (next < required) next = Math.min(MAX_PRESENCE_BYTES, next * 2);
    const grown = new Uint8Array(next);
    grown.set(this.buffer.subarray(0, this.length));
    this.buffer = grown;
  }

  u8(value: number): void {
    this.grow(1);
    this.buffer[this.length] = value & 0xff;
    this.length += 1;
  }

  uint(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError('marks: invalid presence integer');
    }
    do {
      const byte = value % 128;
      value = Math.floor(value / 128);
      this.u8(byte | (value > 0 ? 0x80 : 0));
    } while (value > 0);
  }

  bytes(value: Uint8Array, maximum: number): void {
    if (value.byteLength > maximum) {
      throw new RangeError('marks: presence field exceeds its limit');
    }
    this.uint(value.byteLength);
    this.grow(value.byteLength);
    this.buffer.set(value, this.length);
    this.length += value.byteLength;
  }

  string(value: string, maximum: number): void {
    this.bytes(encoder.encode(value), maximum);
  }

  done(): Uint8Array {
    return this.buffer.slice(0, this.length);
  }
}

class Reader {
  private offset = 0;
  private readonly buffer: Uint8Array;

  constructor(buffer: Uint8Array) {
    this.buffer = buffer;
    if (buffer.byteLength === 0 || buffer.byteLength > MAX_PRESENCE_BYTES) {
      throw new RangeError('marks: invalid presence payload length');
    }
  }

  u8(): number {
    if (this.offset >= this.buffer.byteLength) {
      throw new TypeError('marks: truncated presence payload');
    }
    const value = this.buffer[this.offset];
    this.offset += 1;
    return value;
  }

  uint(): number {
    let value = 0;
    let factor = 1;
    let encodedBytes = 0;
    for (;;) {
      const byte = this.u8();
      encodedBytes += 1;
      value += (byte & 0x7f) * factor;
      if (!Number.isSafeInteger(value)) {
        throw new RangeError('marks: presence integer overflow');
      }
      if ((byte & 0x80) === 0) {
        if (encodedBytes > 1 && byte === 0) {
          throw new TypeError('marks: non-canonical presence integer');
        }
        return value;
      }
      factor *= 128;
      if (!Number.isSafeInteger(factor)) {
        throw new RangeError('marks: presence integer overflow');
      }
    }
  }

  bytes(maximum: number): Uint8Array {
    const length = this.uint();
    if (length > maximum || this.offset + length > this.buffer.byteLength) {
      throw new TypeError('marks: invalid presence field length');
    }
    const value = this.buffer.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  string(maximum: number): string {
    return decoder.decode(this.bytes(maximum));
  }

  finish(): void {
    if (this.offset !== this.buffer.byteLength) {
      throw new TypeError('marks: trailing presence bytes');
    }
  }
}

function serializableValue(value: unknown): unknown {
  const json = JSON.stringify(value ?? null);
  if (json === undefined) throw new TypeError('marks: presence value is not serializable');
  const encoded = encoder.encode(json);
  if (encoded.byteLength > MAX_VALUE_BYTES) {
    throw new RangeError('marks: presence value exceeds 16 KiB');
  }
  return JSON.parse(json) as unknown;
}

export function decodePresenceFrame(bytes: Uint8Array): ReadonlyArray<DecodedEntry> {
  const reader = new Reader(bytes);
  if (reader.u8() !== PRESENCE_TAG) {
    throw new TypeError('marks: unsupported presence payload');
  }
  const count = reader.uint();
  if (count > MAX_PRESENCE_ENTRIES) {
    throw new RangeError('marks: too many presence entries');
  }

  const entries: DecodedEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    const key = reader.string(MAX_KEY_BYTES);
    if (key.length === 0) throw new TypeError('marks: empty presence key');
    const flags = reader.u8();
    if (flags === FLAG_DELETED) {
      entries.push({ key, deleted: true, age: 0 });
      continue;
    }
    if (flags !== 0) throw new TypeError('marks: unsupported presence flags');
    const age = reader.uint();
    const json = reader.string(MAX_VALUE_BYTES);
    entries.push({ key, deleted: false, age, value: JSON.parse(json) as unknown });
  }
  reader.finish();
  return entries;
}

export class PresenceStore implements PresenceStoreApi {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<() => void>();
  private readonly updateListeners = new Set<(bytes: Uint8Array) => void>();
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly ttlMs: number;
  private destroyed = false;

  constructor(ttlMs: number) {
    if (!Number.isFinite(ttlMs) || ttlMs < 1) {
      throw new RangeError('marks: presence TTL must be positive');
    }
    this.ttlMs = ttlMs;
    const interval = Math.min(Math.max(500, Math.floor(ttlMs / 2)), 5_000);
    this.timer = setInterval(() => this.sweep(), interval);
    (this.timer as { unref?: () => void }).unref?.();
  }

  private live(entry: Entry | undefined, now: number): entry is Entry {
    return entry !== undefined && !entry.deleted && now - entry.at <= this.ttlMs;
  }

  private sweep(): void {
    const now = Date.now();
    let visibleChanged = false;
    for (const [key, entry] of this.entries) {
      if (entry.deleted || now - entry.at > this.ttlMs) {
        this.entries.delete(key);
        if (!entry.deleted) visibleChanged = true;
      }
    }
    if (visibleChanged) this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private encodeKeys(keys: readonly string[]): Uint8Array {
    if (keys.length > MAX_PRESENCE_ENTRIES) {
      throw new RangeError('marks: too many presence entries');
    }
    const writer = new Writer();
    writer.u8(PRESENCE_TAG);
    writer.uint(keys.length);
    const now = Date.now();
    for (const key of keys) {
      if (key.length === 0) throw new TypeError('marks: empty presence key');
      writer.string(key, MAX_KEY_BYTES);
      const entry = this.entries.get(key);
      if (!entry || entry.deleted) {
        writer.u8(FLAG_DELETED);
        continue;
      }
      writer.u8(0);
      writer.uint(Math.max(0, now - entry.at));
      writer.string(JSON.stringify(entry.value), MAX_VALUE_BYTES);
    }
    return writer.done();
  }

  private emitLocal(keys: readonly string[]): void {
    if (this.updateListeners.size === 0) return;
    const bytes = this.encodeKeys(keys);
    for (const listener of this.updateListeners) listener(bytes);
  }

  set(key: string, value: unknown): void {
    if (this.destroyed) return;
    if (!this.entries.has(key) && this.entries.size >= MAX_PRESENCE_ENTRIES) {
      throw new RangeError('marks: too many presence entries');
    }
    const stored = serializableValue(value);
    // Validate the key before changing observable state.
    if (encoder.encode(key).byteLength === 0 || encoder.encode(key).byteLength > MAX_KEY_BYTES) {
      throw new RangeError('marks: invalid presence key length');
    }
    this.entries.set(key, { value: stored, at: Date.now(), deleted: false });
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
    const keys: string[] = [];
    for (const [key, entry] of this.entries) {
      if (this.live(entry, now)) keys.push(key);
    }
    return keys;
  }

  getAllStates(): Record<string, unknown> {
    const now = Date.now();
    const states: Record<string, unknown> = {};
    for (const [key, entry] of this.entries) {
      if (this.live(entry, now)) states[key] = entry.value;
    }
    return states;
  }

  encodeAll(): Uint8Array {
    return this.encodeKeys(this.keys());
  }

  apply(bytes: Uint8Array): void {
    if (this.destroyed) return;
    // Decode the complete frame first. A malformed tail can never half-apply.
    const decoded = decodePresenceFrame(bytes);
    const now = Date.now();
    let changed = false;
    for (const incoming of decoded) {
      if (incoming.deleted) {
        const existing = this.entries.get(incoming.key);
        if (existing && !existing.deleted) {
          this.entries.delete(incoming.key);
          changed = true;
        }
        continue;
      }
      if (incoming.age > this.ttlMs) continue;
      const at = now - incoming.age;
      const existing = this.entries.get(incoming.key);
      if (!existing || existing.deleted || at > existing.at) {
        this.entries.set(incoming.key, { value: incoming.value, at, deleted: false });
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
    clearInterval(this.timer);
    this.entries.clear();
    this.listeners.clear();
    this.updateListeners.clear();
  }
}
