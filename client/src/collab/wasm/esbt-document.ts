/** Production browser owner for the Rust `Document` Wasm ABI. */

import type { TextEdit } from '../../text/change';
import { checkedEsbtExports, type EsbtExports } from './esbt-abi.generated.ts';
export type { TextEdit } from '../../text/change';
export type { EsbtExports } from './esbt-abi.generated.ts';

const textDecoder = new TextDecoder();
const MAX_ABI_BYTES = 64 * 1024 * 1024;

export const ESBT_WASM_URL = '/esbt.wasm';

interface WasmArtifactManifest {
  format: number;
  wasm_sha256: string;
}

function manifestUrlFor(wasmUrl: string): string {
  const suffix = wasmUrl.search(/[?#]/u);
  return suffix < 0
    ? `${wasmUrl}.manifest.json`
    : `${wasmUrl.slice(0, suffix)}.manifest.json${wasmUrl.slice(suffix)}`;
}

function isWasmArtifactManifest(value: unknown): value is WasmArtifactManifest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<WasmArtifactManifest>;
  return (
    candidate.format === 2
    && typeof candidate.wasm_sha256 === 'string'
    && /^[0-9a-f]{64}$/u.test(candidate.wasm_sha256)
  );
}

export async function verifyWasmArtifact(
  bytes: ArrayBuffer,
  manifest: unknown,
): Promise<void> {
  if (!isWasmArtifactManifest(manifest)) {
    throw new TypeError('esbt: invalid Wasm provenance manifest');
  }
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const actual = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  if (actual !== manifest.wasm_sha256) {
    throw new TypeError('esbt: Wasm bytes do not match their provenance manifest');
  }
}

export class EsbtError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = 'EsbtError';
    this.code = code;
  }
}

export class EsbtRuntime {
  readonly exports: EsbtExports;

  private constructor(exports: EsbtExports) {
    this.exports = exports;
  }

  static async load(url = ESBT_WASM_URL): Promise<EsbtRuntime> {
    const [response, manifestResponse] = await Promise.all([
      fetch(url),
      fetch(manifestUrlFor(url)),
    ]);
    if (!response.ok) throw new Error(`esbt: failed to fetch Wasm (${response.status})`);
    if (!manifestResponse.ok) {
      throw new Error(`esbt: failed to fetch Wasm manifest (${manifestResponse.status})`);
    }
    const fallback = response.clone();
    const streaming = typeof WebAssembly.instantiateStreaming === 'function'
      ? WebAssembly.instantiateStreaming(response, { env: {} }).catch(() => null)
      : Promise.resolve(null);
    const [bytes, manifest, instantiated] = await Promise.all([
      fallback.arrayBuffer(),
      manifestResponse.json() as Promise<unknown>,
      streaming,
    ]);
    if (bytes.byteLength > MAX_ABI_BYTES) {
      throw new EsbtError(7, 'esbt: Wasm artifact exceeds the runtime limit');
    }
    await verifyWasmArtifact(bytes, manifest);
    if (instantiated) {
      return new EsbtRuntime(checkedEsbtExports(instantiated.module, instantiated.instance.exports));
    }
    // Local/static servers may not send application/wasm; byte fallback is
    // still integrity-checked and keeps those environments usable.
    return EsbtRuntime.fromBytes(bytes);
  }

  static async fromBytes(bytes: BufferSource): Promise<EsbtRuntime> {
    const { module, instance } = await WebAssembly.instantiate(bytes, { env: {} });
    return new EsbtRuntime(checkedEsbtExports(module, instance.exports));
  }

  memory(): Uint8Array {
    return new Uint8Array(this.exports.memory.buffer);
  }

  last(): Uint8Array {
    const length = this.exports.esbt_last_len();
    const pointer = this.exports.esbt_last_ptr();
    return this.memory().slice(pointer, pointer + length);
  }

  check(result: number): number {
    if (result >= 0) return result;
    const code = this.exports.esbt_doc_last_error_code() >>> 0;
    throw new EsbtError(code, textDecoder.decode(this.last()) || `esbt error ${code}`);
  }

