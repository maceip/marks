/**
 * EsbtDoc — the sequence document (Algorithm 3 plus the editor surface the
 * marks contract names): UTF-16 index edits, origin-tagged transactions,
 * snapshot / shallow-snapshot / update export, merging import, version
 * vectors, and the internal hooks the per-peer UndoManager drives.
 *
 * Concurrency rules (paper §5–6), all enforced here:
 *   1. Insertions are always ready; they commute by weight order.
 *   2. A delete applies only once its matching insert (ω, c) is present;
 *      until then it waits in the pending queue.
 *   3. A delete for an already-deleted (ω, c) is ignored via the delete log.
 *   4. Reinsertion at a released weight uses a fresh c; c never affects order.
 *   5. Same integrated op set ⇒ identical getText(), any delivery order.
 */

import type {
  EsbtAnchor,
  EsbtConfig,
  EsbtDoc as EsbtDocContract,
  EsbtEvent,
  EsbtExportOptions,
} from './api.js';
import { decodePayload, encodeSnapshot, encodeUpdate, type SnapshotPayload } from './encode.js';
import { DeleteLog, PendingQueue, type Op, type SeqOp } from './ops.js';
import { DocSeq, type Item } from './tree.js';
import { VersionVector } from './vector.js';
import {
  Allocator,
  SENTINEL_SITE,
  isEnd,
  parseWeightKey,
  type SiteId,
  type Weight,
  weightBegin,
  weightEnd,
  weightKey,
} from './weight.js';

const DEFAULT_DMAX = 2 ** 31 - 1;
const DEFAULT_BASE = 2 ** 16;
const DEFAULT_DEPTH = 16;

