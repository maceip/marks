/**
 * INS(ω, e, c) and DEL(ω, c) — paper §4.2 / §5.2 — plus the two structures
 * Algorithm 3 needs around them: the pending queue for deletes that arrived
 * before their insert, and the delete log that makes deletes idempotent and
 * lets released weights be reused under a fresh counter.
 */

import { itemId } from './tree.js';
import { Reader, Writer } from './codec.js';
import type { SiteId, Weight } from './weight.js';
import { weight } from './weight.js';

/**
 * One operation. `seq` is the origin's per-replica sequence number — the
 * thing the version vector tracks — not the paper's insertion counter `c`,
 * which lives beside the weight and is what a delete names.
 *
 * `unit` is the inserted UTF-16 code unit. On a delete it is populated only
 * for locally generated ops (the undo manager needs the removed unit to
 * reinsert it); it is never encoded on the wire for deletes.
 *
 * `map` ops carry the keyed last-writer-wins register writes that ride the
 * document (marks stores comments there). They have no causal dependencies:
 * the highest (lamport, site) write for a key wins on every replica.
 */
export interface SeqOp {
  kind: 'ins' | 'del';
  site: SiteId;
  seq: number;
  weight: Weight;
  counter: number;
  unit?: number;
}

export interface MapOp {
  kind: 'map';
  site: SiteId;
  seq: number;
  key: string;
  /** null = delete the key. */
  value: string | null;
  lamport: number;
}

export type Op = SeqOp | MapOp;

/** Deletes waiting for their matching insert (ω, c). */
export class PendingQueue {
  private ops: Op[] = [];

  get length(): number {
    return this.ops.length;
  }

  push(op: Op): void {
    this.ops.push(op);
  }

  /**
   * Repeatedly hand every buffered op to `step` until a full pass makes no
   * progress. `step` returns true when it consumed the op (applied or
   * discarded it).
   */
  drain(step: (op: Op) => boolean): void {
    let progressed = true;
    while (progressed) {
      progressed = false;
      let i = 0;
      while (i < this.ops.length) {
        if (step(this.ops[i])) {
          this.ops.splice(i, 1);
          progressed = true;
        } else {
          i += 1;
        }
      }
    }
  }

  snapshot(): Op[] {
    return [...this.ops];
  }

  clear(): void {
    this.ops = [];
  }
}

/** Applied deletions, keyed by (ω, c). Scenario 2 idempotence and reuse. */
export class DeleteLog {
  private entries = new Map<string, { weight: Weight; counter: number }>();

  has(w: Weight, c: number): boolean {
    return this.entries.has(itemId(w, c));
  }

  add(w: Weight, c: number): void {
    this.entries.set(itemId(w, c), { weight: w, counter: c });
  }

  values(): Array<{ weight: Weight; counter: number }> {
    return [...this.entries.values()];
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}

/**
 * Site ids repeat heavily inside one payload, so every payload carries a
 * site table once and ops reference sites by index.
 */
export class SiteTable {
  private readonly index = new Map<SiteId, number>();
  readonly sites: SiteId[] = [];

  idOf(site: SiteId): number {
    let id = this.index.get(site);
    if (id === undefined) {
      id = this.sites.length;
      this.sites.push(site);
      this.index.set(site, id);
    }
    return id;
  }

  write(w: Writer): void {
    w.uint(this.sites.length);
    for (const site of this.sites) w.str(site);
  }

  static read(r: Reader): SiteId[] {
    const count = r.uint();
    const sites: SiteId[] = [];
    for (let i = 0; i < count; i++) sites.push(r.str());
    return sites;
  }
}

export function writeWeight(w: Writer, table: SiteTable, value: Weight): void {
  w.int(value.f.p);
  w.int(value.f.q);
  w.int(value.sn);
  w.uint(value.sc.length);
  for (const digit of value.sc) w.uint(digit);
  w.uint(table.idOf(value.site));
}

export function readWeight(r: Reader, sites: SiteId[]): Weight {
  const p = r.int();
  const q = r.int();
  const sn = r.int();
  const scLen = r.uint();
  const sc: number[] = [];
  for (let i = 0; i < scLen; i++) sc.push(r.uint());
  const siteIdx = r.uint();
  if (siteIdx >= sites.length) throw new Error('esbt: bad site reference');
  return weight({ p, q }, sn, sc, sites[siteIdx]);
}

const OP_INS = 1;
const OP_DEL = 2;
const OP_MAP = 3;

export function writeOp(w: Writer, table: SiteTable, op: Op): void {
  if (op.kind === 'map') {
    w.u8(OP_MAP);
    w.uint(table.idOf(op.site));
    w.uint(op.seq);
    w.str(op.key);
    w.u8(op.value === null ? 0 : 1);
    if (op.value !== null) w.str(op.value);
    w.uint(op.lamport);
    return;
  }
  w.u8(op.kind === 'ins' ? OP_INS : OP_DEL);
  w.uint(table.idOf(op.site));
  w.uint(op.seq);
  writeWeight(w, table, op.weight);
  w.uint(op.counter);
  if (op.kind === 'ins') {
    // Code units, not UTF-8: an item holding one half of a surrogate pair
    // must survive the wire byte-for-byte.
    w.uint(op.unit ?? 0);
  }
}

export function readOp(r: Reader, sites: SiteId[]): Op {
  const tag = r.u8();
  if (tag !== OP_INS && tag !== OP_DEL && tag !== OP_MAP) throw new Error('esbt: unknown op tag');
  const siteIdx = r.uint();
  if (siteIdx >= sites.length) throw new Error('esbt: bad site reference');
  const site = sites[siteIdx];
  const seq = r.uint();
  if (tag === OP_MAP) {
    const key = r.str();
    const hasValue = r.u8() !== 0;
    const value = hasValue ? r.str() : null;
    const lamport = r.uint();
    return { kind: 'map', site, seq, key, value, lamport };
  }
  const w = readWeight(r, sites);
  const counter = r.uint();
  if (tag === OP_INS) {
    return { kind: 'ins', site, seq, weight: w, counter, unit: r.uint() };
  }
  return { kind: 'del', site, seq, weight: w, counter };
}
