
/** Lossy presence protocol. Ordering is (connection instance, sequence), never wall time. */
const PRESENCE_TAG = 5;
const PROTOCOL_VERSION = 2;
const FLAG_DELETED = 1;
const INSTANCE_BYTES = 16;
const MAX_SEQUENCE = Number.MAX_SAFE_INTEGER;
const MAX_PRESENCE_BYTES = 64 * 1024;
const MAX_PRESENCE_ENTRIES = 256;
const MAX_KEY_BYTES = 256;
const MAX_VALUE_BYTES = 16 * 1024;
const MAX_BOOTSTRAP_AGE_MS = 30_000;


const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface PresenceStoreApi {
  set(key: string, value: unknown): void;
  get(key: string): unknown;
  delete(key: string): void;
  keys(): string[];
  getAllStates(): Record<string, unknown>;
  encodeAll(): Uint8Array;
  apply(bytes: Uint8Array): void;
  beginConnectionLifecycle(): void;
  subscribe(listener: () => void): () => void;
  subscribeLocalUpdates(listener: (bytes: Uint8Array) => void): () => void;
  destroy(): void;
}


interface Entry {
  value: unknown;
  receivedAt: number;
  instance: string;
  deleted: boolean;
  local: boolean;
}
interface DecodedEntry {
  key: string;
  deleted: boolean;
  age: number;
  value?: unknown;

}
interface DecodedFrame {
  instance: Uint8Array;
  instanceKey: string;
  sequence: number;
  entries: DecodedEntry[];
}

function monotonicNow(): number {
  return globalThis.performance?.now() ?? 0;
}

function randomInstance(): Uint8Array {
  const value = new Uint8Array(INSTANCE_BYTES);
  globalThis.crypto.getRandomValues(value);
  return value;
}

function instanceKey(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

class Writer {

  private buffer = new Uint8Array(256);
  private length = 0;
  private grow(extra: number): void {
    const required = this.length + extra;
    if (required > MAX_PRESENCE_BYTES)
      throw new RangeError("marks: presence payload exceeds 64 KiB");
    if (required <= this.buffer.length) return;
    let next = this.buffer.length;
    while (next < required) next = Math.min(MAX_PRESENCE_BYTES, next * 2);
    const grown = new Uint8Array(next);
    grown.set(this.buffer.subarray(0, this.length));
    this.buffer = grown;
  }
  u8(value: number): void {
    this.grow(1);
    this.buffer[this.length++] = value & 0xff;
  }
  uint(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0)
      throw new RangeError("marks: invalid presence integer");
    do {
      const byte = value % 128;
      value = Math.floor(value / 128);
      this.u8(byte | (value > 0 ? 0x80 : 0));
    } while (value > 0);
  }
  raw(value: Uint8Array): void {
    this.grow(value.length);
    this.buffer.set(value, this.length);
    this.length += value.length;
  }
  bytes(value: Uint8Array, maximum: number): void {
    if (value.byteLength > maximum)
      throw new RangeError("marks: presence field exceeds its limit");
    this.uint(value.byteLength);
    this.raw(value);
  }
  string(value: string, maximum: number): void {
    this.bytes(encoder.encode(value), maximum);
  }

  done(): Uint8Array {
    if (this.bytes.length > MAX_PRESENCE_BYTES) throw new RangeError('marks: presence exceeds 1536 bytes');
    return Uint8Array.from(this.bytes);
  }
}

class Reader {

  private offset = 0;
  private readonly buffer: Uint8Array;
  constructor(buffer: Uint8Array) {
    this.buffer = buffer;
    if (!buffer.length || buffer.length > MAX_PRESENCE_BYTES)
      throw new RangeError("marks: invalid presence payload length");
  }
  u8(): number {
    if (this.offset >= this.buffer.length)
      throw new TypeError("marks: truncated presence payload");
    return this.buffer[this.offset++];
  }
  uint(): number {
    let value = 0,
      factor = 1,
      encodedBytes = 0;
    for (;;) {
      const byte = this.u8();
      encodedBytes++;
      value += (byte & 0x7f) * factor;
      if (!Number.isSafeInteger(value))
        throw new RangeError("marks: presence integer overflow");
      if ((byte & 0x80) === 0) {
        if (encodedBytes > 1 && byte === 0)
          throw new TypeError("marks: non-canonical presence integer");
        return value;
      }
      factor *= 128;
      if (!Number.isSafeInteger(factor))
        throw new RangeError("marks: presence integer overflow");

    }
    throw new RangeError('marks: invalid presence integer');
  }