  withBytes<T>(bytes: Uint8Array, callback: (pointer: number, length: number) => T): T {
    const input = bytes;
    if (input.length > MAX_ABI_BYTES) {
      throw new EsbtError(7, 'esbt: input exceeds the Wasm message limit');
    }
    if (input.length === 0) return callback(0, 0);
    const pointer = this.exports.esbt_malloc(input.length);
    if (!pointer) throw new EsbtError(7, 'esbt: Wasm input allocation failed');
    try {
      this.memory().set(input, pointer);
      return callback(pointer, input.length);
    } finally {
      this.exports.esbt_free(pointer, input.length);
    }
  }

  withTwoBuffers<T>(
    first: Uint8Array,
    second: Uint8Array,
    callback: (
      firstPointer: number,
      firstLength: number,
      secondPointer: number,
      secondLength: number,
    ) => T,
  ): T {
    return this.withBytes(first, (firstPointer, firstLength) =>
      this.withBytes(second, (secondPointer, secondLength) =>
        callback(firstPointer, firstLength, secondPointer, secondLength),
      ),
    );
  }
}

function pushVarint(bytes: number[], value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new EsbtError(4, 'esbt: config values must be non-negative safe integers');
  }
  do {
    const group = value % 128;
    value = Math.floor(value / 128);
    bytes.push(value > 0 ? group | 0x80 : group);
  } while (value > 0);
}

const STRATEGY_TAGS: Record<string, number> = {
  midpoint: 0,
  'boundary-low': 1,
  'boundary-high': 2,
  'alternating-by-depth': 3,
};

export const LIMIT_FIELDS = [
  'maxMessageBytes',
  'maxOperationsPerUpdate',
  'maxIdentifierDepth',
  'maxVersionSites',
  'maxSparseReceipts',
  'maxSnapshotItems',
  'maxPendingOperations',
  'maxDeferredDeletes',
  'maxDocumentUnits',
  'maxAllocationAttempts',
  'maxRetainedOperations',
  'maxUndoTransactions',
] as const;

export type LimitField = (typeof LIMIT_FIELDS)[number];

export const DEFAULT_LIMITS: Record<LimitField, number> = {
  maxMessageBytes: 16 * 1024 * 1024,
  maxOperationsPerUpdate: 100_000,
  maxIdentifierDepth: 1_024,
  maxVersionSites: 65_536,
  maxSparseReceipts: 1_000_000,
  maxSnapshotItems: 2_000_000,
  maxPendingOperations: 250_000,
  maxDeferredDeletes: 2_000_000,
  maxDocumentUnits: 2_000_000,
  maxAllocationAttempts: 65_536,
  maxRetainedOperations: 4_000_000,
  maxUndoTransactions: 10_000,
};

export type AllocationStrategyKind =
  | 'midpoint'
  | 'boundary-low'
  | 'boundary-high'
  | 'alternating-by-depth';

export interface DocumentConfigInput {
  dmax?: number;
  base?: number;
  depth?: number;
  strategy?: { kind: AllocationStrategyKind; boundary?: number };
  adaptiveDmax?: { floor?: number; ceiling?: number; window?: number; holdoffWindows?: number };
  limits?: Partial<Record<LimitField, number>>;
}

export function encodeDocumentConfig(config: DocumentConfigInput = {}): Uint8Array {
  const bytes = [1, 0];
  const flags = (config.adaptiveDmax ? 0b01 : 0) | 0b10;
  bytes.push(flags);
  pushVarint(bytes, config.dmax ?? 65_536);
  pushVarint(bytes, config.base ?? 2_147_483_647);
  pushVarint(bytes, config.depth ?? 256);
  const strategy = config.strategy ?? { kind: 'midpoint' };
  const tag = STRATEGY_TAGS[strategy.kind];
  if (tag === undefined) throw new EsbtError(4, `esbt: unknown strategy ${strategy.kind}`);
  bytes.push(tag);
  if (tag !== 0) pushVarint(bytes, strategy.boundary ?? 64);
  if (config.adaptiveDmax) {
    pushVarint(bytes, config.adaptiveDmax.floor ?? 16);
    pushVarint(bytes, config.adaptiveDmax.ceiling ?? 2_147_483_648);
    pushVarint(bytes, config.adaptiveDmax.window ?? 256);
    pushVarint(bytes, config.adaptiveDmax.holdoffWindows ?? 4);
  }
  const limits = { ...DEFAULT_LIMITS, ...config.limits };
  for (const field of LIMIT_FIELDS) pushVarint(bytes, limits[field]);
  return new Uint8Array(bytes);
}

