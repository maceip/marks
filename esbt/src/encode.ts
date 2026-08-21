/**
 * Payload formats: snapshot / shallow-snapshot / update.
 *
 * One byte of type tag, then a site table, then sections. A single
 * `EsbtDoc.import` accepts all three (plus an encoded version vector is its
 * own tagged payload, see `vector.ts`). Unknown tags throw — corrupt bytes
 * must never half-apply.
 */

import { Reader, TAG_SHALLOW, TAG_SNAPSHOT, TAG_UPDATE, Writer } from './codec.js';
import type { Item } from './tree.js';
import {
  type Op,
  SiteTable,
  readOp,
  readWeight,
  writeOp,
  writeWeight,
} from './ops.js';
import { weight as weightOf, type SiteId, type Weight } from './weight.js';

export interface DeletedEntry {
  weight: Weight;
  counter: number;
}

export interface MapStateEntry {
  key: string;
  /** null = tombstone: the key was deleted at this (lamport, site). */
  value: string | null;
  lamport: number;
  site: SiteId;
}

export interface SnapshotPayload {
  kind: 'snapshot' | 'shallow-snapshot';
  /** Live items in document order. */
  items: Item[];
  /** Applied deletions (empty in a shallow snapshot). */
  deleteLog: DeletedEntry[];
  /** site → max seq integrated when this snapshot was taken. */
  version: Map<SiteId, number>;
  /** site → last insertion counter c handed out by that site. */
  counters: Map<SiteId, number>;
  /** Keyed LWW register state (comments and similar document metadata). */
  mapState: MapStateEntry[];
  /** Full oplog (empty in a shallow snapshot). */
  ops: Op[];
}

export interface UpdatePayload {
  kind: 'update';
  ops: Op[];
}

export type Payload = SnapshotPayload | UpdatePayload;

function writeSiteMap(w: Writer, table: SiteTable, map: Map<SiteId, number>): void {
  const sites = [...map.keys()].sort();
  w.uint(sites.length);
  for (const site of sites) {
    w.uint(table.idOf(site));
    w.uint(map.get(site) ?? 0);
  }
}

function readSiteMap(r: Reader, sites: SiteId[]): Map<SiteId, number> {
  const count = r.uint();
  const map = new Map<SiteId, number>();
  for (let i = 0; i < count; i++) {
    const siteIdx = r.uint();
    if (siteIdx >= sites.length) throw new Error('esbt: bad site reference');
    map.set(sites[siteIdx], r.uint());
  }
  return map;
}

export function encodeSnapshot(payload: Omit<SnapshotPayload, 'kind'>, shallow: boolean): Uint8Array {
  // The site table must be complete before any section is written, so the
  // sections are staged into a second writer while the table fills.
  const table = new SiteTable();
  const body = new Writer();

  // Items arrive in document (weight) order, so consecutive sequence paths
  // share long prefixes; encoding only the divergent suffix keeps deep
  // regions from dominating the payload.
  body.uint(payload.items.length);
  let prevSc: readonly number[] = [];
  for (const item of payload.items) {
    const w = item.weight;
    body.int(w.f.p);
    body.int(w.f.q);
    body.int(w.sn);
    let shared = 0;
    const max = Math.min(prevSc.length, w.sc.length);
    while (shared < max && prevSc[shared] === w.sc[shared]) shared += 1;
    body.uint(shared);
    body.uint(w.sc.length - shared);
    for (let i = shared; i < w.sc.length; i++) body.uint(w.sc[i]);
    body.uint(table.idOf(w.site));
    prevSc = w.sc;
    body.uint(item.counter);
    body.uint(item.unit);
  }

  if (shallow) {
    body.uint(0); // delete log
  } else {
    body.uint(payload.deleteLog.length);
    for (const entry of payload.deleteLog) {
      writeWeight(body, table, entry.weight);
      body.uint(entry.counter);
    }
  }

  writeSiteMap(body, table, payload.version);
  writeSiteMap(body, table, payload.counters);

  // The LWW map is visible state, so both snapshot flavours carry it —
  // a cold open must paint comments, not only text.
  body.uint(payload.mapState.length);
  for (const entry of payload.mapState) {
    body.str(entry.key);
    body.u8(entry.value === null ? 0 : 1);
    if (entry.value !== null) body.str(entry.value);
    body.uint(entry.lamport);
    body.uint(table.idOf(entry.site));
  }

  if (shallow) {
    body.uint(0); // oplog
  } else {
    body.uint(payload.ops.length);
    for (const op of payload.ops) writeOp(body, table, op);
  }

  const out = new Writer();
  out.u8(shallow ? TAG_SHALLOW : TAG_SNAPSHOT);
  table.write(out);
  out.bytes(body.done());
  return out.done();
}

