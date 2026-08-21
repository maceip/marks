/** Sequence of live items, ordered by weight. Index = UTF-16 offset. */

import { cmpWeight, type Weight, weightKey } from './weight.js';

export interface Item {
  weight: Weight;
  unit: number;
  counter: number;
}

export class DocSeq {
  private items: Item[] = [];

  get length(): number {
    return this.items.length;
  }

  at(index: number): Item | undefined {
    return this.items[index];
  }

  find(w: Weight): Item | undefined {
    const i = this.indexOfWeight(w);
    return i < 0 ? undefined : this.items[i];
  }

  has(w: Weight): boolean {
    return this.indexOfWeight(w) >= 0;
  }

  indexOfWeight(w: Weight): number {
    let lo = 0;
    let hi = this.items.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const c = cmpWeight(w, this.items[mid].weight);
      if (c === 0) return mid;
      if (c < 0) hi = mid - 1;
      else lo = mid + 1;
    }
    return -1;
  }

  insert(item: Item): boolean {
    if (this.has(item.weight)) return false;
    let lo = 0;
    let hi = this.items.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cmpWeight(item.weight, this.items[mid].weight) < 0) hi = mid;
      else lo = mid + 1;
    }
    this.items.splice(lo, 0, item);
    return true;
  }

  delete(w: Weight): Item | undefined {
    const i = this.indexOfWeight(w);
    if (i < 0) return undefined;
    const [gone] = this.items.splice(i, 1);
    return gone;
  }

  text(): string {
    return String.fromCharCode(...this.items.map((it) => it.unit));
  }

  atoms(): Item[] {
    return this.items.map((it) => ({
      weight: it.weight,
      unit: it.unit,
      counter: it.counter,
    }));
  }

  clear(): void {
    this.items = [];
  }
}

export function itemId(w: Weight, c: number): string {
  return `${weightKey(w)}#${c}`;
}
