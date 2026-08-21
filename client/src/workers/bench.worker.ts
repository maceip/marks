/// <reference lib="webworker" />
import { LoroDoc } from 'loro-crdt';
import * as Y from 'yjs';
import { generateTrace, type TraceOp } from '../bench/trace';
import type { BenchMessage, BenchOptions, BenchRequest, BenchRow } from '../bench/types';

/**
 * Head-to-head CRDT measurements, run in the visitor's own browser.
 *
 * Both engines get the identical trace and the identical phases, in a worker
 * so a long run cannot stall the editor.
 */

const post = (message: BenchMessage) => (self as unknown as Worker).postMessage(message);

function benchLoro(trace: TraceOp[], options: BenchOptions): BenchRow {
  post({ type: 'progress', engine: 'loro', phase: 'typing the trace' });

  const local = new LoroDoc();
  const text = local.getText('markdown');
  const updates: Uint8Array[] = [];
  let updateBytes = 0;
  const unsubscribe = local.subscribeLocalUpdates((bytes) => {
    updates.push(bytes);
    updateBytes += bytes.byteLength;
  });

  const localStart = performance.now();
  for (const op of trace) {
    if (op.insert !== undefined) text.insert(op.position, op.insert);
    else if (op.remove) text.delete(op.position, op.remove);
    local.commit();
  }
  const localMs = performance.now() - localStart;
  unsubscribe();

  post({ type: 'progress', engine: 'loro', phase: 'receiving updates on a second replica' });
  const remote = new LoroDoc();
  const remoteStart = performance.now();
  for (const update of updates) remote.import(update);
  const remoteMs = performance.now() - remoteStart;

  post({ type: 'progress', engine: 'loro', phase: 'encoding a snapshot' });
  const snapshot = local.export({ mode: 'snapshot' });

  const loadStart = performance.now();
  const loaded = new LoroDoc();
  loaded.import(snapshot);
  const chars = loaded.getText('markdown').length;
  const loadMs = performance.now() - loadStart;

  post({ type: 'progress', engine: 'loro', phase: 'merging two diverged branches' });
  const branchA = new LoroDoc();
  branchA.import(snapshot);
  const branchB = new LoroDoc();
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
    engine: 'loro',
    localMs,
    remoteMs,
    mergeMs,
    loadMs,
    snapshotBytes: snapshot.byteLength,
    updateBytes,
    chars,
    converged:
      remote.getText('markdown').toString() === local.getText('markdown').toString() &&
      branchA.getText('markdown').toString() === branchB.getText('markdown').toString(),
  };
}

function applyBranch(doc: LoroDoc, ops: number, seed: number): void {
  const text = doc.getText('markdown');
  for (const op of generateTrace(ops, seed)) {
    const length = text.length;
    const position = Math.min(op.position, length);
    if (op.insert !== undefined) text.insert(position, op.insert);
    else if (op.remove && position + op.remove <= length) text.delete(position, op.remove);
  }
  doc.commit();
}

function benchYjs(trace: TraceOp[], options: BenchOptions): BenchRow {
  post({ type: 'progress', engine: 'yjs', phase: 'typing the trace' });

  const local = new Y.Doc();
  const text = local.getText('markdown');
  const updates: Uint8Array[] = [];
  let updateBytes = 0;
  const onUpdate = (update: Uint8Array) => {
    updates.push(update);
    updateBytes += update.byteLength;
  };
  local.on('update', onUpdate);

  const localStart = performance.now();
  for (const op of trace) {
    if (op.insert !== undefined) text.insert(op.position, op.insert);
    else if (op.remove) text.delete(op.position, op.remove);
  }
  const localMs = performance.now() - localStart;
  local.off('update', onUpdate);

  post({ type: 'progress', engine: 'yjs', phase: 'receiving updates on a second replica' });
  const remote = new Y.Doc();
  const remoteStart = performance.now();
  for (const update of updates) Y.applyUpdate(remote, update);
  const remoteMs = performance.now() - remoteStart;

  post({ type: 'progress', engine: 'yjs', phase: 'encoding a snapshot' });
  const snapshot = Y.encodeStateAsUpdate(local);

  const loadStart = performance.now();
  const loaded = new Y.Doc();
  Y.applyUpdate(loaded, snapshot);
  const chars = loaded.getText('markdown').length;
  const loadMs = performance.now() - loadStart;

  post({ type: 'progress', engine: 'yjs', phase: 'merging two diverged branches' });
  const branchA = new Y.Doc();
  Y.applyUpdate(branchA, snapshot);
  const branchB = new Y.Doc();
  Y.applyUpdate(branchB, snapshot);
  applyYjsBranch(branchA, options.branchOps, options.seed + 1);
  applyYjsBranch(branchB, options.branchOps, options.seed + 2);

  const aUpdate = Y.encodeStateAsUpdate(branchA, Y.encodeStateVector(branchB));
  const bUpdate = Y.encodeStateAsUpdate(branchB, Y.encodeStateVector(branchA));
  const mergeStart = performance.now();
  Y.applyUpdate(branchA, bUpdate);
  Y.applyUpdate(branchB, aUpdate);
  const mergeMs = performance.now() - mergeStart;

  return {
    engine: 'yjs',
    localMs,
    remoteMs,
    mergeMs,
    loadMs,
    snapshotBytes: snapshot.byteLength,
    updateBytes,
    chars,
    converged:
      remote.getText('markdown').toString() === local.getText('markdown').toString() &&
      branchA.getText('markdown').toString() === branchB.getText('markdown').toString(),
  };
}

function applyYjsBranch(doc: Y.Doc, ops: number, seed: number): void {
  const text = doc.getText('markdown');
  doc.transact(() => {
    for (const op of generateTrace(ops, seed)) {
      const length = text.length;
      const position = Math.min(op.position, length);
      if (op.insert !== undefined) text.insert(position, op.insert);
      else if (op.remove && position + op.remove <= length) text.delete(position, op.remove);
    }
  });
}

self.onmessage = (event: MessageEvent<BenchRequest>) => {
  if (event.data.type !== 'run') return;
  const options = event.data.options;

  try {
    const trace = generateTrace(options.ops, options.seed);
    post({ type: 'row', row: benchLoro(trace, options) });
    post({ type: 'row', row: benchYjs(trace, options) });
    post({ type: 'done' });
  } catch (error) {
    post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
