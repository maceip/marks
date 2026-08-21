import type { EngineName } from '../collab/types';

export interface BenchOptions {
  /** Number of single-character edits in the trace. */
  ops: number;
  /** Edits each branch makes independently before the branches are merged. */
  branchOps: number;
  seed: number;
}

export interface BenchRow {
  engine: EngineName;
  /** Applying the trace locally, as if typed. */
  localMs: number;
  /** A second replica applying every update from the first. */
  remoteMs: number;
  /** Merging two branches that diverged for `branchOps` edits each. */
  mergeMs: number;
  /** Loading a document from its encoded snapshot. */
  loadMs: number;
  /** Encoded snapshot of the finished document. */
  snapshotBytes: number;
  /** Total bytes of incremental updates the trace produced. */
  updateBytes: number;
  chars: number;
  converged: boolean;
}

export type BenchRequest = { type: 'run'; options: BenchOptions };

export type BenchMessage =
  | { type: 'progress'; engine: EngineName; phase: string }
  | { type: 'row'; row: BenchRow }
  | { type: 'done' }
  | { type: 'error'; message: string };
