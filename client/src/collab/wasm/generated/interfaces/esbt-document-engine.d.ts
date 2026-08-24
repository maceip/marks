/** @module Interface esbt:document/engine@1.0.0 **/
export function defaultConfig(): DocumentConfig;
export function defaultAdaptiveDmaxConfig(): AdaptiveDmaxConfig;
export function create(site: SiteId, config: DocumentConfig): Document;
export function wireVersion(): number;
export function emptyVersion(): Bytes;
export function classifyArtifact(artifact: Bytes): ArtifactKind;
export function versionCovers(version: Bytes, expected: Bytes): boolean;
export type Bytes = Uint8Array;
export type Utf16Units = Uint16Array;
export interface SiteId {
  low: bigint,
  high: bigint,
}
/**
 * # Variants
 *
 * ## `"midpoint"`
 *
 * ## `"boundary-low"`
 *
 * ## `"boundary-high"`
 *
 * ## `"alternating-by-depth"`
 */
export type AllocationStrategyKind = 'midpoint' | 'boundary-low' | 'boundary-high' | 'alternating-by-depth';
export interface AllocationStrategy {
  kind: AllocationStrategyKind,
  boundary: number,
}
export interface AdaptiveDmaxConfig {
  floor: number,
  ceiling: number,
  window: number,
  holdoffWindows: number,
}
export interface ResourceLimits {
  maxMessageBytes: number,
  maxOperationsPerUpdate: number,
  maxIdentifierDepth: number,
  maxVersionSites: number,
  maxSparseReceipts: number,
  maxSnapshotItems: number,
  maxPendingOperations: number,
  maxDeferredDeletes: number,
  maxDocumentUnits: number,
  maxAllocationAttempts: number,
  maxRetainedOperations: number,
  maxUndoTransactions: number,
}
export interface DocumentConfig {
  dmax: number,
  base: number,
  depth: number,
  strategy: AllocationStrategy,
  adaptiveDmax?: AdaptiveDmaxConfig,
  limits: ResourceLimits,
}
export interface EngineError {
  code: number,
  message: string,
}
export interface VisibleEdit {
  from: number,
  to: number,
  inserted: Utf16Units,
}
export interface OperationRef {
  origin: SiteId,
  sequence: bigint,
}
/**
 * # Variants
 *
 * ## `"applied"`
 *
 * ## `"duplicate"`
 *
 * ## `"buffered"`
 *
 * ## `"mixed"`
 *
 * ## `"noop"`
 */
export type ApplyOutcome = 'applied' | 'duplicate' | 'buffered' | 'mixed' | 'noop';
export interface LocalChange {
  update: Bytes,
  visibleChanged: boolean,
  visibleEdits: Array<VisibleEdit>,
}
export interface ApplyReceipt {
  outcome: ApplyOutcome,
  acceptedOperations: Array<OperationRef>,
  appliedOperations: Array<OperationRef>,
  bufferedOperations: Array<OperationRef>,
  newlyReadyOperations: Array<OperationRef>,
  version: Bytes,
  visibleChanged: boolean,
  visibleEdits: Array<VisibleEdit>,
  journal?: Bytes,
}
/**
 * # Variants
 *
 * ## `"full"`
 *
 * ## `"compact"`
 */
export type SnapshotKind = 'full' | 'compact';
/**
 * # Variants
 *
 * ## `"preserved"`
 *
 * ## `"partially-preserved"`
 *
 * ## `"cleared"`
 */
export type UndoDisposition = 'preserved' | 'partially-preserved' | 'cleared';
export interface SnapshotReceipt {
  kind: SnapshotKind,
  version: Bytes,
  visibleChanged: boolean,
  visibleEdits: Array<VisibleEdit>,
  undo: UndoDisposition,
}
/**
 * # Variants
 *
 * ## `"before"`
 *
 * ## `"after"`
 */
export type Affinity = 'before' | 'after';
/**
 * # Variants
 *
 * ## `"update"`
 *
 * ## `"compact-snapshot"`
 *
 * ## `"full-snapshot"`
 *
 * ## `"version"`
 *
 * ## `"anchor"`
 *
 * ## `"causal-position"`
 */
export type ArtifactKind = 'update' | 'compact-snapshot' | 'full-snapshot' | 'version' | 'anchor' | 'causal-position';
export interface AnchoredInsert {
  change?: LocalChange,
  anchor: Bytes,
}

export class Document {
  /**
   * This type does not have a public constructor.
   */
  private constructor();
  site(): SiteId;
  length(): number;
  text(): Utf16Units;
  stateHash(): bigint;
  pendingOperations(): number;
  retainedOperations(): number;
  currentDmax(): number;
  version(): Bytes;
  historyFloor(): Bytes;
  beginTransaction(undoGroup: bigint | undefined): void;
  commitTransaction(): LocalChange | undefined;
  abortTransaction(): void;
  replace(from: number, to: number, inserted: Utf16Units, undoGroup: bigint | undefined): LocalChange | undefined;
  insertAtAnchor(anchor: Bytes, inserted: Utf16Units, undoGroup: bigint | undefined): AnchoredInsert;
  applyUpdate(update: Bytes): ApplyReceipt;
  exportUpdate(remoteVersion: Bytes): Bytes;
  exportCompactSnapshot(): Bytes;
  exportFullSnapshot(): Bytes;
  applySnapshot(snapshot: Bytes): SnapshotReceipt;
  anchor(index: number, affinity: Affinity): Bytes;
  resolveAnchor(anchor: Bytes): number;
  captureCausalPosition(index: number, affinity: Affinity): Bytes;
  resolveCausalPosition(position: Bytes): number | undefined;
  pruneHistoryThrough(version: Bytes): number;
  canUndo(): boolean;
  canRedo(): boolean;
  undo(): LocalChange | undefined;
  redo(): LocalChange | undefined;
}
