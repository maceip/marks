import type { VersionVector as VersionVectorContract } from './api.js';
import { Reader, TAG_VV, Writer, readVersion, writeVersion } from './codec.js';
import type { SiteId } from './weight.js';

/**
 * site → max seq. This is transport bookkeeping (which ops a replica has
 * integrated), not the paper's insertion counter `c`. Encoded size grows
 * with the number of sites that ever wrote, never with document length.
 */
export class VersionVector implements VersionVectorContract {
  readonly next: Map<SiteId, number>;

  constructor(next: Map<SiteId, number> = new Map()) {
    this.next = next;
  }

  encode(): Uint8Array {
    const w = new Writer();
    w.u8(TAG_VV);
    writeVersion(w, this.next);
    return w.done();
  }

  static decode(bytes: Uint8Array): VersionVector {
    if (!bytes || bytes.length === 0) return new VersionVector();
    const r = new Reader(bytes);
    const tag = r.u8();
    if (tag !== TAG_VV) throw new Error(`esbt: not a version vector (tag ${tag})`);
    return new VersionVector(readVersion(r));
  }
}
