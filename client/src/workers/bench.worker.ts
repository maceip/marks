/// <reference lib="webworker" />

import { generateTrace, type TraceOp } from '../bench/trace';
import { summarizeSamples } from '../bench/statistics';
import type {
  BenchMessage,
  BenchOptions,
  BenchReceipt,
  BenchSummary,
  BenchTiming,
  BenchTrial,
} from '../bench/types';
import {
  ESBT_COMPONENT_MANIFEST_URL,
  EsbtDocument,
  EsbtRuntime,
  MARKS_DOCUMENT_CONFIG,
  isEsbtComponentManifest,
  marksSiteToEngine,
  verifyComponentArtifact,
  type EsbtDocument as Document,
  type EsbtComponentManifest,
} from '../collab/wasm';
import { fetchWithTimeout } from '../browser/network.ts';

const BENCHMARK_ARTIFACT_TIMEOUT_MS = 20_000;

const TIMINGS: BenchTiming[] = [
  'instantiateMs',
  'localMs',
  'remoteMs',
  'snapshotMs',
  'hydrateMs',
  'mergeMs',
];

type CoreModules = Readonly<Record<string, Uint8Array<ArrayBuffer>>>;

interface ArtifactBundle {
  manifest: EsbtComponentManifest;
  coreModules: CoreModules;
}

const post = (message: BenchMessage): void => {
  (self as unknown as Worker).postMessage(message);
};

async function createDoc(runtime: EsbtRuntime, site: number): Promise<Document> {
  return EsbtDocument.create({
    runtime,
    siteId: marksSiteToEngine(site),
    config: MARKS_DOCUMENT_CONFIG,
  });
}

function applyInteractiveTrace(doc: Document, trace: readonly TraceOp[]): void {
  for (const operation of trace) {
    if (operation.insert !== undefined) doc.insert(operation.position, operation.insert);
    else if (operation.remove) doc.delete(operation.position, operation.remove);
  }
}

function applyBranch(doc: Document, operations: number, seed: number): void {
  doc.transact(() => {
    for (const operation of generateTrace(operations, seed)) {
      const length = doc.length;
      const position = Math.min(operation.position, length);
      if (operation.insert !== undefined) doc.insert(position, operation.insert);
      else if (operation.remove && position + operation.remove <= length) {
        doc.delete(position, operation.remove);
      }
    }
  });
}

