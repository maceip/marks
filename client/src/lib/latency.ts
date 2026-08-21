/**
 * A fixed-size ring of latency samples.
 *
 * Averages hide exactly the stalls that make an editor feel bad, so the HUD
 * reports p50/p95/max over a recent window instead.
 */
export class LatencyTracker {
  private readonly samples: number[];
  private index = 0;
  private filled = 0;

  constructor(private readonly capacity = 120) {
    this.samples = new Array<number>(capacity).fill(0);
  }

  add(value: number): void {
    this.samples[this.index] = value;
    this.index = (this.index + 1) % this.capacity;
    this.filled = Math.min(this.filled + 1, this.capacity);
  }

  get count(): number {
    return this.filled;
  }

  percentile(fraction: number): number {
    if (this.filled === 0) return 0;
    const sorted = this.samples.slice(0, this.filled).sort((a, b) => a - b);
    const rank = Math.min(sorted.length - 1, Math.floor(fraction * sorted.length));
    return sorted[rank];
  }

  get p50(): number {
    return this.percentile(0.5);
  }

  get p95(): number {
    return this.percentile(0.95);
  }

  get max(): number {
    return this.filled === 0 ? 0 : Math.max(...this.samples.slice(0, this.filled));
  }

  reset(): void {
    this.index = 0;
    this.filled = 0;
  }
}
