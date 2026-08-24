import type { BenchSummary } from './types';

/** Deterministic summary policy used by benchmark receipts. */
export function summarizeSamples(values: readonly number[]): BenchSummary {
  if (values.length === 0 || values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new RangeError('benchmark samples must be finite non-negative numbers');
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
  const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
  return {
    median,
    p95,
    min: sorted[0],
    max: sorted.at(-1)!,
    samples: [...values],
  };
}