export interface CreateDocumentOptions {
  runtime?: EsbtRuntime;
  wasmUrl?: string;
  siteId?: string | Uint8Array;
  config?: DocumentConfigInput;
}

export interface TransactOptions {
  origin?: string;
  undoGroup?: bigint | number;
}

export interface ChangeEvent {
  edits: TextEdit[];
  origin?: string;
  local: boolean;
}

export interface ApplyReceipt {
  outcome: string;
  visibleChanged: boolean;
  acceptedOperations: Array<{ origin: string; sequence: bigint }>;
  appliedOperations: Array<{ origin: string; sequence: bigint }>;
  bufferedOperations: Array<{ origin: string; sequence: bigint }>;
  newlyReadyOperations: Array<{ origin: string; sequence: bigint }>;
  version: Uint8Array;
  journalBytes: Uint8Array | null;
  visibleEdits: TextEdit[];
}

export interface SnapshotReceipt {
  kind: 'full' | 'compact';
  visibleChanged: boolean;
  undo: string;
  version: Uint8Array;
  visibleEdits: TextEdit[];
}

export class EsbtDocument {
  readonly runtime: EsbtRuntime;
  readonly handle: number;
  readonly siteId: string;
  private readonly localUpdateListeners = new Set<(update: Uint8Array) => void>();
  private readonly changeListeners = new Set<(event: ChangeEvent) => void>();
  private transactionDepth = 0;
  private transactionOrigin: string | undefined;
  private destroyed = false;

  static async create(options: CreateDocumentOptions = {}): Promise<EsbtDocument> {
    const runtime = options.runtime ?? (await EsbtRuntime.load(options.wasmUrl));
    const siteWords = normalizeSiteId(options.siteId);
    const handle = options.config
      ? runtime.withBytes(encodeDocumentConfig(options.config), (pointer, length) =>
          runtime.check(
            runtime.exports.esbt_doc_create_configured(
              siteWords[0],
              siteWords[1],
              siteWords[2],
              siteWords[3],
              pointer,
              length,
            ),
          ),
        )
      : runtime.check(
          runtime.exports.esbt_doc_create(siteWords[0], siteWords[1], siteWords[2], siteWords[3]),
        );
    if (handle === 0) throw new EsbtError(24, 'esbt: document creation returned no handle');
    return new EsbtDocument(runtime, handle, siteWords);
  }

  constructor(runtime: EsbtRuntime, handle: number, siteWords: number[]) {
    this.runtime = runtime;
    this.handle = handle >>> 0;
    this.siteId = wordsToHex(siteWords);
  }

  assertLive(): void {
    if (this.destroyed) throw new EsbtError(24, 'esbt: document has been destroyed');
  }

  destroy(): void {
    if (this.destroyed) return;
    this.runtime.check(this.runtime.exports.esbt_doc_destroy(this.handle));
    this.destroyed = true;
    this.localUpdateListeners.clear();
    this.changeListeners.clear();
  }

  get length(): number {
    this.assertLive();
    return this.runtime.check(this.runtime.exports.esbt_doc_len(this.handle));
  }

  getText(): string {
    this.assertLive();
    this.runtime.check(this.runtime.exports.esbt_doc_text_utf16(this.handle));
    return decodeUtf16(this.runtime.last());
  }

  stateHash(): number {
    this.assertLive();
    return this.runtime.exports.esbt_doc_hash(this.handle) >>> 0;
  }

  get pendingOperations(): number {
    this.assertLive();
    return this.runtime.check(this.runtime.exports.esbt_doc_pending(this.handle));
  }

  version(): Uint8Array {
    this.assertLive();
    this.runtime.check(this.runtime.exports.esbt_doc_version(this.handle));
    return this.runtime.last();
  }