async function runTrial(
  coreModules: CoreModules,
  trace: readonly TraceOp[],
  options: Pick<BenchOptions, 'branchOps' | 'seed'>,
  trial: number,
  siteBase: number,
): Promise<BenchTrial> {
  const instantiateStart = performance.now();
  const runtime = await EsbtRuntime.fromCoreModules(coreModules);
  const instantiateMs = performance.now() - instantiateStart;
  const documents: Document[] = [];

  try {
    const local = await createDoc(runtime, siteBase);
    documents.push(local);
    const updates: Uint8Array[] = [];
    let updateBytes = 0;
    const unsubscribe = local.onLocalUpdate((bytes) => {
      updates.push(bytes);
      updateBytes += bytes.byteLength;
    });

    const localStart = performance.now();
    applyInteractiveTrace(local, trace);
    const localMs = performance.now() - localStart;
    unsubscribe();

    const remote = await createDoc(runtime, siteBase + 1);
    documents.push(remote);
    const remoteStart = performance.now();
    for (const update of updates) remote.applyUpdate(update);
    const remoteMs = performance.now() - remoteStart;

    const snapshotStart = performance.now();
    const snapshot = local.exportFullSnapshot();
    const snapshotMs = performance.now() - snapshotStart;

    const hydrated = await createDoc(runtime, siteBase + 2);
    documents.push(hydrated);
    const hydrateStart = performance.now();
    hydrated.applySnapshot(snapshot);
    const hydrateMs = performance.now() - hydrateStart;

    const branchA = await createDoc(runtime, siteBase + 3);
    const branchB = await createDoc(runtime, siteBase + 4);
    documents.push(branchA, branchB);
    branchA.applySnapshot(snapshot);
    branchB.applySnapshot(snapshot);
    applyBranch(branchA, options.branchOps, options.seed + trial * 2 + 1);
    applyBranch(branchB, options.branchOps, options.seed + trial * 2 + 2);

    const forA = branchB.exportUpdate(branchA.version());
    const forB = branchA.exportUpdate(branchB.version());
    const mergeStart = performance.now();
    branchA.applyUpdate(forA);
    branchB.applyUpdate(forB);
    const mergeMs = performance.now() - mergeStart;

    const localText = local.getText();
    const converged =
      remote.getText() === localText &&
      hydrated.getText() === localText &&
      branchA.getText() === branchB.getText();

    return {
      trial,
      instantiateMs,
      localMs,
      remoteMs,
      snapshotMs,
      hydrateMs,
      mergeMs,
      snapshotBytes: snapshot.byteLength,
      updateBytes,
      mergeBytes: forA.byteLength + forB.byteLength,
      emittedUpdates: updates.length,
      chars: local.length,
      converged,
    };
  } finally {
    for (const document of documents.reverse()) document.destroy();
  }
}

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function fetchArtifactBundle(): Promise<ArtifactBundle> {
  const manifestResponse = await fetchWithTimeout(
    ESBT_COMPONENT_MANIFEST_URL,
    {},
    BENCHMARK_ARTIFACT_TIMEOUT_MS,
  );
  if (!manifestResponse.ok) {
    throw new Error(`could not load the component manifest (${manifestResponse.status})`);
  }
  const manifest: unknown = await manifestResponse.json();
  if (!isEsbtComponentManifest(manifest)) {
    throw new Error('component manifest is malformed or unsupported');
  }

  const [componentResponse, witResponse, ...moduleResponses] = await Promise.all([
    fetchWithTimeout(manifest.component.path, {}, BENCHMARK_ARTIFACT_TIMEOUT_MS),
    fetchWithTimeout('/esbt.wit', {}, BENCHMARK_ARTIFACT_TIMEOUT_MS),
    ...manifest.core_modules.map((descriptor) =>
      fetchWithTimeout(descriptor.path, {}, BENCHMARK_ARTIFACT_TIMEOUT_MS)),
  ]);
  if (!componentResponse.ok || !witResponse.ok || moduleResponses.some((response) => !response.ok)) {
    throw new Error('could not load every declared component artifact');
  }

  const [componentBuffer, witBuffer, ...moduleBuffers] = await Promise.all([
    componentResponse.arrayBuffer(),
    witResponse.arrayBuffer(),
    ...moduleResponses.map((response) => response.arrayBuffer()),
  ]);
  await verifyComponentArtifact(new Uint8Array(componentBuffer), manifest.component);
  if (await sha256(new Uint8Array(witBuffer)) !== manifest.wit_sha256) {
    throw new Error('WIT contract does not match its provenance manifest');
  }

  const coreModules: Record<string, Uint8Array<ArrayBuffer>> = {};
  await Promise.all(manifest.core_modules.map(async (descriptor, index) => {
    const bytes = new Uint8Array(moduleBuffers[index]!);
    await verifyComponentArtifact(bytes, descriptor);
    coreModules[descriptor.path.slice(descriptor.path.lastIndexOf('/') + 1)] = bytes;
  }));
  return { manifest, coreModules };
}

