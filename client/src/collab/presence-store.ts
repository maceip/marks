/** Compact, lossy presence state. This is deliberately not a generic map codec. */
const TAG = 0x4d;
const VERSION = 2;
const KIND_IDENTITY = 1;
const KIND_SELECTION = 2;
const FLAG_ACTIVE = 1;
const FLAG_REMOVED = 2;
export const MAX_PRESENCE_BYTES = 1536;
const MAX_ACTOR_BYTES = 64;
const MAX_NAME_BYTES = 128;
const LEASE_RENEW_MS = 15_000;

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

interface Entry { value: unknown; at: number; deleted: boolean; sequence: number }
interface KeyParts { actor: string; kind: number }

function parts(key: string): KeyParts {
  const suffix = key.endsWith('-cm-user') ? '-cm-user' : key.endsWith('-cm-sel') ? '-cm-sel' : '';
  if (!suffix) throw new TypeError('marks: unsupported presence section');
  const actor = key.slice(0, -suffix.length);
  const size = encoder.encode(actor).byteLength;
  if (size === 0 || size > MAX_ACTOR_BYTES) throw new RangeError('marks: invalid presence actor');
  return { actor, kind: suffix === '-cm-user' ? KIND_IDENTITY : KIND_SELECTION };
}

function keyFor(actor: string, kind: number): string {
  return `${actor}${kind === KIND_IDENTITY ? '-cm-user' : '-cm-sel'}`;
}

class Writer {
  readonly bytes: number[] = [];
  u8(n: number) { this.bytes.push(n & 255); }
  uint(n: number) {
    if (!Number.isSafeInteger(n) || n < 0) throw new RangeError('marks: invalid presence integer');
    do { const b = n % 128; n = Math.floor(n / 128); this.u8(b | (n ? 128 : 0)); } while (n);
  }
  string(value: string, max: number) {
    const bytes = encoder.encode(value);
    if (bytes.byteLength > max) throw new RangeError('marks: presence metadata exceeds limit');
    this.uint(bytes.byteLength); this.bytes.push(...bytes);
  }
  done(): Uint8Array {
    if (this.bytes.length > MAX_PRESENCE_BYTES) throw new RangeError('marks: presence exceeds 1536 bytes');
    return Uint8Array.from(this.bytes);
  }
}

class Reader {
  private at = 0;
  private readonly bytes: Uint8Array;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    if (!bytes.length || bytes.length > MAX_PRESENCE_BYTES) throw new RangeError('marks: invalid presence length');
  }
  u8(): number { if (this.at >= this.bytes.length) throw new TypeError('marks: truncated presence'); return this.bytes[this.at++]; }
  uint(): number {
    let value = 0, factor = 1;
    for (let count = 0; count < 8; count += 1) {
      const b = this.u8(); value += (b & 127) * factor;
      if (!Number.isSafeInteger(value)) break;
      if (!(b & 128)) return value;
      factor *= 128;
    }
    throw new RangeError('marks: invalid presence integer');
  }
  string(max: number): string {
    const length = this.uint();
    if (length > max || this.at + length > this.bytes.length) throw new TypeError('marks: invalid presence string');
    const value = decoder.decode(this.bytes.subarray(this.at, this.at + length)); this.at += length; return value;
  }
  finish() { if (this.at !== this.bytes.length) throw new TypeError('marks: trailing presence bytes'); }
}

function same(a: unknown, b: unknown): boolean {
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return a === b;
  return JSON.stringify(a) === JSON.stringify(b);
}

