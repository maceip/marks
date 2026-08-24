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
  /** Instantiating the WIT binding from already fetched and verified core modules. */
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
  format: 3;
  createdAt: string;
  engine: 'esbt-rust-component';
  artifact: {
    componentSha256: string;
    componentBytes: number;
    wrapperSha256: string;
    wrapperBytes: number;
    coreModules: Array<{ path: string; sha256: string; bytes: number }>;
    coreModuleBytes: number;
    engineRevision: string;
    sourceSha256: string;
    sourceDirty: boolean;
    witPackage: 'esbt:document@1.0.0';
    witSha256: string;
    wireVersion: number;
    transpilerPackage: string;
    transpilerVersion: string;
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