  transact<T>(fn: () => T, options: TransactOptions = {}): T {
    this.assertLive();
    if (this.transactionDepth > 0) {
      this.transactionDepth += 1;
      try {
        const value = fn();
        if (value && typeof (value as { then?: unknown }).then === 'function') {
          throw new TypeError('esbt: transact callback must be synchronous');
        }
        return value;
      } finally {
        this.transactionDepth -= 1;
      }
    }

    const [hasGroup, low, high] = encodeUndoGroup(options.undoGroup);
    this.runtime.check(this.runtime.exports.esbt_doc_begin(this.handle, hasGroup, low, high));
    this.transactionDepth = 1;
    this.transactionOrigin = options.origin;
    try {
      const value = fn();
      if (value && typeof (value as { then?: unknown }).then === 'function') {
        throw new TypeError('esbt: transact callback must be synchronous');
      }
      this.transactionDepth = 0;
      const result = this.runtime.check(this.runtime.exports.esbt_doc_commit(this.handle));
      this.consumeLocalResult(result, this.transactionOrigin);
      return value;
    } catch (error) {
      this.transactionDepth = 0;
      try {
        this.runtime.check(this.runtime.exports.esbt_doc_abort(this.handle));
      } catch {
        // The Rust edit path already rolls back a transaction that fails.
      }
      throw error;
    } finally {
      this.transactionOrigin = undefined;
    }
  }

  insert(index: number, text: string, options: TransactOptions = {}): Uint8Array | null {
    return this.replaceRange(index, index, text, options);
  }

  delete(index: number, length: number, options: TransactOptions = {}): Uint8Array | null {
    this.assertLive();
    const [hasGroup, low, high] = encodeUndoGroup(options.undoGroup);
    const result = this.runtime.check(
      this.runtime.exports.esbt_doc_delete(
        this.handle,
        checkedIndex(index),
        checkedIndex(length),
        hasGroup,
        low,
        high,
      ),
    );
    return this.consumeLocalResult(result, options.origin);
  }

  replaceRange(
    from: number,
    to: number,
    insertedText: string,
    options: TransactOptions = {},
  ): Uint8Array | null {
    this.assertLive();
    const bytes = encodeUtf16(String(insertedText));
    const [hasGroup, low, high] = encodeUndoGroup(options.undoGroup);
    const result = this.runtime.withBytes(bytes, (pointer, length) =>
      this.runtime.check(
        this.runtime.exports.esbt_doc_replace_utf16(
          this.handle,
          checkedIndex(from),
          checkedIndex(to),
          pointer,
          length,
          hasGroup,
          low,
          high,
        ),
      ),
    );
    return this.consumeLocalResult(result, options.origin);
  }

  setText(text: string, options: TransactOptions = {}): Uint8Array | null {
    return this.replaceRange(0, this.length, text, options);
  }

  indexToAnchor(index: number, affinity: 'before' | 'after' = 'after'): Uint8Array {
    this.assertLive();
    const encodedAffinity = affinity === 'before' ? 1 : 2;
    const result = this.runtime.check(
      this.runtime.exports.esbt_doc_anchor(this.handle, checkedIndex(index), encodedAffinity),
    );
    if (result < 1) throw new EsbtError(25, 'esbt: anchor creation returned no bytes');
    return this.runtime.last();
  }

  anchorToIndex(anchor: Uint8Array): number {
    this.assertLive();
    return this.runtime.withBytes(anchor, (pointer, length) =>
      this.runtime.check(
        this.runtime.exports.esbt_doc_resolve_anchor(this.handle, pointer, length),
      ),
    );
  }

  applyUpdate(bytes: Uint8Array): ApplyReceipt {
    this.assertLive();
    const receiptBytes = this.runtime.withBytes(bytes, (pointer, length) => {
      this.runtime.check(this.runtime.exports.esbt_doc_apply(this.handle, pointer, length));
      return this.runtime.last();
    });
    const receipt = decodeApplyReceipt(receiptBytes);
    receipt.visibleEdits = this.readVisibleEdits();
    if (receipt.visibleChanged !== (receipt.visibleEdits.length > 0)) {
      throw new EsbtError(4, 'esbt: apply receipt disagrees with visible edits');
    }
    if (receipt.visibleEdits.length > 0) this.emitChange(receipt.visibleEdits, undefined, false);
    return receipt;
  }

