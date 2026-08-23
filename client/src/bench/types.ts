export interface BenchOptions {
  /** Number of generated interactive edit transactions in each trial. */
  ops: number;
  /** Edits each branch makes independently before the branches are merged. */
  branchOps: number;
  seed: number;
  /** Recorded trials after one discarded warm-up. */
  trials: number;
}

export interface BenchTrial {
  trial: number;
  /** Instantiating and ABI-checking an already fetched Wasm artifact. */
  instantiateMs: number;
  /** Applying every trace edit as its own local transaction. */
  localMs: number;
  /** A second replica applying every emitted update separately. */
  remoteMs: number;
  snapshotMs: number;
  /** Applying a full snapshot with an already instantiated module. */
  hydrateMs: number;
  mergeMs: number;
  snapshotBytes: number;
  updateBytes: number;
  mergeBytes: number;
  emittedUpdates: number;
  wasmMemoryBytes: number;
  chars: number;
  converged: boolean;
}

export type BenchTiming =
  | 'instantiateMs'
  | 'localMs'
  | 'remoteMs'
  | 'snapshotMs'
  | 'hydrateMs'
  | 'mergeMs';

export interface BenchSummary {
  median: number;
  p95: number;
  min: number;
  max: number;
  samples: number[];
}

export interface BenchReceipt {
  format: 2;
  createdAt: string;
  engine: 'esbt-rust-wasm';
  artifact: {
    wasmSha256: string;
    wasmBytes: number;
    engineRevision: string;
    sourceSha256: string;
    sourceDirty: boolean;
    abiVersion: number;
    compiler: string;
  };
  environment: {
    userAgent: string;
    hardwareConcurrency: number;
    deviceMemoryGiB?: number;
    crossOriginIsolated: boolean;
  };
  fixture: BenchOptions & {
    trace: 'marks-prose-v1';
    traceSha256: string;
    warmupOps: number;
    transactionPolicy: 'one-transaction-per-interactive-edit';
  };
  fetchMs: number;
  firstCompileInstantiateMs: number;
  timings: Record<BenchTiming, BenchSummary>;
  sizes: {
    snapshotBytes: BenchSummary;
    updateBytes: BenchSummary;
    mergeBytes: BenchSummary;
    wasmMemoryBytes: BenchSummary;
  };
  outcome: {
    chars: number;
    emittedUpdates: number;
    converged: boolean;
  };
  rawTrials: BenchTrial[];
}

export type BenchRequest = { type: 'run'; options: BenchOptions };

export type BenchMessage =
  | { type: 'progress'; trial?: number; phase: string }
  | { type: 'receipt'; receipt: BenchReceipt }
  | { type: 'done' }
  | { type: 'error'; message: string };
