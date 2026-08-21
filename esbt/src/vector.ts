import { Reader, TAG_VV, Writer, readVersion, writeVersion } from './codec.js';
import type { SiteId } from './weight.js';

export class VersionVector {
  readonly next: Map<SiteId, number>;

  constructor(next: Map<SiteId, number> = new Map()) {
    this.next = next;
  }

  encode(): Uint8Array {
    const w = new Writer();
    w.u8(TAG_VV);
    writeVersion(w, this.next);
    return w.bytes();
  }

  static decode(bytes: Uint8Array): VersionVector {
    if (!bytes || bytes.length === 0) return new VersionVector();
    const r = new Reader(bytes);
    const tag = r.u8();
    if (tag !== TAG_VV && tag !== 0) {
      const r2 = new Reader(bytes);
      return new VersionVector(readVersion(r2));
    }
    return new VersionVector(readVersion(r));
  }
}
