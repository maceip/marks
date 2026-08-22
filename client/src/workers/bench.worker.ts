/// <reference lib="webworker" />
import { EsbtDoc } from '@marks/esbt';
import { generateTrace, type TraceOp } from '../bench/trace';
import type { BenchMessage, BenchOptions, BenchRequest, BenchRow } from '../bench/types';

/**
 * CRDT measurements, run in the visitor's own browser.
 *
 * The engine gets a generated editing trace and the phases every published
 * CRDT benchmark measures — typing, receiving, merging, cold open — in a
 * worker so a long run cannot stall the editor.
 */

const post = (message: BenchMessage) => (self as unknown as Worker).postMessage(message);

function benchEsbt(trace: TraceOp[], options: BenchOptions): BenchRow {
  post({ type: 'progress', engine: 'esbt', phase: 'typing the trace' });

  const local = new EsbtDoc({ siteId: 'bench-local' });
  const updates: Uint8Array[] = [];
  let updateBytes = 0;
  const unsubscribe = local.subscribeLocalUpdates((bytes) => {
    updates.push(bytes);
    updateBytes += bytes.byteLength;
  });

  const localStart = performance.now();
  for (const op of trace) {
    if (op.insert !== undefined) local.insert(op.position, op.insert);
    else if (op.remove) local.delete(op.position, op.remove);
  }
  const localMs = performance.now() - localStart;
  unsubscribe();

  post({ type: 'progress', engine: 'esbt', phase: 'receiving updates on a second replica' });
  const remote = new EsbtDoc({ siteId: 'bench-remote' });
  const remoteStart = performance.now();
  for (const update of updates) remote.import(update);
  const remoteMs = performance.now() - remoteStart;

  post({ type: 'progress', engine: 'esbt', phase: 'encoding a snapshot' });
  const snapshot = local.export({ mode: 'snapshot' });

  const loadStart = performance.now();
  const loaded = new EsbtDoc({ siteId: 'bench-loaded' });
  loaded.import(snapshot);
  const chars = loaded.length;
  const loadMs = performance.now() - loadStart;

  post({ type: 'progress', engine: 'esbt', phase: 'merging two diverged branches' });
  const branchA = new EsbtDoc({ siteId: 'bench-branch-a' });
  branchA.import(snapshot);
  const branchB = new EsbtDoc({ siteId: 'bench-branch-b' });
  branchB.import(snapshot);
  applyBranch(branchA, options.branchOps, options.seed + 1);
  applyBranch(branchB, options.branchOps, options.seed + 2);

  const aUpdate = branchA.export({ mode: 'update', from: branchB.oplogVersion() });
  const bUpdate = branchB.export({ mode: 'update', from: branchA.oplogVersion() });
  const mergeStart = performance.now();
  branchA.import(bUpdate);
  branchB.import(aUpdate);
  const mergeMs = performance.now() - mergeStart;

  return {
    engine: 'esbt',
    localMs,
    remoteMs,
    mergeMs,
    loadMs,
    snapshotBytes: snapshot.byteLength,
    updateBytes,
    chars,
    converged:
      remote.getText() === local.getText() && branchA.getText() === branchB.getText(),
  };
}

function applyBranch(doc: EsbtDoc, ops: number, seed: number): void {
  doc.transact(() => {
    for (const op of generateTrace(ops, seed)) {
      const length = doc.length;
      const position = Math.min(op.position, length);
      if (op.insert !== undefined) doc.insert(position, op.insert);
      else if (op.remove && position + op.remove <= length) doc.delete(position, op.remove);
    }
  });
}

self.onmessage = (event: MessageEvent<BenchRequest>) => {
  if (event.data.type !== 'run') return;
  const options = event.data.options;

  try {
    const trace = generateTrace(options.ops, options.seed);
    post({ type: 'row', row: benchEsbt(trace, options) });
    post({ type: 'done' });
  } catch (error) {
    post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