  raw(length: number): Uint8Array {
    if (this.offset + length > this.buffer.length)
      throw new TypeError("marks: truncated presence payload");
    const out = this.buffer.slice(this.offset, this.offset + length);
    this.offset += length;
    return out;
  }
  bytes(maximum: number): Uint8Array {
    const length = this.uint();
    if (length > maximum)
      throw new TypeError("marks: invalid presence field length");
    return this.raw(length);
  }
  string(maximum: number): string {
    return decoder.decode(this.bytes(maximum));
  }
  finish(): void {
    if (this.offset !== this.buffer.length)
      throw new TypeError("marks: trailing presence bytes");

  }
  finish() { if (this.at !== this.bytes.length) throw new TypeError('marks: trailing presence bytes'); }
}


function serializableValue(value: unknown): unknown {
  const json = JSON.stringify(value ?? null);
  if (json === undefined)
    throw new TypeError("marks: presence value is not serializable");
  if (encoder.encode(json).length > MAX_VALUE_BYTES)
    throw new RangeError("marks: presence value exceeds 16 KiB");
  return JSON.parse(json) as unknown;
}

function decodeFrame(bytes: Uint8Array): DecodedFrame {
  const reader = new Reader(bytes);
  if (reader.u8() !== PRESENCE_TAG || reader.u8() !== PROTOCOL_VERSION)
    throw new TypeError("marks: unsupported presence payload");
  const instance = reader.raw(INSTANCE_BYTES);
  const sequence = reader.uint();
  if (sequence === 0 || sequence > MAX_SEQUENCE)
    throw new RangeError("marks: invalid presence sequence");
  const count = reader.uint();
  if (count > MAX_PRESENCE_ENTRIES)
    throw new RangeError("marks: too many presence entries");
  const entries: DecodedEntry[] = [];
  for (let index = 0; index < count; index++) {
    const key = reader.string(MAX_KEY_BYTES);
    if (!key) throw new TypeError("marks: empty presence key");
    const flags = reader.u8();
    if (flags === FLAG_DELETED) {
      entries.push({ key, deleted: true, age: 0 });
      continue;
    }
    if (flags !== 0) throw new TypeError("marks: unsupported presence flags");
    const age = reader.uint();
    const json = reader.string(MAX_VALUE_BYTES);
    entries.push({
      key,
      deleted: false,
      age,
      value: JSON.parse(json) as unknown,
    });
  }
  reader.finish();
  return { instance, instanceKey: instanceKey(instance), sequence, entries };

}

export class PresenceStore implements PresenceStoreApi {
  private readonly entries = new Map<string, Entry>();
  private readonly greatestSequence = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  private readonly updates = new Set<(bytes: Uint8Array) => void>();
  private readonly timer: ReturnType<typeof setInterval>;

