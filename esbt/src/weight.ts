/**
 * Weight layer: Definition 1 (weight), Definition 2 (total order),
 * Algorithm 1 (NEWSEQ) and Algorithm 2 (CREATE_WEIGHT with the site Tracker,
 * Definition 4). Ported from the Rust reference implementation in
 * maceip/ESBT-web (`src/fraction.rs`, `src/weight.rs`, `src/newseq.rs`,
 * `src/allocator.rs`).
 *
 * Differences from the Rust core, required by the marks contract:
 *   - `SiteId` is an opaque string (the contract's replica id), not a u32.
 *     The final tie-break of Definition 2 uses code-unit order on that string,
 *     which is total and identical on every replica.
 *   - NEWSEQ's tie digit is derived from a stable 32-bit FNV-1a hash of the
 *     site id, standing in for the paper's numeric `siteId mod (base − 1)`.
 */

/** Replica / site identifier. Opaque, comparable, stable for the life of a doc instance. */
export type SiteId = string;

/** Site id reserved for the sentinels W_BEGIN / W_END. */
export const SENTINEL_SITE: SiteId = '';

/**
 * Stern–Brocot rational p/q. Sentinels: W_BEGIN = 0/1, W_END = 1/0.
 * Numerator and denominator stay below Dmax (Theorem 2), so plain numbers
 * hold them exactly; comparison falls back to BigInt only when a cross
 * product could leave the float53 exact-integer range.
 */
export interface Fraction {
  p: number;
  q: number;
}

export const F_BEGIN: Fraction = { p: 0, q: 1 };
export const F_END: Fraction = { p: 1, q: 0 };

export function gcd(a: number, b: number): number {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b !== 0) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a === 0 ? 1 : a;
}

export function fraction(p: number, q: number): Fraction {
  if (q === 0) return F_END;
  if (p === 0) return F_BEGIN;
  if (q < 0) {
    p = -p;
    q = -q;
  }
  const g = gcd(p, q);
  return { p: p / g, q: q / g };
}

export function isBegin(f: Fraction): boolean {
  return f.p === 0 && f.q !== 0;
}

export function isEnd(f: Fraction): boolean {
  return f.q === 0;
}

export function mediant(a: Fraction, b: Fraction): Fraction {
  return fraction(a.p + b.p, a.q + b.q);
}

/** Cross products stay exact in a float64 while both factors are below 2^26. */
const EXACT_FACTOR = 0x4000000;

/** Cross-multiply compare; 0/1 < finite < 1/0. */
export function cmpFraction(a: Fraction, b: Fraction): number {
  if (a.p === b.p && a.q === b.q) return 0;
  if (isBegin(a)) return -1;
  if (isBegin(b)) return 1;
  if (isEnd(a)) return 1;
  if (isEnd(b)) return -1;
  if (a.p < EXACT_FACTOR && a.q < EXACT_FACTOR && b.p < EXACT_FACTOR && b.q < EXACT_FACTOR) {
    const left = a.p * b.q;
    const right = b.p * a.q;
    return left < right ? -1 : left > right ? 1 : 0;
  }
  const left = BigInt(a.p) * BigInt(b.q);
  const right = BigInt(b.p) * BigInt(a.q);
  return left < right ? -1 : left > right ? 1 : 0;
}

/** W = ⟨f, sn, sc, δ⟩. Sentinels use δ = ∅ encoded as the empty site id. */
export interface Weight {
  f: Fraction;
  sn: number;
  sc: number[];
  site: SiteId;
}

export function weight(f: Fraction, sn: number, sc: number[], site: SiteId): Weight {
  return { f, sn, sc: sc.length === 0 ? [0] : sc, site };
}

export function weightBegin(): Weight {
  return weight(F_BEGIN, 0, [0], SENTINEL_SITE);
}

export function weightEnd(): Weight {
  return weight(F_END, 0, [0], SENTINEL_SITE);
}

/**
 * Definition 5. If one path is a proper prefix, the shorter precedes
 * (needed for Situation 3: [0] ≺ [0,5]).
 */
export function cmpSeqPath(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return a.length - b.length;
}

/** Definition 2: lexicographic on (f, sn, sc, site). */
export function cmpWeight(a: Weight, b: Weight): number {
  const cf = cmpFraction(a.f, b.f);
  if (cf !== 0) return cf;
  if (a.sn !== b.sn) return a.sn < b.sn ? -1 : 1;
  const cs = cmpSeqPath(a.sc, b.sc);
  if (cs !== 0) return cs;
  // Code-unit comparison: total, deterministic, locale-independent.
  return a.site < b.site ? -1 : a.site > b.site ? 1 : 0;
}