  applySnapshot(bytes: Uint8Array): SnapshotReceipt {
    this.assertLive();
    const receiptBytes = this.runtime.withBytes(bytes, (pointer, length) => {
      this.runtime.check(
        this.runtime.exports.esbt_doc_apply_snapshot(this.handle, pointer, length),
      );
      return this.runtime.last();
    });
    const receipt = decodeSnapshotReceipt(receiptBytes);
    receipt.visibleEdits = this.readVisibleEdits();
    if (receipt.visibleChanged !== (receipt.visibleEdits.length > 0)) {
      throw new EsbtError(4, 'esbt: snapshot receipt disagrees with visible edits');
    }
    if (receipt.visibleEdits.length > 0) this.emitChange(receipt.visibleEdits, undefined, false);
    return receipt;
  }

  import(bytes: Uint8Array): ApplyReceipt | SnapshotReceipt {
    const tag = envelopeTag(bytes);
    if (tag === 3 || tag === 6) return this.applySnapshot(bytes);
    if (tag === 5) return this.applyUpdate(bytes);
    throw new EsbtError(4, 'esbt: unsupported import envelope');
  }

  exportFullSnapshot(): Uint8Array {
    this.assertLive();
    this.runtime.check(this.runtime.exports.esbt_doc_export_full_snapshot(this.handle));
    return this.runtime.last();
  }

  exportCompactSnapshot(): Uint8Array {
    this.assertLive();
    this.runtime.check(this.runtime.exports.esbt_doc_export_compact_snapshot(this.handle));
    return this.runtime.last();
  }

  exportUpdate(remoteVersion?: Uint8Array): Uint8Array {
    const version = new Uint8Array(remoteVersion ?? [0, 0, 0, 0]);
    this.assertLive();
    return this.runtime.withBytes(version, (pointer, length) => {
      this.runtime.check(
        this.runtime.exports.esbt_doc_export_update(this.handle, pointer, length),
      );
      return this.runtime.last();
    });
  }

  pruneHistoryThrough(version: Uint8Array): number {
    this.assertLive();
    return this.runtime.withBytes(version, (pointer, length) =>
      this.runtime.check(
        this.runtime.exports.esbt_doc_prune_history(this.handle, pointer, length),
      ),
    );
  }

  get retainedOperations(): number {
    this.assertLive();
    return this.runtime.check(this.runtime.exports.esbt_doc_retained_operations(this.handle));
  }

  historyFloor(): Uint8Array {
    this.assertLive();
    this.runtime.check(this.runtime.exports.esbt_doc_history_floor(this.handle));
    return this.runtime.last();
  }

  currentDmax(): number {
    this.assertLive();
    this.runtime.check(this.runtime.exports.esbt_doc_current_dmax(this.handle));
    const bytes = this.runtime.last();
    return Number(new DataView(bytes.buffer, bytes.byteOffset, 8).getBigInt64(0, true));
  }

  get canUndo(): boolean {
    this.assertLive();
    return this.runtime.check(this.runtime.exports.esbt_doc_can_undo(this.handle)) === 1;
  }

  get canRedo(): boolean {
    this.assertLive();
    return this.runtime.check(this.runtime.exports.esbt_doc_can_redo(this.handle)) === 1;
  }

  undo(options: TransactOptions = {}): Uint8Array | null {
    this.assertLive();
    const result = this.runtime.check(this.runtime.exports.esbt_doc_undo(this.handle));
    return this.consumeLocalResult(result, options.origin ?? 'undo');
  }

  redo(options: TransactOptions = {}): Uint8Array | null {
    this.assertLive();
    const result = this.runtime.check(this.runtime.exports.esbt_doc_redo(this.handle));
    return this.consumeLocalResult(result, options.origin ?? 'redo');
  }

  onLocalUpdate(listener: (update: Uint8Array) => void): () => void {
    this.localUpdateListeners.add(listener);
    return () => this.localUpdateListeners.delete(listener);
  }