export class PresenceStore implements PresenceStoreApi {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<() => void>();
  private readonly updates = new Set<(bytes: Uint8Array) => void>();
  private readonly timer: ReturnType<typeof setInterval>;
  private sequence = 0;
  private destroyed = false;
  private readonly ttlMs: number;
  constructor(ttlMs: number) {
    if (!Number.isFinite(ttlMs) || ttlMs < 1) throw new RangeError('marks: presence TTL must be positive');
    this.ttlMs = ttlMs;
    this.timer = setInterval(() => this.sweep(), Math.min(5000, Math.max(500, ttlMs / 2)));
    (this.timer as { unref?: () => void }).unref?.();
  }
  private notify() { for (const listener of this.listeners) listener(); }
  private sweep() {
    const now = Date.now(); let changed = false;
    for (const [key, entry] of this.entries) if (entry.deleted || now - entry.at > this.ttlMs) { this.entries.delete(key); changed ||= !entry.deleted; }
    if (changed) this.notify();
  }
  private encode(key: string, entry: Entry): Uint8Array {
    const { actor, kind } = parts(key); const writer = new Writer();
    writer.u8(TAG); writer.u8(VERSION); writer.u8(kind);
    writer.u8(entry.deleted ? FLAG_REMOVED : FLAG_ACTIVE); writer.uint(entry.sequence); writer.string(actor, MAX_ACTOR_BYTES);
    if (!entry.deleted && kind === KIND_SELECTION) {
      const selection = entry.value as { from?: unknown; to?: unknown };
      if (!Number.isSafeInteger(selection?.from) || !Number.isSafeInteger(selection?.to) || Number(selection.from) < 0 || Number(selection.to) < 0) throw new TypeError('marks: invalid selection');
      writer.uint(Number(selection.from)); writer.uint(Number(selection.to));
    } else if (!entry.deleted) {
      const identity = entry.value as { name?: unknown; colorClassName?: unknown };
      if (typeof identity?.name !== 'string') throw new TypeError('marks: invalid identity');
      const match = /^marks-user([1-9])$/.exec(String(identity.colorClassName));
      if (!match) throw new TypeError('marks: invalid identity color');
      writer.string(identity.name, MAX_NAME_BYTES); writer.u8(Number(match[1]));
    }
    return writer.done();
  }
  private emit(key: string, entry: Entry) { const bytes = this.encode(key, entry); for (const listener of this.updates) listener(bytes); }
  set(key: string, value: unknown): void {
    if (this.destroyed) return; parts(key);
    const previous = this.entries.get(key); const now = Date.now();
    if (previous && !previous.deleted && same(previous.value, value) && now - previous.at < LEASE_RENEW_MS) return;
    const entry = { value, at: now, deleted: false, sequence: ++this.sequence };
    // Validate before observable state changes.
    const encoded = this.encode(key, entry); this.entries.set(key, entry);
    for (const listener of this.updates) listener(encoded); this.notify();
  }
  get(key: string): unknown { const e = this.entries.get(key); return e && !e.deleted && Date.now() - e.at <= this.ttlMs ? e.value : undefined; }
  delete(key: string): void {
    if (this.destroyed) return; const old = this.entries.get(key); if (!old || old.deleted) return;
    const entry = { value: undefined, at: Date.now(), deleted: true, sequence: ++this.sequence };
    this.entries.set(key, entry); this.emit(key, entry); this.notify();
  }
  keys(): string[] { return [...this.entries].filter(([, e]) => !e.deleted && Date.now() - e.at <= this.ttlMs).map(([k]) => k); }
  getAllStates(): Record<string, unknown> { return Object.fromEntries(this.keys().map((key) => [key, this.entries.get(key)!.value])); }
  encodeAll(): Uint8Array { const key = this.keys()[0]; return key ? this.encode(key, this.entries.get(key)!) : new Uint8Array(); }
  apply(bytes: Uint8Array): void {
    if (this.destroyed) return; const reader = new Reader(bytes);
    if (reader.u8() !== TAG || reader.u8() !== VERSION) throw new TypeError('marks: unsupported presence version');
    const kind = reader.u8(); const flags = reader.u8();
    if ((kind !== KIND_IDENTITY && kind !== KIND_SELECTION) || (flags !== FLAG_ACTIVE && flags !== FLAG_REMOVED)) throw new TypeError('marks: invalid presence record');
    const sequence = reader.uint(); const actor = reader.string(MAX_ACTOR_BYTES); const key = keyFor(actor, kind);
    let value: unknown;
    if (flags === FLAG_ACTIVE && kind === KIND_SELECTION) value = { from: reader.uint(), to: reader.uint() };
    else if (flags === FLAG_ACTIVE) value = { name: reader.string(MAX_NAME_BYTES), colorClassName: `marks-user${reader.u8()}` };
    reader.finish(); const old = this.entries.get(key); if (old && sequence <= old.sequence) return;
    if (flags === FLAG_REMOVED) this.entries.delete(key); else this.entries.set(key, { value, at: Date.now(), deleted: false, sequence });
    this.notify();
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  subscribeLocalUpdates(listener: (bytes: Uint8Array) => void): () => void { this.updates.add(listener); return () => this.updates.delete(listener); }
  destroy(): void { if (this.destroyed) return; this.destroyed = true; clearInterval(this.timer); this.entries.clear(); this.listeners.clear(); this.updates.clear(); }
}