/**
 * Canonical string form of a weight: `p/q:sn:sc0.sc1…@site`.
 *
 * This is the `EsbtItemId.weight` of the contract — stable across replicas,
 * usable as a map key, and parseable (everything before the first `@` is
 * numeric, the site is the remainder, whatever characters it contains).
 */
export function weightKey(w: Weight): string {
  return `${w.f.p}/${w.f.q}:${w.sn}:${w.sc.join('.')}@${w.site}`;
}

export function parseWeightKey(key: string): Weight {
  const at = key.indexOf('@');
  if (at < 0) throw new Error(`esbt: malformed weight key ${JSON.stringify(key)}`);
  const head = key.slice(0, at);
  const site = key.slice(at + 1);
  const parts = head.split(':');
  if (parts.length !== 3) throw new Error(`esbt: malformed weight key ${JSON.stringify(key)}`);
  const [pq, snRaw, scRaw] = parts;
  const slash = pq.indexOf('/');
  if (slash < 0) throw new Error(`esbt: malformed weight key ${JSON.stringify(key)}`);
  const p = Number(pq.slice(0, slash));
  const q = Number(pq.slice(slash + 1));
  const sn = Number(snRaw);
  const sc = scRaw === '' ? [0] : scRaw.split('.').map(Number);
  if (!Number.isFinite(p) || !Number.isFinite(q) || !Number.isFinite(sn) || sc.some((d) => !Number.isFinite(d))) {
    throw new Error(`esbt: malformed weight key ${JSON.stringify(key)}`);
  }
  return weight({ p, q }, sn, sc, site);
}