  onChange(listener: (event: ChangeEvent) => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  private consumeLocalResult(result: number, origin?: string): Uint8Array | null {
    if (result === 0) return null;
    const update = this.runtime.last();
    const edits = this.readVisibleEdits();
    this.emitLocalUpdate(update, edits, origin);
    return update;
  }

  private emitLocalUpdate(update: Uint8Array, edits: TextEdit[], origin?: string): void {
    const stable = update.slice();
    for (const listener of [...this.localUpdateListeners]) {
      try {
        listener(stable.slice());
      } catch (error) {
        surfaceListenerError(error);
      }
    }
    if (edits.length > 0) this.emitChange(edits, origin, true);
  }

  private readVisibleEdits(): TextEdit[] {
    this.runtime.check(this.runtime.exports.esbt_doc_visible_edits(this.handle));
    return decodeVisibleEdits(this.runtime.last());
  }

  private emitChange(edits: TextEdit[], origin: string | undefined, local: boolean): void {
    if (this.changeListeners.size === 0) return;
    const event: ChangeEvent = {
      edits: edits.map((edit) => ({ ...edit })),
      origin,
      local,
    };
    for (const listener of [...this.changeListeners]) {
      try {
        listener(event);
      } catch (error) {
        surfaceListenerError(error);
      }
    }
  }
}

function surfaceListenerError(error: unknown): void {
  if (typeof globalThis.reportError === 'function') {
    globalThis.reportError(error);
    return;
  }
  queueMicrotask(() => {
    throw error;
  });
}

export function normalizeSiteId(siteId?: string | Uint8Array | null): number[] {
  if (siteId === undefined || siteId === null) {
    const words = crypto.getRandomValues(new Uint32Array(4));
    if (words.every((word) => word === 0)) words[0] = 1;
    return [...words];
  }
  if (typeof siteId === 'string') {
    const hex = siteId.replaceAll('-', '').toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(hex) || /^0+$/.test(hex)) {
      throw new TypeError('esbt: siteId must be a nonzero 128-bit hexadecimal string');
    }
    const bytes = Uint8Array.from(hex.match(/../g) ?? [], (part) => Number.parseInt(part, 16));
    return bytesToWords(bytes);
  }
  if (siteId instanceof Uint8Array && siteId.length === 16) {
    if (siteId.every((byte) => byte === 0)) throw new TypeError('esbt: siteId is zero');
    return bytesToWords(siteId);
  }
  throw new TypeError('esbt: siteId must be a 16-byte array or 32-digit hex string');
}

function bytesToWords(bigEndianBytes: Uint8Array): number[] {
  const words: number[] = [];
  for (let word = 0; word < 4; word++) {
    let value = 0;
    for (let byte = 0; byte < 4; byte++) {
      value = (value << 8) | bigEndianBytes[(3 - word) * 4 + byte];
    }
    words.push(value >>> 0);
  }
  return words;
}

function wordsToHex(words: number[]): string {
  return [...words]
    .reverse()
    .map((word) => (word >>> 0).toString(16).padStart(8, '0'))
    .join('');
}

function encodeUndoGroup(group?: bigint | number | null): [number, number, number] {
  if (group === undefined || group === null) return [0, 0, 0];
  const value = BigInt(group);
  if (value < 0n || value > 0xffff_ffff_ffff_ffffn) {
    throw new RangeError('esbt: undoGroup is outside u64');
  }
  return [1, Number(value & 0xffff_ffffn), Number(value >> 32n)];
}

function checkedIndex(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError('esbt: index must be a nonnegative u32 integer');
  }
  return value >>> 0;
}

function encodeUtf16(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < text.length; index++) {
    view.setUint16(index * 2, text.charCodeAt(index), true);
  }
  return bytes;
}

function decodeUtf16(bytes: Uint8Array): string {
  if (bytes.length % 2 !== 0) throw new EsbtError(4, 'esbt: odd UTF-16 result length');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: string[] = [];
  const chunkSize = 16_384;
  for (let offset = 0; offset < bytes.length / 2; offset += chunkSize) {
    const end = Math.min(bytes.length / 2, offset + chunkSize);
    const units = new Array<number>(end - offset);
    for (let index = offset; index < end; index++) {
      units[index - offset] = view.getUint16(index * 2, true);
    }
    chunks.push(String.fromCharCode(...units));
  }
  return chunks.join('');
}