  private instance = randomInstance();
  private sequence = 0;
  private destroyed = false;
  private readonly ttlMs: number;
  private readonly now: () => number;
  constructor(ttlMs: number, now: () => number = monotonicNow) {
    this.ttlMs = ttlMs;
    this.now = now;
    if (!Number.isFinite(ttlMs) || ttlMs < 1)
      throw new RangeError("marks: presence TTL must be positive");
    this.timer = setInterval(
      () => this.sweep(),
      Math.min(Math.max(500, Math.floor(ttlMs / 2)), 5_000),
    );
    (this.timer as { unref?: () => void }).unref?.();
  }
  beginConnectionLifecycle(): void {
    this.instance = randomInstance();
    this.sequence = 0;
    for (const entry of this.entries.values())
      if (entry.local) entry.instance = instanceKey(this.instance);
  }
  private live(entry: Entry | undefined, now: number): entry is Entry {
    return !!entry && !entry.deleted && now - entry.receivedAt <= this.ttlMs;
  }
  private sweep(): void {
    const now = this.now();
    let changed = false;
    for (const [key, entry] of this.entries)
      if (now - entry.receivedAt > this.ttlMs) {
        this.entries.delete(key);
        if (!entry.deleted) changed = true;
      }
    if (changed) this.notify();
  }
  private notify(): void {
    for (const listener of this.listeners) listener();
  }
  private publication(keys: readonly string[]): Uint8Array {
    // Reserve the terminal value for the room's authoritative retirement.
    if (this.sequence >= MAX_SEQUENCE - 1)
      throw new RangeError(
        "marks: presence sequence exhausted; reconnect required",
      );
    this.sequence++;
    const writer = new Writer();
    writer.u8(PRESENCE_TAG);
    writer.u8(PROTOCOL_VERSION);
    writer.raw(this.instance);
    writer.uint(this.sequence);
    writer.uint(keys.length);
    const now = this.now();
    for (const key of keys) {
      writer.string(key, MAX_KEY_BYTES);
      const entry = this.entries.get(key);
      if (!entry || entry.deleted) {
        writer.u8(FLAG_DELETED);
        continue;
      }
      writer.u8(0);
      writer.uint(
        Math.min(
          MAX_BOOTSTRAP_AGE_MS,
          Math.max(0, Math.floor(now - entry.receivedAt)),
        ),
      );
      writer.string(JSON.stringify(entry.value), MAX_VALUE_BYTES);
    }
    return writer.done();
  }
  private emitLocal(): void {
    if (!this.updateListeners.size) return;
    const bytes = this.publication(this.localKeys());
    for (const listener of this.updateListeners) listener(bytes);
  }
  set(key: string, value: unknown): void {
    if (this.destroyed) return;
    if (!this.entries.has(key) && this.entries.size >= MAX_PRESENCE_ENTRIES)
      throw new RangeError("marks: too many presence entries");
    const stored = serializableValue(value);
    const keyBytes = encoder.encode(key);
    if (!keyBytes.length || keyBytes.length > MAX_KEY_BYTES)
      throw new RangeError("marks: invalid presence key length");
    this.entries.set(key, {
      value: stored,
      receivedAt: this.now(),
      instance: instanceKey(this.instance),
      deleted: false,
      local: true,
    });
    this.emitLocal();
    this.notify();
  }
  get(key: string): unknown {
    const entry = this.entries.get(key);
    return this.live(entry, this.now()) ? entry.value : undefined;
  }
  delete(key: string): void {
    if (this.destroyed) return;
    const entry = this.entries.get(key);
    if (!entry || entry.deleted) return;
    this.entries.set(key, {
      value: undefined,
      receivedAt: this.now(),
      instance: instanceKey(this.instance),
      deleted: true,
      local: true,
    });
    this.emitLocal();
    this.notify();
  }
  keys(): string[] {
    const now = this.now();
    return [...this.entries]
      .filter(([, entry]) => this.live(entry, now))
      .map(([key]) => key);
  }
  getAllStates(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const now = this.now();
    for (const [key, entry] of this.entries)
      if (this.live(entry, now)) out[key] = entry.value;
    return out;
  }
  encodeAll(): Uint8Array {
    return this.publication(this.localKeys());
  }
  private localKeys(): string[] {
    return [...this.entries]
      .filter(([, entry]) => entry.local)
      .map(([key]) => key);
  }
  apply(bytes: Uint8Array): void {
    if (this.destroyed) return;
    const frame = decodeFrame(bytes);
    const greatest = this.greatestSequence.get(frame.instanceKey) ?? 0;
    if (frame.sequence <= greatest) return;
    const now = this.now();
    let changed = false;
    for (const incoming of frame.entries) {
      const existing = this.entries.get(incoming.key);
      if (
        existing &&
        !existing.deleted &&
        existing.instance !== frame.instanceKey &&
        !incoming.deleted
      )
        continue;
      if (incoming.deleted) {
        if (existing && !existing.deleted) changed = true;
        this.entries.set(incoming.key, {
          value: undefined,
          receivedAt: now,
          instance: frame.instanceKey,
          deleted: true,
          local: false,
        });
        continue;
      }
      // Age is only a bounded bootstrap hint. Receipt time remains TTL authority.
      if (incoming.age > MAX_BOOTSTRAP_AGE_MS) continue;
      this.entries.set(incoming.key, {
        value: incoming.value,
        receivedAt: now,
        instance: frame.instanceKey,
        deleted: false,
        local: false,
      });
      changed = true;
    }
    this.greatestSequence.set(frame.instanceKey, frame.sequence);
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
    this.greatestSequence.clear();
    this.listeners.clear();
    this.updateListeners.clear();
  }

}
