/**
 * Order-statistic red-black tree over live items, keyed by weight
 * (paper §4.1). Rank ↔ index in O(log n), which is what turns weight-ordered
 * storage into the UTF-16 index API the editor speaks.
 *
 * Port of `src/rbtree.rs` from maceip/ESBT-web, with subtree sizes maintained
 * incrementally on the delete path instead of recomputed.
 */

import { cmpWeight, type Weight, weightKey } from './weight.js';

/** One occupancy: a weight, the UTF-16 code unit it carries, and the paper's insertion counter c. */
export interface Item {
  weight: Weight;
  unit: number;
  counter: number;
}

const RED = 0;
const BLACK = 1;

interface Node {
  weight: Weight;
  unit: number;
  counter: number;
  color: number;
  left: Node;
  right: Node;
  parent: Node;
  size: number;
}

function makeNil(): Node {
  const nil = {
    weight: { f: { p: 0, q: 1 }, sn: 0, sc: [0], site: '' },
    unit: 0,
    counter: 0,
    color: BLACK,
    size: 0,
  } as Node;
  nil.left = nil;
  nil.right = nil;
  nil.parent = nil;
  return nil;
}

export class DocSeq {
  private nil = makeNil();
  private root = this.nil;

  get length(): number {
    return this.root.size;
  }

  private pull(x: Node): void {
    if (x !== this.nil) x.size = 1 + x.left.size + x.right.size;
  }

  private rotateLeft(x: Node): void {
    const y = x.right;
    x.right = y.left;
    if (y.left !== this.nil) y.left.parent = x;
    y.parent = x.parent;
    if (x.parent === this.nil) this.root = y;
    else if (x === x.parent.left) x.parent.left = y;
    else x.parent.right = y;
    y.left = x;
    x.parent = y;
    this.pull(x);
    this.pull(y);
  }

  private rotateRight(x: Node): void {
    const y = x.left;
    x.left = y.right;
    if (y.right !== this.nil) y.right.parent = x;
    y.parent = x.parent;
    if (x.parent === this.nil) this.root = y;
    else if (x === x.parent.right) x.parent.right = y;
    else x.parent.left = y;
    y.right = x;
    x.parent = y;
    this.pull(x);
    this.pull(y);
  }

  private node(w: Weight): Node {
    let x = this.root;
    while (x !== this.nil) {
      const c = cmpWeight(w, x.weight);
      if (c === 0) return x;
      x = c < 0 ? x.left : x.right;
    }
    return this.nil;
  }

  find(w: Weight): Item | undefined {
    const n = this.node(w);
    if (n === this.nil) return undefined;
    return { weight: n.weight, unit: n.unit, counter: n.counter };
  }

  has(w: Weight): boolean {
    return this.node(w) !== this.nil;
  }

  /** Index of the item with exactly this weight, or -1. */
  indexOfWeight(w: Weight): number {
    let x = this.root;
    let rank = 0;
    while (x !== this.nil) {
      const c = cmpWeight(w, x.weight);
      if (c < 0) {
        x = x.left;
      } else if (c > 0) {
        rank += x.left.size + 1;
        x = x.right;
      } else {
        return rank + x.left.size;
      }
    }
    return -1;
  }

  /** Rank of the first item whose weight is ≥ `w` (== length when all are smaller). */
  lowerBound(w: Weight): number {
    let x = this.root;
    let rank = 0;
    while (x !== this.nil) {
      if (cmpWeight(w, x.weight) <= 0) {
        x = x.left;
      } else {
        rank += x.left.size + 1;
        x = x.right;
      }
    }
    return rank;
  }

  at(index: number): Item | undefined {
    if (index < 0 || index >= this.length) return undefined;
    let x = this.root;
    for (;;) {
      const ls = x.left.size;
      if (index < ls) {
        x = x.left;
      } else if (index === ls) {
        return { weight: x.weight, unit: x.unit, counter: x.counter };
      } else {
        index -= ls + 1;
        x = x.right;
      }
    }
  }

  /** Insert an item; returns its resulting index, or -1 if the weight is already present. */
  insert(item: Item): number {
    if (this.has(item.weight)) return -1;

    const z = {
      weight: item.weight,
      unit: item.unit,
      counter: item.counter,
      color: RED,
      left: this.nil,
      right: this.nil,
      parent: this.nil,
      size: 1,
    } as Node;

    let y = this.nil;
    let x = this.root;
    let rank = 0;
    while (x !== this.nil) {
      y = x;
      x.size += 1;
      if (cmpWeight(z.weight, x.weight) < 0) {
        x = x.left;
      } else {
        rank += x.left.size + 1;
        x = x.right;
      }
    }
    z.parent = y;
    if (y === this.nil) this.root = z;
    else if (cmpWeight(z.weight, y.weight) < 0) y.left = z;
    else y.right = z;

    this.insertFix(z);
    return rank;
  }

