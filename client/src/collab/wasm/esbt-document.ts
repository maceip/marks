/** Production browser owner for the WIT-generated ESBT component. */

import { runWithTimeout, SERVICE_REQUEST_TIMEOUT_MS } from '../../browser/network.ts';
import type { TextEdit } from '../../text/change';
import { instantiate, type Root } from './generated/esbt.js';
import type {
  AdaptiveDmaxConfig,
  AllocationStrategyKind,
  ApplyOutcome,
  ApplyReceipt as ComponentApplyReceipt,
  ArtifactKind,
  Document as ComponentDocument,
  DocumentConfig,
  LocalChange,
  ResourceLimits,
  SiteId,
  SnapshotReceipt as ComponentSnapshotReceipt,
  UndoDisposition,
  VisibleEdit,
} from './generated/interfaces/esbt-document-engine.js';

export type { TextEdit } from '../../text/change';
export type { ArtifactKind } from './generated/interfaces/esbt-document-engine.js';

const DISPOSE =
  (Symbol as unknown as { dispose?: symbol }).dispose ?? Symbol.for('dispose');
const U64_MAX = 0xffff_ffff_ffff_ffffn;
const U128_MAX = (1n << 128n) - 1n;
const MAX_COMPONENT_MODULE_BYTES = 64 * 1024 * 1024;
const MAX_POSITION_BYTES = 4_096;

export const ESBT_COMPONENT_MANIFEST_URL = '/esbt.component.manifest.json';
export const ESBT_RUNTIME_BOOTSTRAP_TIMEOUT_MS = SERVICE_REQUEST_TIMEOUT_MS;

export interface ComponentArtifactDescriptor {
  path: string;
  bytes: number;
  sha256: string;
}

export interface EsbtComponentManifest {
  schema: 'esbt.component-artifact';
  format: 1;
  engine_revision: string;
  source_dirty: boolean;
  source_sha256: string;
  profile_sha256: string;
  wit_package: 'esbt:document@1.0.0';
  wit_sha256: string;
  wire_version: number;
  transpiler_package: '@bytecodealliance/jco-transpile';
  transpiler_version: string;
  component: ComponentArtifactDescriptor;
  wrapper: ComponentArtifactDescriptor;
  core_modules: ComponentArtifactDescriptor[];
  compiler: string;
  target: 'wasm32-unknown-unknown';
}

export class EsbtError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = 'EsbtError';
    this.code = code;
  }
}