async function benchmark(options: BenchOptions): Promise<BenchReceipt> {
  if (
    !Number.isSafeInteger(options.ops) ||
    !Number.isSafeInteger(options.branchOps) ||
    !Number.isSafeInteger(options.trials) ||
    options.ops < 1 ||
    options.branchOps < 1 ||
    options.trials < 3 ||
    options.trials > 9
  ) {
    throw new RangeError('invalid benchmark fixture');
  }

  post({ type: 'progress', phase: 'fetching and identifying the production artifact' });
  const fetchStart = performance.now();
  const { manifest, coreModules } = await fetchArtifactBundle();
  const fetchMs = performance.now() - fetchStart;

  const trace = generateTrace(options.ops, options.seed);
  const traceSha256 = await sha256(new TextEncoder().encode(JSON.stringify(trace)));
  const warmupOps = Math.min(options.ops, 500);
  const warmupTrace = generateTrace(warmupOps, options.seed);

  post({ type: 'progress', phase: 'first compile and WIT contract validation' });
  const firstInstantiateStart = performance.now();
  const firstRuntime = await EsbtRuntime.fromCoreModules(coreModules);
  const firstCompileInstantiateMs = performance.now() - firstInstantiateStart;
  const warmupDocuments: Document[] = [];
  try {
    const warmup = await createDoc(firstRuntime, 1_000_000);
    warmupDocuments.push(warmup);
    applyInteractiveTrace(warmup, warmupTrace);
  } finally {
    for (const document of warmupDocuments) document.destroy();
  }

  const rawTrials: BenchTrial[] = [];
  for (let trial = 1; trial <= options.trials; trial += 1) {
    post({ type: 'progress', trial, phase: `recording trial ${trial} of ${options.trials}` });
    rawTrials.push(await runTrial(coreModules, trace, options, trial, 1_000_000 + trial * 16));
  }

  const timings = Object.fromEntries(
    TIMINGS.map((key) => [key, summarizeSamples(rawTrials.map((trial) => trial[key]))]),
  ) as Record<BenchTiming, BenchSummary>;
  const sizes = {
    snapshotBytes: summarizeSamples(rawTrials.map((trial) => trial.snapshotBytes)),
    updateBytes: summarizeSamples(rawTrials.map((trial) => trial.updateBytes)),
    mergeBytes: summarizeSamples(rawTrials.map((trial) => trial.mergeBytes)),
  };

  return {
    format: 3,
    createdAt: new Date().toISOString(),
    engine: 'esbt-rust-component',
    artifact: {
      componentSha256: manifest.component.sha256,
      componentBytes: manifest.component.bytes,
      wrapperSha256: manifest.wrapper.sha256,
      wrapperBytes: manifest.wrapper.bytes,
      coreModules: manifest.core_modules.map((entry) => ({ ...entry })),
      coreModuleBytes: manifest.core_modules.reduce((sum, entry) => sum + entry.bytes, 0),
      engineRevision: manifest.engine_revision,
      sourceSha256: manifest.source_sha256,
      sourceDirty: manifest.source_dirty,
      witPackage: manifest.wit_package,
      witSha256: manifest.wit_sha256,
      wireVersion: manifest.wire_version,
      transpilerPackage: manifest.transpiler_package,
      transpilerVersion: manifest.transpiler_version,
      compiler: manifest.compiler,
    },
    environment: {
      userAgent: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemoryGiB: (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
      crossOriginIsolated: self.crossOriginIsolated,
    },
    fixture: {
      ...options,
      trace: 'marks-prose-v1',
      traceSha256,
      warmupOps,
      transactionPolicy: 'one-transaction-per-interactive-edit',
    },
    fetchMs,
    firstCompileInstantiateMs,
    timings,
    sizes,
    outcome: {
      chars: rawTrials[0]?.chars ?? 0,
      emittedUpdates: rawTrials[0]?.emittedUpdates ?? 0,
      converged: rawTrials.every((trial) => trial.converged),
    },
    rawTrials,
  };
}

self.onmessage = (event: MessageEvent<{ type: 'run'; options: BenchOptions }>): void => {
  if (event.data.type !== 'run') return;
  void benchmark(event.data.options)
    .then((receipt) => {
      post({ type: 'receipt', receipt });
      post({ type: 'done' });
    })
    .catch((error: unknown) => {
      post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    });
};