  private insertFix(z: Node): void {
    while (z.parent.color === RED) {
      const p = z.parent;
      const g = p.parent;
      if (p === g.left) {
        const u = g.right;
        if (u.color === RED) {
          p.color = BLACK;
          u.color = BLACK;
          g.color = RED;
          z = g;
        } else {
          if (z === p.right) {
            z = p;
            this.rotateLeft(z);
          }
          z.parent.color = BLACK;
          z.parent.parent.color = RED;
          this.rotateRight(z.parent.parent);
        }
      } else {
        const u = g.left;
        if (u.color === RED) {
          p.color = BLACK;
          u.color = BLACK;
          g.color = RED;
          z = g;
        } else {
          if (z === p.left) {
            z = p;
            this.rotateRight(z);
          }
          z.parent.color = BLACK;
          z.parent.parent.color = RED;
          this.rotateLeft(z.parent.parent);
        }
      }
    }
    this.root.color = BLACK;
  }

  private transplant(u: Node, v: Node): void {
    if (u.parent === this.nil) this.root = v;
    else if (u === u.parent.left) u.parent.left = v;
    else u.parent.right = v;
    // Unconditional, CLRS-style: v may be the nil sentinel, whose parent
    // field is scratch space the delete fixup reads.
    v.parent = u.parent;
  }

  private minimum(x: Node): Node {
    while (x.left !== this.nil) x = x.left;
    return x;
  }

  /** Remove the item with this weight; returns it and the index it occupied. */
  delete(w: Weight): { item: Item; index: number } | undefined {
    const z = this.node(w);
    if (z === this.nil) return undefined;

    const index = this.indexOfWeight(w);
    const item: Item = { weight: z.weight, unit: z.unit, counter: z.counter };

    // The node physically unlinked is z itself, or its in-order successor.
    const removed = z.left === this.nil || z.right === this.nil ? z : this.minimum(z.right);
    for (let a = removed.parent; a !== this.nil; a = a.parent) a.size -= 1;

    let y = z;
    let yColor = y.color;
    let x: Node;
    if (z.left === this.nil) {
      x = z.right;
      this.transplant(z, z.right);
    } else if (z.right === this.nil) {
      x = z.left;
      this.transplant(z, z.left);
    } else {
      y = removed;
      yColor = y.color;
      x = y.right;
      if (y.parent === z) {
        x.parent = y;
      } else {
        this.transplant(y, y.right);
        y.right = z.right;
        y.right.parent = y;
      }
      this.transplant(z, y);
      y.left = z.left;
      y.left.parent = y;
      y.color = z.color;
      y.size = z.size; // z.size was already decremented by the ancestor walk
    }

    if (yColor === BLACK) this.deleteFix(x);
    this.nil.parent = this.nil;
    return { item, index };
  }

  private deleteFix(x: Node): void {
    while (x !== this.root && x.color === BLACK) {
      const p = x.parent;
      if (x === p.left) {
        let w = p.right;
        if (w.color === RED) {
          w.color = BLACK;
          p.color = RED;
          this.rotateLeft(p);
          w = p.right;
        }
        if (w.left.color === BLACK && w.right.color === BLACK) {
          w.color = RED;
          x = p;
        } else {
          if (w.right.color === BLACK) {
            w.left.color = BLACK;
            w.color = RED;
            this.rotateRight(w);
            w = p.right;
          }
          w.color = p.color;
          p.color = BLACK;
          w.right.color = BLACK;
          this.rotateLeft(p);
          x = this.root;
        }
      } else {
        let w = p.left;
        if (w.color === RED) {
          w.color = BLACK;
          p.color = RED;
          this.rotateRight(p);
          w = p.left;
        }
        if (w.right.color === BLACK && w.left.color === BLACK) {
          w.color = RED;
          x = p;
        } else {
          if (w.left.color === BLACK) {
            w.right.color = BLACK;
            w.color = RED;
            this.rotateLeft(w);
            w = p.left;
          }
          w.color = p.color;
          p.color = BLACK;
          w.left.color = BLACK;
          this.rotateRight(p);
          x = this.root;
        }
      }
    }
    x.color = BLACK;
  }

  /** In-order items. O(n); used by snapshots, not by editing. */
  atoms(): Item[] {
    const out: Item[] = [];
    const walk = (x: Node): void => {
      if (x === this.nil) return;
      walk(x.left);
      out.push({ weight: x.weight, unit: x.unit, counter: x.counter });
      walk(x.right);
    };
    walk(this.root);
    return out;
  }

  /** Visible text rebuilt from the tree. O(n); the doc keeps an incremental cache instead. */
  text(): string {
    const units = new Array<number>(this.length);
    let i = 0;
    const walk = (x: Node): void => {
      if (x === this.nil) return;
      walk(x.left);
      units[i++] = x.unit;
      walk(x.right);
    };
    walk(this.root);
    let s = '';
    const CHUNK = 8192;
    for (let start = 0; start < units.length; start += CHUNK) {
      s += String.fromCharCode(...units.slice(start, start + CHUNK));
    }
    return s;
  }

  clear(): void {
    this.root = this.nil;
  }
}

/** Map key for one occupancy (ω, c). */
export function itemId(w: Weight, c: number): string {
  return `${weightKey(w)}#${c}`;
}