function randomSiteId(): SiteId {
  // 80 bits, 20 hex chars: unique enough per document, short enough that a
  // hundred sites' version vector still fits the 4 KiB URL budget.
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    const bytes = cryptoObj.getRandomValues(new Uint8Array(10));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

type UndoHook = (ops: Op[], origin?: string) => void;

export class EsbtDoc implements EsbtDocContract {
  readonly siteId: SiteId;

  private readonly alloc: Allocator;
  private readonly seq = new DocSeq();
  private readonly deleteLog = new DeleteLog();
  private readonly pending = new PendingQueue();

  /** site → max integrated seq (the version vector). */
  private readonly vv = new Map<SiteId, number>();
  /** site → seq → op. The oplog version-vector deltas are served from. */
  private readonly log = new Map<SiteId, Map<number, Op>>();
  /** site → last insertion counter c that site handed out. */
  private readonly counters = new Map<SiteId, number>();
  /** Keyed LWW registers riding the document (comments and similar). */
  private readonly mapState = new Map<
    string,
    { value: string | null; lamport: number; site: SiteId }
  >();
  private maxLamport = 0;

  private counter = 0;
  private localSeq = 0;

  private cachedText = '';
  private textDirty = false;
  /** Bumped by every applied insert or delete; detects visible change cheaply. */
  private mutations = 0;

  private txDepth = 0;
  private txOrigin: string | undefined;
  private txOps: Op[] = [];
  private txTextChanged = false;

  private readonly listeners = new Set<(event: EsbtEvent) => void>();
  private readonly updateListeners = new Set<(update: Uint8Array) => void>();
  private undoHook: UndoHook | null = null;

  constructor(config: EsbtConfig = {}) {
    this.siteId = config.siteId ?? randomSiteId();
    if (this.siteId === SENTINEL_SITE) {
      throw new Error('esbt: the empty site id is reserved for sentinels');
    }
    this.alloc = new Allocator(
      config.dMax ?? DEFAULT_DMAX,
      config.base ?? DEFAULT_BASE,
      config.depth ?? DEFAULT_DEPTH,
    );
  }

  /* ------------------------------------------------------------ reads */

  get length(): number {
    return this.seq.length;
  }

  getText(): string {
    if (this.textDirty) {
      this.cachedText = this.seq.text();
      this.textDirty = false;
    }
    return this.cachedText;
  }

  oplogVersion(): VersionVector {
    return new VersionVector(new Map(this.vv));
  }

  /* ------------------------------------------------------- transactions */

  transact(fn: () => void, origin?: string): void {
    if (this.txDepth === 0) {
      this.txOrigin = origin;
      this.txOps = [];
      this.txTextChanged = false;
    }
    this.txDepth += 1;
    try {
      fn();
    } finally {
      this.txDepth -= 1;
      if (this.txDepth === 0) this.finishTransact();
    }
  }

  private finishTransact(): void {
    const ops = this.txOps;
    const origin = this.txOrigin;
    const textChanged = this.txTextChanged;
    this.txOps = [];
    this.txOrigin = undefined;
    this.txTextChanged = false;

    if (ops.length === 0 && !textChanged) return;

    if (ops.length > 0) {
      this.undoHook?.(ops, origin);
      // Local-first: the state is already applied; now emit the bytes.
      const update = encodeUpdate(ops);
      for (const listener of this.updateListeners) listener(update);
    }
    this.emitEvent(origin);
  }

  private emitEvent(origin: string | undefined): void {
    if (this.listeners.size === 0) return;
    const text = this.getText();
    const event: EsbtEvent = origin === undefined ? { text } : { origin, text };
    for (const listener of this.listeners) listener(event);
  }

  /* ------------------------------------------------------- local edits */

  insert(index: number, text: string): void {
    this.transact(() => this.insertNow(index, text));
  }

  delete(index: number, length: number): void {
    this.transact(() => this.deleteNow(index, length));
  }

  replaceRange(from: number, to: number, insert: string): void {
    this.transact(() => {
      const start = clamp(from, 0, this.seq.length);
      const end = clamp(to, start, this.seq.length);
      this.deleteNow(start, end - start);
      this.insertNow(start, insert);
    });
  }

  setText(text: string): void {
    this.transact(() => {
      this.deleteNow(0, this.seq.length);
      this.insertNow(0, text);
    });
  }

  private insertNow(index: number, text: string): void {
    if (text.length === 0) return;
    const start = clamp(index, 0, this.seq.length);
    for (let k = 0; k < text.length; k++) {
      this.insertUnit(start + k, text.charCodeAt(k));
    }
  }

  private insertUnit(index: number, unit: number): void {
    const left = index === 0 ? weightBegin() : this.seq.at(index - 1)!.weight;
    // A twin pinch (neighbours differing only by site, see Allocator) leaves
    // no admissible weight in the gap; widen it rightward until one exists.
    // A widened mint may coincide with a skipped item, so occupancy is
    // checked before committing. At the END sentinel the ladder advances the
    // tracker on every attempt, so this terminates.
    let rightIndex = index;
    for (let attempts = 0; attempts < 4096; attempts++) {
      const right =
        rightIndex >= this.seq.length ? weightEnd() : this.seq.at(rightIndex)!.weight;
      const w = this.alloc.createWeight(left, right, this.siteId);
      if (w && !this.seq.has(w)) {
        this.insertAtWeight(w, unit);
        return;
      }
      if (rightIndex < this.seq.length) rightIndex += 1;
    }
    throw new Error('esbt: could not allocate a weight (exhausted retries)');
  }

  private insertAtWeight(w: Weight, unit: number): Op {
    this.counter += 1;
    this.counters.set(this.siteId, this.counter);
    const op: Op = {
      kind: 'ins',
      site: this.siteId,
      seq: this.stamp(),
      weight: w,
      counter: this.counter,
      unit,
    };
    this.logAdd(op);
    this.applyIns(op);
    this.txOps.push(op);
    return op;
  }

  private deleteNow(index: number, length: number): void {
    const start = clamp(index, 0, this.seq.length);
    const count = clamp(length, 0, this.seq.length - start);
    for (let k = 0; k < count; k++) {
      const item = this.seq.at(start);
      if (!item) break;
      this.deleteItem(item);
    }
  }

  private deleteItem(item: Item): Op {
    const op: Op = {
      kind: 'del',
      site: this.siteId,
      seq: this.stamp(),
      weight: item.weight,
      counter: item.counter,
      // Kept locally (never wired) so undo can reinsert the unit.
      unit: item.unit,
    };
    this.deleteLog.add(item.weight, item.counter);
    this.logAdd(op);
    this.applyDel(item.weight);
    this.txOps.push(op);
    return op;
  }

  /* ------------------------------------------------------------ LWW map */

  /**
   * Set a key in the document's keyed last-writer-wins map. The map rides
   * the same oplog, snapshots, and version vectors as the text — marks
   * stores comment records here so they sync, work offline, and survive a
   * merge, without ever being encoded as characters in the markdown.
   */
  mapSet(key: string, value: string): void {
    this.transact(() => this.mapWrite(key, value));
  }

  /** Delete a key (a tombstone with the write's clock survives for merging). */
  mapDelete(key: string): void {
    this.transact(() => this.mapWrite(key, null));
  }

  mapGet(key: string): string | undefined {
    const entry = this.mapState.get(key);
    return entry && entry.value !== null ? entry.value : undefined;
  }

  /** Live entries, sorted by key. */
  mapEntries(): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    for (const [key, entry] of this.mapState) {
      if (entry.value !== null) out.push([key, entry.value]);
    }
    out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return out;
  }

  private mapWrite(key: string, value: string | null): void {
    this.maxLamport += 1;
    const op: Op = {
      kind: 'map',
      site: this.siteId,
      seq: this.stamp(),
      key,
      value,
      lamport: this.maxLamport,
    };
    this.logAdd(op);
    this.applyMap(key, value, op.lamport, op.site);
    this.txOps.push(op);
  }

  /** Highest (lamport, site) wins; replays and stale writes are no-ops. */
  private applyMap(key: string, value: string | null, lamport: number, site: SiteId): boolean {
    if (lamport > this.maxLamport) this.maxLamport = lamport;
    const existing = this.mapState.get(key);
    if (
      existing &&
      (existing.lamport > lamport || (existing.lamport === lamport && existing.site >= site))
    ) {
      return false;
    }
    this.mapState.set(key, { value, lamport, site });
    this.mutations += 1;
    return true;
  }

  private stamp(): number {
    this.localSeq += 1;
    this.vvNote(this.siteId, this.localSeq);
    return this.localSeq;
  }

  /* --------------------------------------------------------- application */

  private applyIns(op: SeqOp): boolean {
    if (this.deleteLog.has(op.weight, op.counter)) return false;
    const index = this.seq.insert({ weight: op.weight, unit: op.unit ?? 0, counter: op.counter });
    if (index < 0) return false;
    if (!this.textDirty) {
      this.cachedText =
        this.cachedText.slice(0, index) +
        String.fromCharCode(op.unit ?? 0) +
        this.cachedText.slice(index);
    }
    this.mutations += 1;
    this.txTextChanged = true;
    return true;
  }

  private applyDel(w: Weight): boolean {
    const removed = this.seq.delete(w);
    if (!removed) return false;
    if (!this.textDirty) {
      this.cachedText =
        this.cachedText.slice(0, removed.index) + this.cachedText.slice(removed.index + 1);
    }
    this.mutations += 1;
    this.txTextChanged = true;
    return true;
  }

  /* ------------------------------------------------------------- remote */

  /**
   * Integrate one remote op. Returns whether the visible state may have
   * changed. Duplicates — by oplog entry or by version vector — are no-ops.
   */
  private receive(op: Op): boolean {
    if (this.logHas(op.site, op.seq)) return false;
    if ((this.vv.get(op.site) ?? 0) >= op.seq) return false;

    this.logAdd(op);
    this.vvNote(op.site, op.seq);
    if (op.kind === 'ins') {
      const seen = this.counters.get(op.site) ?? 0;
      if (op.counter > seen) this.counters.set(op.site, op.counter);
    }
    // Ops that claim this replica's own site can only arrive when a stable
    // site id was rehydrated; keep the generators ahead of them.
    if (op.site === this.siteId) {
      this.localSeq = Math.max(this.localSeq, op.seq);
      if (op.kind === 'ins') this.counter = Math.max(this.counter, op.counter);
      if (op.kind === 'map') this.maxLamport = Math.max(this.maxLamport, op.lamport);
    }

    const before = this.mutations;
    this.pending.push(op);
    this.drainPending();
    return this.mutations !== before;
  }

  private drainPending(): void {
    this.pending.drain((op) => this.step(op));
  }

  /** One attempt at a buffered op. True = consumed (applied or discarded). */
  private step(op: Op): boolean {
    if (op.kind === 'map') {
      this.applyMap(op.key, op.value, op.lamport, op.site);
      return true; // LWW: always ready, stale writes are discarded
    }
    if (op.kind === 'ins') {
      this.applyIns(op);
      return true; // insertions are always ready; duplicates are discarded
    }
    // Deletes: idempotence first (Scenario 2).
    if (this.deleteLog.has(op.weight, op.counter)) return true;
    const live = this.seq.find(op.weight);
    if (live && live.counter === op.counter) {
      this.deleteLog.add(op.weight, op.counter);
      this.applyDel(op.weight);
      return true;
    }
    if (live && live.counter !== op.counter) {
      // The weight was released and reused (Scenario 3): this delete names
      // the older occupancy, which is already gone.
      this.deleteLog.add(op.weight, op.counter);
      return true;
    }
    return false; // insert not seen yet — stay buffered
  }

  /* ------------------------------------------------------ export/import */

  export(options: EsbtExportOptions): Uint8Array {
    switch (options.mode) {
      case 'snapshot':
        return encodeSnapshot(
          {
            items: this.seq.atoms(),
            deleteLog: this.deleteLog.values(),
            version: new Map(this.vv),
            counters: new Map(this.counters),
            mapState: this.mapStateEntries(),
            ops: this.allOps(),
          },
          false,
        );
      case 'shallow-snapshot':
        return encodeSnapshot(
          {
            items: this.seq.atoms(),
            deleteLog: [],
            version: new Map(this.vv),
            counters: new Map(this.counters),
            mapState: this.mapStateEntries(),
            ops: [],
          },
          true,
        );
      case 'update': {
        const from = this.versionMap(options.from);
        const ops: Op[] = [];
        for (const site of [...this.log.keys()].sort()) {
          const bySeq = this.log.get(site)!;
          const start = (from.get(site) ?? 0) + 1;
          const end = this.vv.get(site) ?? 0;
          for (let seq = start; seq <= end; seq++) {
            const op = bySeq.get(seq);
            if (op) ops.push(op);
          }
        }
        return encodeUpdate(ops);
      }
      default:
        throw new Error('esbt: unknown export mode');
    }
  }

  private versionMap(from: { encode(): Uint8Array } | undefined): Map<SiteId, number> {
    if (!from) return new Map();
    if (from instanceof VersionVector) return from.next;
    // A foreign object satisfying the interface: round-trip the encoding.
    return VersionVector.decode(from.encode()).next;
  }

  private allOps(): Op[] {
    const ops: Op[] = [];
    for (const site of [...this.log.keys()].sort()) {
      const bySeq = this.log.get(site)!;
      for (const seq of [...bySeq.keys()].sort((a, b) => a - b)) {
        ops.push(bySeq.get(seq)!);
      }
    }
    return ops;
  }

  private mapStateEntries(): Array<{
    key: string;
    value: string | null;
    lamport: number;
    site: SiteId;
  }> {
    const out = [];
    for (const [key, entry] of this.mapState) {
      out.push({ key, value: entry.value, lamport: entry.lamport, site: entry.site });
    }
    return out;
  }

  import(bytes: Uint8Array): void {
    const payload = decodePayload(bytes);
    let changed = false;

    // Splicing the cached string per op is ideal for keystrokes and
    // quadratic for bulk payloads; large imports rebuild the text once.
    const bulk = payload.kind === 'update' ? payload.ops.length : payload.items.length;
    if (bulk > 64) this.textDirty = true;

    if (payload.kind === 'update') {
      for (const op of payload.ops) {
        if (this.receive(op)) changed = true;
      }
    } else {
      changed = this.mergeSnapshot(payload);
    }

    if (changed) this.emitEvent(undefined);
  }

  /**
   * Merge — never install. Everything this replica knows that the payload
   * does not survives; everything the payload knows that this replica does
   * not is integrated.
   */
  private mergeSnapshot(payload: SnapshotPayload): boolean {
    const before = this.mutations;

    // 1. Deletions the payload has applied.
    for (const entry of payload.deleteLog) {
      if (this.deleteLog.has(entry.weight, entry.counter)) continue;
      this.deleteLog.add(entry.weight, entry.counter);
      const live = this.seq.find(entry.weight);
      if (live && live.counter === entry.counter) {
        this.applyDel(entry.weight);
      }
    }

    // 2. Live items.
    for (const item of payload.items) {
      if (this.deleteLog.has(item.weight, item.counter)) continue;
      if (this.seq.has(item.weight)) continue; // same occupancy, or ours is the newer reuse
      const index = this.seq.insert(item);
      if (index >= 0) {
        if (!this.textDirty) {
          this.cachedText =
            this.cachedText.slice(0, index) +
            String.fromCharCode(item.unit) +
            this.cachedText.slice(index);
        }
        this.mutations += 1;
      }
    }

    // 3. Clocks and the LWW map.
    for (const [site, seq] of payload.version) this.vvNote(site, seq);
    for (const [site, c] of payload.counters) {
      const seen = this.counters.get(site) ?? 0;
      if (c > seen) this.counters.set(site, c);
    }
    for (const entry of payload.mapState) {
      this.applyMap(entry.key, entry.value, entry.lamport, entry.site);
    }

    // 4. Oplog union, replaying only ops whose effect is not yet visible —
    //    a delete the exporter itself still had buffered must keep waiting
    //    here too, not get silently marked as integrated.
    for (const op of payload.ops) {
      if (this.logHas(op.site, op.seq)) continue;
      this.logAdd(op);
      const applied =
        op.kind === 'map'
          ? true // the map section above is authoritative for logged writes
          : op.kind === 'ins'
            ? this.deleteLog.has(op.weight, op.counter) || this.seq.has(op.weight)
            : this.deleteLog.has(op.weight, op.counter);
      if (!applied) this.pending.push(op);
    }

    // 5. Resume this site's generators if the payload knows about us.
    this.localSeq = Math.max(this.localSeq, this.vv.get(this.siteId) ?? 0);
    this.counter = Math.max(this.counter, this.counters.get(this.siteId) ?? 0);

    this.drainPending();
    return this.mutations !== before;
  }

  private logHas(site: SiteId, seq: number): boolean {
    return this.log.get(site)?.has(seq) ?? false;
  }

  private logAdd(op: Op): void {
    let bySeq = this.log.get(op.site);
    if (!bySeq) {
      bySeq = new Map();
      this.log.set(op.site, bySeq);
    }
    bySeq.set(op.seq, op);
  }

  private vvNote(site: SiteId, seq: number): void {
    const seen = this.vv.get(site) ?? 0;
    if (seq > seen) this.vv.set(site, seq);
  }

  /* ------------------------------------------------------ subscriptions */

  subscribe(listener: (event: EsbtEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeLocalUpdates(listener: (update: Uint8Array) => void): () => void {
    this.updateListeners.add(listener);
    return () => this.updateListeners.delete(listener);
  }

  /* ------------------------------------------------------------ anchors */

  /**
   * Weight-stable anchor for the item at `index` (the END sentinel when the
   * index is at or past the end). Anchors survive concurrent edits anywhere
   * else in the document, which UTF-16 indices do not.
   */
  indexToAnchor(index: number): EsbtAnchor {
    const at = clamp(index, 0, this.seq.length);
    if (at >= this.seq.length) return { weight: weightKey(weightEnd()), offset: 0 };
    return { weight: weightKey(this.seq.at(at)!.weight), offset: 0 };
  }

  /**
   * Current index of an anchor. A deleted anchor resolves to where its item
   * would sit today (the lower bound of its weight), so ranges collapse
   * instead of drifting.
   */
  anchorToIndex(anchor: EsbtAnchor): number {
    const w = parseWeightKey(anchor.weight);
    if (isEnd(w.f) && w.site === SENTINEL_SITE) return this.seq.length;
    const exact = this.seq.indexOfWeight(w);
    const base = exact >= 0 ? exact : this.seq.lowerBound(w);
    return clamp(base + Math.max(0, Math.floor(anchor.offset)), 0, this.seq.length);
  }

  /* ---------------------------------------------------- undo internals */

  /** @internal Wired by UndoManager; receives each local transact's ops. */
  _setUndoHook(hook: UndoHook | null): void {
    this.undoHook = hook;
  }

  /**
   * @internal Apply an undo/redo batch by generating *new* ops (paper rule:
   * reused weights get a fresh c), returning the inverse batch for the
   * opposite stack. Ops whose target a collaborator already removed are
   * skipped — undo never reverts anyone else's work.
   */
  _applyUndoOps(batch: Op[], origin: 'undo' | 'redo'): Op[] {
    const inverse: Op[] = [];
    this.transact(() => {
      for (const op of batch) {
        if (op.kind === 'map') continue; // map writes are not undoable
        if (op.kind === 'ins') {
          const live = this.seq.find(op.weight);
          if (!live || live.counter !== op.counter) continue;
          inverse.push(this.deleteItem(live));
        } else {
          if (op.unit === undefined) continue;
          if (this.seq.has(op.weight)) continue;
          if (this.deleteLog.has(op.weight, op.counter)) {
            // Reinsert the released weight under a fresh counter; document
            // order is unchanged because c does not participate in order.
            inverse.push(this.insertAtWeightReusing(op.weight, op.unit));
          }
        }
      }
    }, origin);
    return inverse;
  }

  private insertAtWeightReusing(w: Weight, unit: number): Op {
    return this.insertAtWeight(w, unit);
  }
}

function clamp(value: number, lo: number, hi: number): number {
  const v = Math.floor(value);
  if (Number.isNaN(v)) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}
