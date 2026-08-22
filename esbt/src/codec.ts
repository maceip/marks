/**
 * Binary primitives shared by every payload the engine puts on the wire or
 * on disk. All integers are unsigned LEB128 varints (zigzag for the signed
 * fields of a weight); strings are length-prefixed UTF-8. Payloads are opaque
 * to marks — the first byte is a type tag so one `import` accepts them all.
 */

export const TAG_SNAPSHOT = 1;
export const TAG_SHALLOW = 2;
export const TAG_UPDATE = 3;
export const TAG_VV = 4;
export const TAG_EPHEMERAL = 5;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export class Writer {
  private buf = new Uint8Array(256);
  private len = 0;

  private grow(extra: number): void {
    if (this.len + extra <= this.buf.length) return;
    let next = this.buf.length * 2;
    while (next < this.len + extra) next *= 2;
    const grown = new Uint8Array(next);
    grown.set(this.buf.subarray(0, this.len));
    this.buf = grown;
  }

  u8(value: number): void {
    this.grow(1);
    this.buf[this.len++] = value & 0xff;
  }

  /** Unsigned LEB128. Values must be safe non-negative integers. */
  uint(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`esbt: cannot encode ${value} as uint`);
    }
    this.grow(10);
    while (value >= 0x80) {
      this.buf[this.len++] = (value & 0x7f) | 0x80;
      value = Math.floor(value / 128);
    }
    this.buf[this.len++] = value;
  }

  /** Zigzag-encoded signed integer. */
  int(value: number): void {
    this.uint(value < 0 ? -value * 2 - 1 : value * 2);
  }

  bytes(data: Uint8Array): void {
    this.uint(data.length);
    this.grow(data.length);
    this.buf.set(data, this.len);
    this.len += data.length;
  }

  str(value: string): void {
    this.bytes(textEncoder.encode(value));
  }

  done(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

export class Reader {
  private pos = 0;

  constructor(private readonly buf: Uint8Array) {}

  get remaining(): number {
    return this.buf.length - this.pos;
  }

  u8(): number {
    if (this.pos >= this.buf.length) throw new Error('esbt: truncated payload');
    return this.buf[this.pos++];
  }

  uint(): number {
    let value = 0;
    let shift = 1;
    for (;;) {
      const byte = this.u8();
      value += (byte & 0x7f) * shift;
      if ((byte & 0x80) === 0) break;
      shift *= 128;
      if (shift > Number.MAX_SAFE_INTEGER) throw new Error('esbt: varint overflow');
    }
    if (!Number.isSafeInteger(value)) throw new Error('esbt: varint overflow');
    return value;
  }

  int(): number {
    const raw = this.uint();
    return raw % 2 === 0 ? raw / 2 : -(raw + 1) / 2;
  }

  bytes(): Uint8Array {
    const length = this.uint();
    if (this.pos + length > this.buf.length) throw new Error('esbt: truncated payload');
    const out = this.buf.subarray(this.pos, this.pos + length);
    this.pos += length;
    return out;
  }

  str(): string {
    return textDecoder.decode(this.bytes());
  }
}

/** site → max seq map, ordered by site for a canonical encoding. */
export function writeVersion(w: Writer, next: Map<string, number>): void {
  const sites = [...next.keys()].sort();
  w.uint(sites.length);
  for (const site of sites) {
    w.str(site);
    w.uint(next.get(site) ?? 0);
  }
}

export function readVersion(r: Reader): Map<string, number> {
  const count = r.uint();
  const next = new Map<string, number>();
  for (let i = 0; i < count; i++) {
    const site = r.str();
    next.set(site, r.uint());
  }
  return next;
}