/** FNV-1a over UTF-16 code units; the numeric stand-in for a string site id. */
export function siteHash(site: SiteId): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < site.length; i++) {
    h ^= site.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Algorithm 1 — NEWSEQ(left, right, base, DEPTH). */
export function newseq(
  left: readonly number[],
  right: readonly number[],
  base: number,
  maxDepth: number,
  site: SiteId,
): number[] {
  const sc: number[] = [];
  const maxD = Math.max(1, maxDepth);
  const b = Math.max(2, base);
  let depth = 0;

  for (;;) {
    const lv = depth < left.length ? left[depth] : 0;
    const rv = depth < right.length ? right[depth] : b;
    const interval = Math.max(0, rv - lv - 1);

    if (interval > 0) {
      let value = lv + Math.floor(interval / 2) + 1;
      if (value >= rv) value = rv - 1;
      sc.push(value);
      return sc;
    }

    sc.push(lv);
    depth += 1;
    if (depth >= maxD) {
      // paper: tie = 1 + (siteId mod (base − 1))
      sc.push(1 + (siteHash(site) % (b - 1)));
      return sc;
    }
  }
}

/**
 * NEWSEQ without the depth cap. The paper's tie digit is constant per site,
 * so once a region of the tree is deeper than DEPTH the capped walk returns
 * the same path for every call and the same site can never mint there twice.
 * This variant keeps walking instead; it terminates within
 * max(left.length, right.length) + 1 levels, and whenever left < right in
 * path order the result is strictly between them.
 */
export function newseqUnbounded(
  left: readonly number[],
  right: readonly number[],
  base: number,
): number[] {
  const sc: number[] = [];
  const b = Math.max(2, base);
  const limit = Math.max(left.length, right.length) + 1;

  for (let depth = 0; depth <= limit; depth++) {
    const lv = depth < left.length ? left[depth] : 0;
    const rv = depth < right.length ? right[depth] : b;
    const interval = Math.max(0, rv - lv - 1);

    if (interval > 0) {
      let value = lv + Math.floor(interval / 2) + 1;
      if (value >= rv) value = rv - 1;
      sc.push(value);
      return sc;
    }
    sc.push(lv);
  }
  return sc;
}

/** Tracker : f ↦ (snL, snR). Only fractions that have hit Dmax are tracked (Definition 4). */
export class Tracker {
  private map = new Map<string, [number, number]>();

  pair(f: Fraction): [number, number] {
    const key = `${f.p}/${f.q}`;
    let entry = this.map.get(key);
    if (!entry) {
      entry = [0, 0];
      this.map.set(key, entry);
    }
    return entry;
  }

  set(f: Fraction, snL: number, snR: number): void {
    this.map.set(`${f.p}/${f.q}`, [snL, snR]);
  }

  clear(): void {
    this.map.clear();
  }
}

/**
 * Algorithm 2 — CREATE_WEIGHT, hardened.
 *
 * Two corrections over a literal transcription of the paper (and over the
 * Rust reference), both discovered by fuzzing convergence:
 *
 * 1. The mediant applies only when it *strictly* separates the neighbours.
 *    Between two weights with equal fractions — an sn-ladder pair, or
 *    concurrent same-gap inserts — mediant(f, f) = f, which "fits" and
 *    would reproduce an existing weight (dropping the character) or land
 *    on an arbitrary side of its neighbours by the site tie-break. The
 *    paper's own Situation 3 routes this case to the sequence path.
 *
 * 2. The sn ladder derives its value from the tracker *and* the actual
 *    neighbours. The tracker resets on rehydrate and knows nothing about
 *    weights minted by other sites, so `snR + 1` alone can collide with or
 *    overshoot a live neighbour.
 *
 * Every candidate is verified strictly between the neighbours before it is
 * returned. When no weight can exist in the gap — the neighbours differ
 * only by site, a "twin pinch" — `createWeight` returns null and the
 * document widens the gap instead (see `EsbtDoc`). Fresh weights carry a
 * site-flavoured first path digit precisely so that twins require a 32-bit
 * hash collision on top of concurrency, instead of happening on every
 * concurrent same-gap insert.
 */
export class Allocator {
  readonly dmax: number;
  readonly base: number;
  readonly depth: number;
  readonly tracker = new Tracker();

  constructor(dmax: number, base: number, depth: number) {
    this.dmax = Math.max(2, dmax);
    this.base = Math.max(2, base);
    this.depth = Math.max(1, depth);
  }

  /**
   * Theorem 2: assign the mediant iff max(num, den) is within Dmax.
   *
   * Algorithm 2 line 10 is typeset with `or`, which would admit unbounded
   * denominators and contradict line 9, Lemma 1's bound, Theorem 2, and
   * Situation 1 (3/7 rejected at Dmax = 5). The formal statements win —
   * same reading as the Rust reference.
   */
  mediantFits(f: Fraction): boolean {
    return !isBegin(f) && !isEnd(f) && f.p < this.dmax && f.q < this.dmax;
  }

  /** First path digit of a fresh weight: the NEWSEQ tie for this site. */
  private siteDigit(site: SiteId): number {
    return 1 + (siteHash(site) % (this.base - 1));
  }

  createWeight(left: Weight, right: Weight, site: SiteId): Weight | null {
    const between = (w: Weight): Weight | null =>
      cmpWeight(left, w) < 0 && cmpWeight(w, right) < 0 ? w : null;

    // Fraction layer: the mediant, when it fits and strictly separates.
    const fm = mediant(left.f, right.f);
    if (this.mediantFits(fm) && cmpFraction(left.f, fm) < 0 && cmpFraction(fm, right.f) < 0) {
      const w = between(weight(fm, 0, [this.siteDigit(site)], site));
      if (w) return w;
    }

    // Fallback fraction. Sentinel 0/1 → use the right.
    const fb = isBegin(left.f) ? right.f : left.f;
    const [snL, snR] = this.tracker.pair(fb);
    const fbVsRight = cmpFraction(fb, right.f);
    const leftAtFb = cmpFraction(left.f, fb) === 0 && !isBegin(left.f);

    // Right allocation: one step up the ladder, above the left neighbour.
    {
      const sn = Math.max(snR, leftAtFb ? left.sn : snR) + 1;
      if (fbVsRight < 0 || (fbVsRight === 0 && sn < right.sn)) {
        const w = between(weight(fb, sn, [...left.sc], site));
        if (w) {
          this.tracker.set(fb, snL, sn);
          return w;
        }
      }
    }

    // Left allocation: one step down the ladder, below the right neighbour.
    if (fbVsRight === 0) {
      const sn = Math.min(snL, right.sn) - 1;
      if (!leftAtFb || sn > left.sn) {
        const w = between(weight(fb, sn, [...left.sc], site));
        if (w) {
          this.tracker.set(fb, sn, snR);
          return w;
        }
      }
    }

    // Interior of a ladder: an integer strictly between the neighbours' sn.
    if (leftAtFb && fbVsRight === 0 && right.sn - left.sn > 1) {
      const sn = left.sn + Math.floor((right.sn - left.sn) / 2);
      const w = between(weight(fb, sn, [this.siteDigit(site)], site));
      if (w) return w;
    }

    // Sequence path (Situation 3): same fraction, no sn room — split by sc.
    {
      const sc = newseq(left.sc, right.sc, this.base, this.depth, site);
      const w = between(weight(fb, left.sn, sc, site));
      if (w) return w;
    }

    // Depth exhaustion: past DEPTH the capped walk's constant tie digit can
    // reproduce a path this site already minted. Walk without the cap; that
    // succeeds whenever the neighbours' paths differ at all.
    {
      const sc = newseqUnbounded(left.sc, right.sc, this.base);
      const w = between(weight(fb, left.sn, sc, site));
      if (w) return w;
    }

    // Twin pinch: the neighbours differ only by site. The single admissible
    // weight is their (f, sn, sc) with a site sorting between theirs.
    {
      const w = between(weight(fb, left.sn, [...left.sc], site));
      if (w) return w;
    }

    return null;
  }
}