function decodeVisibleEdits(bytes: Uint8Array): TextEdit[] {
  const reader = new ByteReader(bytes);
  if (reader.u16() !== 1) throw new EsbtError(5, 'esbt: unsupported visible-edit receipt');
  const count = reader.u32();
  const edits: TextEdit[] = [];
  for (let index = 0; index < count; index++) {
    const from = reader.u32();
    const to = reader.u32();
    const units = reader.u32();
    if (to < from || units > 1_000_000) {
      throw new EsbtError(4, 'esbt: invalid visible-edit range');
    }
    edits.push({ from, to, insert: decodeUtf16(reader.bytes(units * 2)) });
  }
  reader.finish();
  return edits;
}

export function envelopeTag(bytes: Uint8Array): number {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.length < 11 ||
    bytes[0] !== 0x45 ||
    bytes[1] !== 0x53 ||
    bytes[2] !== 0x42 ||
    bytes[3] !== 0x4d
  ) {
    return -1;
  }
  return bytes[6];
}

function decodeApplyReceipt(bytes: Uint8Array): ApplyReceipt {
  const reader = new ByteReader(bytes);
  if (reader.u16() !== 1) throw new EsbtError(5, 'esbt: unsupported apply receipt');
  const outcomes = ['invalid', 'applied', 'duplicate', 'buffered', 'mixed', 'noop'];
  const outcome = outcomes[reader.u8()] ?? 'invalid';
  const visibleChanged = reader.u8() === 1;
  const lists: Array<Array<{ origin: string; sequence: bigint }>> = [];
  for (let list = 0; list < 4; list++) {
    const identities = [];
    const count = reader.u32();
    for (let index = 0; index < count; index++) {
      identities.push({ origin: reader.siteId(), sequence: reader.u64() });
    }
    lists.push(identities);
  }
  const version = reader.bytes(reader.u32());
  const journal = reader.bytes(reader.u32());
  reader.finish();
  return {
    outcome,
    visibleChanged,
    acceptedOperations: lists[0],
    appliedOperations: lists[1],
    bufferedOperations: lists[2],
    newlyReadyOperations: lists[3],
    version,
    journalBytes: journal.length > 0 ? journal : null,
    visibleEdits: [],
  };
}

function decodeSnapshotReceipt(bytes: Uint8Array): SnapshotReceipt {
  const reader = new ByteReader(bytes);
  if (reader.u16() !== 1) throw new EsbtError(5, 'esbt: unsupported snapshot receipt');
  const kind = reader.u8() === 1 ? 'full' : 'compact';
  const visibleChanged = reader.u8() === 1;
  const undo = ['invalid', 'preserved', 'cleared', 'partially-preserved'][reader.u8()];
  if (!undo) throw new EsbtError(4, 'esbt: invalid snapshot undo disposition');
  const version = reader.bytes(reader.u32());
  reader.finish();
  return { kind, visibleChanged, undo, version, visibleEdits: [] };
}

class ByteReader {
  private readonly value: Uint8Array;
  private readonly view: DataView;
  private offset = 0;

  constructor(value: Uint8Array) {
    this.value = value;
    this.view = new DataView(value.buffer, value.byteOffset, value.byteLength);
  }

  require(length: number): void {
    if (this.offset + length > this.value.length) {
      throw new EsbtError(4, 'esbt: truncated Wasm result');
    }
  }

  u8(): number {
    this.require(1);
    return this.value[this.offset++];
  }

  u16(): number {
    this.require(2);
    const value = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return value;
  }

  u32(): number {
    this.require(4);
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  u64(): bigint {
    this.require(8);
    const value = this.view.getBigUint64(this.offset, true);
    this.offset += 8;
    return value;
  }

  siteId(): string {
    const littleEndian = this.bytes(16);
    return [...littleEndian]
      .reverse()
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
  }

  bytes(length: number): Uint8Array {
    this.require(length);
    const value = this.value.slice(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  finish(): void {
    if (this.offset !== this.value.length) {
      throw new EsbtError(6, 'esbt: trailing bytes in Wasm result');
    }
  }
}