export function encodeUpdate(ops: Op[]): Uint8Array {
  const table = new SiteTable();
  const body = new Writer();
  body.uint(ops.length);
  for (const op of ops) writeOp(body, table, op);

  const out = new Writer();
  out.u8(TAG_UPDATE);
  table.write(out);
  out.bytes(body.done());
  return out.done();
}

export function decodePayload(bytes: Uint8Array): Payload {
  if (bytes.length === 0) throw new Error('esbt: empty payload');
  const outer = new Reader(bytes);
  const tag = outer.u8();

  if (tag !== TAG_SNAPSHOT && tag !== TAG_SHALLOW && tag !== TAG_UPDATE) {
    throw new Error(`esbt: unknown payload tag ${tag}`);
  }

  const sites = SiteTable.read(outer);
  const r = new Reader(outer.bytes());

  if (tag === TAG_UPDATE) {
    const opCount = r.uint();
    const ops: Op[] = [];
    for (let i = 0; i < opCount; i++) ops.push(readOp(r, sites));
    return { kind: 'update', ops };
  }

  const itemCount = r.uint();
  const items: Item[] = [];
  let prevSc: number[] = [];
  for (let i = 0; i < itemCount; i++) {
    const p = r.int();
    const q = r.int();
    const sn = r.int();
    const shared = r.uint();
    if (shared > prevSc.length) throw new Error('esbt: bad sc prefix');
    const suffixLen = r.uint();
    const sc = prevSc.slice(0, shared);
    for (let d = 0; d < suffixLen; d++) sc.push(r.uint());
    const siteIdx = r.uint();
    if (siteIdx >= sites.length) throw new Error('esbt: bad site reference');
    const w = weightOf({ p, q }, sn, sc, sites[siteIdx]);
    prevSc = sc;
    const counter = r.uint();
    const unit = r.uint();
    items.push({ weight: w, unit, counter });
  }

  const delCount = r.uint();
  const deleteLog: DeletedEntry[] = [];
  for (let i = 0; i < delCount; i++) {
    const weight = readWeight(r, sites);
    deleteLog.push({ weight, counter: r.uint() });
  }

  const version = readSiteMap(r, sites);
  const counters = readSiteMap(r, sites);

  const mapCount = r.uint();
  const mapState: MapStateEntry[] = [];
  for (let i = 0; i < mapCount; i++) {
    const key = r.str();
    const hasValue = r.u8() !== 0;
    const value = hasValue ? r.str() : null;
    const lamport = r.uint();
    const siteIdx = r.uint();
    if (siteIdx >= sites.length) throw new Error('esbt: bad site reference');
    mapState.push({ key, value, lamport, site: sites[siteIdx] });
  }

  const opCount = r.uint();
  const ops: Op[] = [];
  for (let i = 0; i < opCount; i++) ops.push(readOp(r, sites));

  return {
    kind: tag === TAG_SHALLOW ? 'shallow-snapshot' : 'snapshot',
    items,
    deleteLog,
    version,
    counters,
    mapState,
    ops,
  };
}
