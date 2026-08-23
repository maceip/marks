/// <reference lib="webworker" />
import { generateTrace, type TraceOp } from '../bench/trace';
import type { BenchMessage, BenchOptions, BenchRequest, BenchRow } from '../bench/types';
import {
  EsbtDocument,
  EsbtRuntime,
  MARKS_DOCUMENT_CONFIG,
  marksSiteToEngine,
  type EsbtDocument as Document,
} from '../collab/wasm';

/**
 * CRDT measurements, run in the visitor's own browser.
 *
 * The production Rust/Wasm engine gets a generated editing trace and the
 * phases every published CRDT benchmark measures — typing, receiving,
 * merging, cold open — in a worker so a long run cannot stall the editor.
 */

const post = (message: BenchMessage) => (self as unknown as Worker).postMessage(message);

async function createDoc(runtime: EsbtRuntime, site: string): Promise<Document> {
  return EsbtDocument.create({
    runtime,
    siteId: marksSiteToEngine(site),
    config: MARKS_DOCUMENT_CONFIG,
  });
}

async function benchEsbt(trace: TraceOp[], options: BenchOptions): Promise<BenchRow> {
  const runtime = await EsbtRuntime.load();
  post({ type: 'progress', engine: 'esbt', phase: 'typing the trace' });

  const local = await createDoc(runtime, '2');
  const updates: Uint8Array[] = [];
  let updateBytes = 0;
  const unsubscribe = local.onLocalUpdate((bytes) => {
    updates.push(bytes);
    updateBytes += bytes.byteLength;
  });

  const localStart = performance.now();
  local.transact(() => {
    for (const op of trace) {
      if (op.insert !== undefined) local.insert(op.position, op.insert);
      else if (op.remove) local.delete(op.position, op.remove);
    }
  });
  const localMs = performance.now() - localStart;
  unsubscribe();

  post({ type: 'progress', engine: 'esbt', phase: 'receiving updates on a second replica' });
  const remote = await createDoc(runtime, '3');
  const remoteStart = performance.now();
  for (const update of updates) remote.import(update);
  const remoteMs = performance.now() - remoteStart;

  post({ type: 'progress', engine: 'esbt', phase: 'encoding a snapshot' });
  const snapshot = local.exportFullSnapshot();

  const loadStart = performance.now();
  const loaded = await createDoc(runtime, '4');
  loaded.applySnapshot(snapshot);
  const chars = loaded.length;
  const loadMs = performance.now() - loadStart;

  post({ type: 'progress', engine: 'esbt', phase: 'merging two diverged branches' });
  const branchA = await createDoc(runtime, '5');
  branchA.applySnapshot(snapshot);
  const branchB = await createDoc(runtime, '6');
  branchB.applySnapshot(snapshot);
  applyBranch(branchA, options.branchOps, options.seed + 1);
  applyBranch(branchB, options.branchOps, options.seed + 2);

  const aUpdate = branchA.exportUpdate(branchB.version());
  const bUpdate = branchB.exportUpdate(branchA.version());
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
    converged: remote.getText() === local.getText() && branchA.getText() === branchB.getText(),
  };
}

function applyBranch(doc: Document, ops: number, seed: number): void {
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

  void (async () => {
    try {
      const trace = generateTrace(options.ops, options.seed);
      post({ type: 'row', row: await benchEsbt(trace, options) });
      post({ type: 'done' });
    } catch (error) {
      post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  })();
};