function callComponent<T>(callback: () => T): T {
  try {
    return callback();
  } catch (error) {
    const payload = (error as { payload?: unknown } | null)?.payload;
    if (isRecord(payload)
      && Number.isInteger(payload.code)
      && typeof payload.message === 'string') {
      throw new EsbtError(payload.code as number, payload.message);
    }
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validHash(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}

function isArtifactDescriptor(value: unknown): value is ComponentArtifactDescriptor {
  if (!isRecord(value)) return false;
  return typeof value.path === 'string'
    && value.path.startsWith('/')
    && Number.isSafeInteger(value.bytes)
    && (value.bytes as number) > 0
    && (value.bytes as number) <= MAX_COMPONENT_MODULE_BYTES
    && validHash(value.sha256);
}

function isComponentDescriptor(value: unknown): value is ComponentArtifactDescriptor {
  return isArtifactDescriptor(value) && value.path === '/esbt.component.wasm';
}

function isCoreDescriptor(value: unknown): value is ComponentArtifactDescriptor {
  return isArtifactDescriptor(value)
    && /^\/esbt\.core(?:[1-9][0-9]*)?\.wasm$/u.test(value.path);
}

function isWrapperDescriptor(value: unknown): value is ComponentArtifactDescriptor {
  if (!isRecord(value)) return false;
  return value.path === 'client:collab/wasm/generated/esbt.js'
    && Number.isSafeInteger(value.bytes)
    && (value.bytes as number) > 0
    && (value.bytes as number) <= MAX_COMPONENT_MODULE_BYTES
    && validHash(value.sha256);
}

export function isEsbtComponentManifest(value: unknown): value is EsbtComponentManifest {
  if (!isRecord(value)) return false;
  return value.schema === 'esbt.component-artifact'
    && value.format === 1
    && typeof value.engine_revision === 'string'
    && /^[0-9a-f]{40}$/u.test(value.engine_revision)
    && typeof value.source_dirty === 'boolean'
    && validHash(value.source_sha256)
    && validHash(value.profile_sha256)
    && value.wit_package === 'esbt:document@1.0.0'
    && validHash(value.wit_sha256)
    && value.wire_version === 1
    && value.transpiler_package === '@bytecodealliance/jco-transpile'
    && typeof value.transpiler_version === 'string'
    && /^\d+\.\d+\.\d+$/u.test(value.transpiler_version)
    && isComponentDescriptor(value.component)
    && isWrapperDescriptor(value.wrapper)
    && Array.isArray(value.core_modules)
    && value.core_modules.length > 0
    && value.core_modules.length <= 16
    && value.core_modules.every(isCoreDescriptor)
    && new Set(value.core_modules.map((entry) => entry.path)).size === value.core_modules.length
    && typeof value.compiler === 'string'
    && /^rustc \d+\.\d+\.\d+ /u.test(value.compiler)
    && value.target === 'wasm32-unknown-unknown';
}

async function sha256(bytes: Uint8Array): Promise<string> {
  // Copy into an ArrayBuffer-backed view: a caller may supply a view over a
  // SharedArrayBuffer, which WebCrypto's BufferSource type intentionally
  // rejects even though Uint8Array itself permits it.
  const stable = new Uint8Array(bytes.byteLength);
  stable.set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', stable);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function verifyComponentArtifact(
  bytes: Uint8Array,
  descriptor: ComponentArtifactDescriptor,
): Promise<void> {
  if (!isArtifactDescriptor(descriptor)) {
    throw new TypeError('esbt: invalid component artifact descriptor');
  }
  if (bytes.byteLength !== descriptor.bytes) {
    throw new TypeError(`esbt: ${descriptor.path} byte length differs from its manifest`);
  }
  if (await sha256(bytes) !== descriptor.sha256) {
    throw new TypeError(`esbt: ${descriptor.path} bytes do not match their manifest`);
  }
}

type CoreModuleLoader = (
  name: string,
) => WebAssembly.Module | Promise<WebAssembly.Module>;

export interface EsbtRuntimeLoadOptions {
  timeoutMs?: number;
  fetch?: typeof fetch;
  compile?: (bytes: BufferSource) => Promise<WebAssembly.Module>;
}

export class EsbtRuntime {
  readonly engine: Root['engine'];
  readonly manifest: EsbtComponentManifest | null;
  readonly coreModuleBytes: number;

  private constructor(
    engine: Root['engine'],
    manifest: EsbtComponentManifest | null,
    coreModuleBytes: number,
  ) {
    this.engine = engine;
    this.manifest = manifest;
    this.coreModuleBytes = coreModuleBytes;
  }

  static async load(
    manifestUrl = ESBT_COMPONENT_MANIFEST_URL,
    options: EsbtRuntimeLoadOptions = {},
  ): Promise<EsbtRuntime> {
    const fetchImpl = options.fetch ?? globalThis.fetch;
    const compile = options.compile ?? ((bytes: BufferSource) => WebAssembly.compile(bytes));
    return runWithTimeout(
      async (signal) => {
        const manifestResponse = await fetchImpl(manifestUrl, { signal });
        if (!manifestResponse.ok) {
          throw new Error(`esbt: failed to fetch component manifest (${manifestResponse.status})`);
        }
        const manifest: unknown = await manifestResponse.json();
        if (!isEsbtComponentManifest(manifest)) {
          throw new TypeError('esbt: invalid component provenance manifest');
        }
        const byName = new Map(
          manifest.core_modules.map((entry) => [
            entry.path.slice(entry.path.lastIndexOf('/') + 1),
            entry,
          ]),
        );
        const compiled = new Map<string, Promise<WebAssembly.Module>>();
        const loader: CoreModuleLoader = (name) => {
          const existing = compiled.get(name);
          if (existing) return existing;
          const descriptor = byName.get(name);
          if (!descriptor) throw new TypeError(`esbt: manifest does not declare ${name}`);
          const promise = (async () => {
            const response = await fetchImpl(descriptor.path, { signal });
            if (!response.ok) {
              throw new Error(`esbt: failed to fetch ${descriptor.path} (${response.status})`);
            }
            const bytes = new Uint8Array(await response.arrayBuffer());
            await verifyComponentArtifact(bytes, descriptor);
            return compile(bytes);
          })();
          compiled.set(name, promise);
          return promise;
        };
        return EsbtRuntime.instantiate(
          loader,
          manifest,
          manifest.core_modules.reduce((sum, entry) => sum + entry.bytes, 0),
        );
      },
      options.timeoutMs ?? ESBT_RUNTIME_BOOTSTRAP_TIMEOUT_MS,
      null,
      new DOMException('The collaboration engine took too long to start.', 'TimeoutError'),
    );
  }

  /** Instantiate already loaded core modules (tests and the benchmark worker). */
  static async fromCoreModules(
    modules: ReadonlyMap<string, BufferSource> | Readonly<Record<string, BufferSource>>,
  ): Promise<EsbtRuntime> {
    const get = (name: string): BufferSource | undefined => {
      const candidate = modules as ReadonlyMap<string, BufferSource>;
      if (typeof candidate.get === 'function') return candidate.get(name);
      return (modules as Readonly<Record<string, BufferSource>>)[name];
    };
    let total = 0;
    const cache = new Map<string, WebAssembly.Module>();
    return EsbtRuntime.instantiate((name) => {
      const previous = cache.get(name);
      if (previous) return previous;
      const bytes = get(name);
      if (!bytes) throw new TypeError(`esbt: missing component core module ${name}`);
      const view = bytes instanceof ArrayBuffer
        ? new Uint8Array(bytes)
        : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      total += view.byteLength;
      const module = new WebAssembly.Module(view);
      cache.set(name, module);
      return module;
    }, null, total).then((runtime) => {
      // Instantiation is synchronous for precompiled modules, so `total` has
      // been populated by all generated loader requests at this point.
      return new EsbtRuntime(runtime.engine, null, total);
    });
  }

  private static async instantiate(
    loader: CoreModuleLoader,
    manifest: EsbtComponentManifest | null,
    coreModuleBytes: number,
  ): Promise<EsbtRuntime> {
    const root = await instantiate(loader, {});
    if (!root?.engine) throw new Error('esbt: component did not export its WIT engine interface');
    if (root.engine.wireVersion() !== 1) {
      throw new EsbtError(5, 'esbt: component wire version differs from Marks');
    }
    return new EsbtRuntime(root.engine, manifest, coreModuleBytes);
  }

  defaultConfig(): DocumentConfig {
    return this.engine.defaultConfig();
  }

  resolveConfig(config: DocumentConfigInput = {}): DocumentConfig {
    const defaults = this.defaultConfig();
    const strategy = config.strategy
      ? {
          kind: config.strategy.kind,
          boundary: config.strategy.kind === 'midpoint'
            ? 0
            : (config.strategy.boundary ?? 64),
        }
      : defaults.strategy;
    const adaptiveDmax = Object.hasOwn(config, 'adaptiveDmax')
      ? config.adaptiveDmax == null
        ? undefined
        : { ...this.engine.defaultAdaptiveDmaxConfig(), ...config.adaptiveDmax }
      : defaults.adaptiveDmax;
    return {
      dmax: config.dmax ?? defaults.dmax,
      base: config.base ?? defaults.base,
      depth: config.depth ?? defaults.depth,
      strategy,
      adaptiveDmax,
      limits: { ...defaults.limits, ...(config.limits ?? {}) },
    };
  }

  classifyArtifact(bytes: Uint8Array): ArtifactKind {
    return callComponent(() => this.engine.classifyArtifact(bytes));
  }

  emptyVersion(): Uint8Array {
    return this.engine.emptyVersion().slice();
  }
}

let sharedRuntime: Promise<EsbtRuntime> | null = null;

/** Share a successful runtime, but never pin a failed bootstrap across UI retries. */
export function loadSharedEsbtRuntime(
  load: () => Promise<EsbtRuntime> = () => EsbtRuntime.load(),
): Promise<EsbtRuntime> {
  if (sharedRuntime) return sharedRuntime;
  const pending = load();
  sharedRuntime = pending;
  void pending.catch(() => {
    if (sharedRuntime === pending) sharedRuntime = null;
  });
  return pending;
}

export type LimitField = keyof ResourceLimits;

export interface DocumentConfigInput {
  dmax?: number;
  base?: number;
  depth?: number;
  strategy?: { kind: AllocationStrategyKind; boundary?: number };
  adaptiveDmax?: Partial<AdaptiveDmaxConfig> | null;
  limits?: Partial<ResourceLimits>;
}

export interface CreateDocumentOptions {
  runtime?: EsbtRuntime;
  manifestUrl?: string;
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

export interface PresencePositionPair {
  anchor: Uint8Array;
  head: Uint8Array;
}

export type CaretAffinity = 'before' | 'after';

export interface ApplyReceipt {
  outcome: ApplyOutcome;
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
  undo: UndoDisposition;
  version: Uint8Array;
  visibleEdits: TextEdit[];
}

export class EsbtDocument {
  readonly runtime: EsbtRuntime;
  readonly siteId: string;
  private readonly component: ComponentDocument;
  private readonly localUpdateListeners = new Set<(update: Uint8Array) => void>();
  private readonly changeListeners = new Set<(event: ChangeEvent) => void>();
  private readonly replicaChangeListeners = new Set<() => void>();
  private transactionDepth = 0;
  private transactionOrigin: string | undefined;
  private destroyed = false;

  static async create(options: CreateDocumentOptions = {}): Promise<EsbtDocument> {
    const runtime = options.runtime ?? (await EsbtRuntime.load(options.manifestUrl));
    const site = normalizeSiteId(options.siteId);
    const component = callComponent(() =>
      runtime.engine.create(site, runtime.resolveConfig(options.config)),
    );
    return new EsbtDocument(runtime, component, siteToHex(site));
  }

  private constructor(runtime: EsbtRuntime, component: ComponentDocument, siteId: string) {
    this.runtime = runtime;
    this.component = component;
    this.siteId = siteId;
  }

  assertLive(): void {
    if (this.destroyed) throw new EsbtError(24, 'esbt: document has been destroyed');
  }

  destroy(): void {
    if (this.destroyed) return;
    const disposable = this.component as unknown as Record<symbol, (() => void) | undefined>;
    disposable[DISPOSE]?.();
    this.destroyed = true;
    this.localUpdateListeners.clear();
    this.changeListeners.clear();
    this.replicaChangeListeners.clear();
  }

  get length(): number {
    this.assertLive();
    return this.component.length();
  }

  getText(): string {
    this.assertLive();
    return decodeUtf16(this.component.text());
  }

  stateHash(): bigint {
    this.assertLive();
    return this.component.stateHash();
  }

  get pendingOperations(): number {
    this.assertLive();
    return this.component.pendingOperations();
  }

  get retainedOperations(): number {
    this.assertLive();
    return this.component.retainedOperations();
  }

  version(): Uint8Array {
    this.assertLive();
    return this.component.version().slice();
  }

  historyFloor(): Uint8Array {
    this.assertLive();
    return this.component.historyFloor().slice();
  }

  currentDmax(): number {
    this.assertLive();
    return this.component.currentDmax();
  }

  transact<T>(callback: () => T, options: TransactOptions = {}): T {
    this.assertLive();
    if (this.transactionDepth > 0) {
      this.transactionDepth += 1;
      try {
        const value = callback();
        if (value && typeof (value as { then?: unknown }).then === 'function') {
          throw new TypeError('esbt: transact callback must be synchronous');
        }
        return value;
      } finally {
        this.transactionDepth -= 1;
      }
    }

    callComponent(() => this.component.beginTransaction(normalizeUndoGroup(options.undoGroup)));
    this.transactionDepth = 1;
    this.transactionOrigin = options.origin;
    try {
      const value = callback();
      if (value && typeof (value as { then?: unknown }).then === 'function') {
        throw new TypeError('esbt: transact callback must be synchronous');
      }
      this.transactionDepth = 0;
      const change = callComponent(() => this.component.commitTransaction());
      this.consumeLocalChange(change, this.transactionOrigin);
      return value;
    } catch (error) {
      this.transactionDepth = 0;
      try {
        callComponent(() => this.component.abortTransaction());
      } catch {
        // A failing Rust edit atomically rolls its active transaction back.
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
    const start = checkedIndex(index);
    const count = checkedIndex(length);
    const end = start + count;
    if (!Number.isSafeInteger(end) || end > 0xffff_ffff) {
      throw new RangeError('esbt: deletion endpoint exceeds u32');
    }
    return this.replaceRange(start, end, '', options);
  }

  replaceRange(
    from: number,
    to: number,
    insertedText: string,
    options: TransactOptions = {},
  ): Uint8Array | null {
    this.assertLive();
    const change = callComponent(() =>
      this.component.replace(
        checkedIndex(from),
        checkedIndex(to),
        encodeUtf16(String(insertedText)),
        normalizeUndoGroup(options.undoGroup),
      ),
    );
    return this.consumeLocalChange(change, options.origin);
  }

  setText(text: string, options: TransactOptions = {}): Uint8Array | null {
    return this.replaceRange(0, this.length, text, options);
  }

  indexToAnchor(index: number, affinity: CaretAffinity = 'after'): Uint8Array {
    this.assertLive();
    return callComponent(() =>
      this.component.anchor(checkedIndex(index), checkedAffinity(affinity)).slice(),
    );
  }

  anchorToIndex(anchor: Uint8Array): number {
    this.assertLive();
    return callComponent(() => this.component.resolveAnchor(anchor));
  }

  capturePresencePosition(
    anchor: number,
    head: number,
    anchorAffinity: CaretAffinity,
    headAffinity: CaretAffinity,
  ): PresencePositionPair {
    this.assertLive();
    const pair = {
      anchor: callComponent(() =>
        this.component
          .captureCausalPosition(checkedIndex(anchor), checkedAffinity(anchorAffinity))
          .slice(),
      ),
      head: callComponent(() =>
        this.component
          .captureCausalPosition(checkedIndex(head), checkedAffinity(headAffinity))
          .slice(),
      ),
    };
    if (pair.anchor.byteLength > MAX_POSITION_BYTES || pair.head.byteLength > MAX_POSITION_BYTES) {
      throw new EsbtError(7, 'esbt: causal presence position exceeds its product limit');
    }
    return pair;
  }

  resolvePresencePosition(position: PresencePositionPair): { anchor: number; head: number } {
    this.assertLive();
    if (position.anchor.byteLength === 0
      || position.head.byteLength === 0
      || position.anchor.byteLength > MAX_POSITION_BYTES
      || position.head.byteLength > MAX_POSITION_BYTES) {
      throw new EsbtError(4, 'esbt: invalid causal presence position');
    }
    const anchor = callComponent(() => this.component.resolveCausalPosition(position.anchor));
    const head = callComponent(() => this.component.resolveCausalPosition(position.head));
    if (anchor === undefined || head === undefined) {
      throw new EsbtError(25, 'esbt: presence position history is not available yet');
    }
    return { anchor, head };
  }

  applyUpdate(bytes: Uint8Array): ApplyReceipt {
    this.assertLive();
    const receipt = mapApplyReceipt(callComponent(() => this.component.applyUpdate(bytes)));
    if (receipt.visibleEdits.length > 0) this.emitChange(receipt.visibleEdits, undefined, false);
    this.emitReplicaChange();
    return receipt;
  }

  applySnapshot(bytes: Uint8Array): SnapshotReceipt {
    this.assertLive();
    const receipt = mapSnapshotReceipt(callComponent(() => this.component.applySnapshot(bytes)));
    if (receipt.visibleEdits.length > 0) this.emitChange(receipt.visibleEdits, undefined, false);
    this.emitReplicaChange();
    return receipt;
  }

  import(bytes: Uint8Array): ApplyReceipt | SnapshotReceipt {
    switch (this.runtime.classifyArtifact(bytes)) {
      case 'update':
        return this.applyUpdate(bytes);
      case 'compact-snapshot':
      case 'full-snapshot':
        return this.applySnapshot(bytes);
      default:
        throw new EsbtError(4, 'esbt: artifact is not importable document state');
    }
  }

  exportFullSnapshot(): Uint8Array {
    this.assertLive();
    return callComponent(() => this.component.exportFullSnapshot().slice());
  }

  exportCompactSnapshot(): Uint8Array {
    this.assertLive();
    return callComponent(() => this.component.exportCompactSnapshot().slice());
  }

  exportUpdate(remoteVersion = this.runtime.emptyVersion()): Uint8Array {
    this.assertLive();
    return callComponent(() => this.component.exportUpdate(remoteVersion).slice());
  }

  pruneHistoryThrough(version: Uint8Array): number {
    this.assertLive();
    return callComponent(() => this.component.pruneHistoryThrough(version));
  }

  get canUndo(): boolean {
    this.assertLive();
    return this.component.canUndo();
  }

  get canRedo(): boolean {
    this.assertLive();
    return this.component.canRedo();
  }

  undo(options: TransactOptions = {}): Uint8Array | null {
    this.assertLive();
    return this.consumeLocalChange(
      callComponent(() => this.component.undo()),
      options.origin ?? 'undo',
    );
  }

  redo(options: TransactOptions = {}): Uint8Array | null {
    this.assertLive();
    return this.consumeLocalChange(
      callComponent(() => this.component.redo()),
      options.origin ?? 'redo',
    );
  }

  onLocalUpdate(listener: (update: Uint8Array) => void): () => void {
    this.localUpdateListeners.add(listener);
    return () => this.localUpdateListeners.delete(listener);
  }

  onChange(listener: (event: ChangeEvent) => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  /** Fires for durable replica advances, including changes with no visible edit. */
  onReplicaChange(listener: () => void): () => void {
    this.replicaChangeListeners.add(listener);
    return () => this.replicaChangeListeners.delete(listener);
  }

  private consumeLocalChange(change: LocalChange | undefined, origin?: string): Uint8Array | null {
    if (!change) return null;
    const update = change.update.slice();
    const edits = change.visibleEdits.map(mapVisibleEdit);
    if (change.visibleChanged !== (edits.length > 0)) {
      throw new EsbtError(4, 'esbt: local change disagrees with its visible edits');
    }
    this.emitLocalUpdate(update, edits, origin);
    return update;
  }

  private emitLocalUpdate(update: Uint8Array, edits: TextEdit[], origin?: string): void {
    for (const listener of [...this.localUpdateListeners]) {
      try {
        listener(update.slice());
      } catch (error) {
        surfaceListenerError(error);
      }
    }
    if (edits.length > 0) this.emitChange(edits, origin, true);
    this.emitReplicaChange();
  }

  private emitReplicaChange(): void {
    for (const listener of [...this.replicaChangeListeners]) {
      try {
        listener();
      } catch (error) {
        surfaceListenerError(error);
      }
    }
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

function mapVisibleEdit(edit: VisibleEdit): TextEdit {
  return { from: edit.from, to: edit.to, insert: decodeUtf16(edit.inserted) };
}

function mapOperationRef(identity: { origin: SiteId; sequence: bigint }): {
  origin: string;
  sequence: bigint;
} {
  return { origin: siteToHex(identity.origin), sequence: identity.sequence };
}

function mapApplyReceipt(receipt: ComponentApplyReceipt): ApplyReceipt {
  const visibleEdits = receipt.visibleEdits.map(mapVisibleEdit);
  if (receipt.visibleChanged !== (visibleEdits.length > 0)) {
    throw new EsbtError(4, 'esbt: apply receipt disagrees with its visible edits');
  }
  return {
    outcome: receipt.outcome,
    visibleChanged: receipt.visibleChanged,
    acceptedOperations: receipt.acceptedOperations.map(mapOperationRef),
    appliedOperations: receipt.appliedOperations.map(mapOperationRef),
    bufferedOperations: receipt.bufferedOperations.map(mapOperationRef),
    newlyReadyOperations: receipt.newlyReadyOperations.map(mapOperationRef),
    version: receipt.version.slice(),
    journalBytes: receipt.journal?.slice() ?? null,
    visibleEdits,
  };
}

function mapSnapshotReceipt(receipt: ComponentSnapshotReceipt): SnapshotReceipt {
  const visibleEdits = receipt.visibleEdits.map(mapVisibleEdit);
  if (receipt.visibleChanged !== (visibleEdits.length > 0)) {
    throw new EsbtError(4, 'esbt: snapshot receipt disagrees with its visible edits');
  }
  return {
    kind: receipt.kind,
    visibleChanged: receipt.visibleChanged,
    undo: receipt.undo,
    version: receipt.version.slice(),
    visibleEdits,
  };
}

export function normalizeSiteId(siteId?: string | Uint8Array | null): SiteId {
  let value: bigint;
  if (siteId === undefined || siteId === null) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    if (bytes.every((byte) => byte === 0)) bytes[15] = 1;
    value = BigInt(`0x${bytesToHex(bytes)}`);
  } else if (typeof siteId === 'string') {
    const hex = siteId.replaceAll('-', '').toLowerCase();
    if (!/^[0-9a-f]{32}$/u.test(hex)) {
      throw new TypeError('esbt: siteId must be a 128-bit hexadecimal string');
    }
    value = BigInt(`0x${hex}`);
  } else if (siteId instanceof Uint8Array && siteId.length === 16) {
    value = BigInt(`0x${bytesToHex(siteId)}`);
  } else {
    throw new TypeError('esbt: siteId must be a 16-byte array or 32-digit hex string');
  }
  if (value <= 0n || value > U128_MAX) {
    throw new TypeError('esbt: siteId is zero or out of range');
  }
  return { low: value & U64_MAX, high: value >> 64n };
}

function siteToHex(site: SiteId): string {
  return ((site.high << 64n) | site.low).toString(16).padStart(32, '0');
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function normalizeUndoGroup(group?: bigint | number | null): bigint | undefined {
  if (group === undefined || group === null) return undefined;
  const value = BigInt(group);
  if (value < 0n || value > U64_MAX) {
    throw new RangeError('esbt: undoGroup is outside u64');
  }
  return value;
}

function checkedIndex(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError('esbt: index must be a nonnegative u32 integer');
  }
  return value;
}

function checkedAffinity(value: CaretAffinity): CaretAffinity {
  if (value !== 'before' && value !== 'after') {
    throw new TypeError("esbt: affinity must be 'before' or 'after'");
  }
  return value;
}

function encodeUtf16(text: string): Uint16Array {
  const units = new Uint16Array(text.length);
  for (let index = 0; index < text.length; index += 1) units[index] = text.charCodeAt(index);
  return units;
}

function decodeUtf16(units: Uint16Array): string {
  const chunks: string[] = [];
  const chunkSize = 16_384;
  for (let offset = 0; offset < units.length; offset += chunkSize) {
    chunks.push(String.fromCharCode(...units.subarray(offset, offset + chunkSize)));
  }
  return chunks.join('');
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
