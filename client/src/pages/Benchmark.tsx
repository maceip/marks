import { useEffect, useRef, useState } from 'react';
import type { BenchMessage, BenchOptions, BenchReceipt, BenchTiming } from '../bench/types';
import { Icon, icons } from '../components/ui/Icon';
import { formatBytes, formatCount, formatMs } from '../lib/format';
import BenchWorker from '../workers/bench.worker?worker';
import '../styles/benchmark.css';

interface BenchmarkProps {
  onBack: () => void;
}

const SIZES: Array<{ label: string } & Pick<BenchOptions, 'ops' | 'branchOps' | 'trials'>> = [
  { label: 'Quick', ops: 2_000, branchOps: 500, trials: 5 },
  { label: 'Standard', ops: 10_000, branchOps: 2_000, trials: 5 },
  { label: 'Heavy', ops: 100_000, branchOps: 20_000, trials: 3 },
];

const TIMING_ROWS: Array<{
  key: BenchTiming;
  label: string;
  hint: string;
  rate: (receipt: BenchReceipt, milliseconds: number) => string;
}> = [
  {
    key: 'instantiateMs',
    label: 'Warm instantiate',
    hint: 'Instantiate the fetched artifact and validate its embedded ABI; the first compile is reported separately.',
    rate: () => '—',
  },
  {
    key: 'localMs',
    label: 'Interactive edits',
    hint: 'Apply every generated edit as its own transaction and produce its retry-safe update.',
    rate: (receipt, milliseconds) => rate(receipt.fixture.ops, milliseconds, 'edits'),
  },
  {
    key: 'remoteMs',
    label: 'Receive updates',
    hint: 'A second replica imports every emitted interactive update separately.',
    rate: (receipt, milliseconds) => rate(receipt.outcome.emittedUpdates, milliseconds, 'updates'),
  },
  {
    key: 'snapshotMs',
    label: 'Encode snapshot',
    hint: 'Encode a full recovery snapshot, including retained merge history.',
    rate: (receipt, milliseconds) => byteRate(receipt.sizes.snapshotBytes.median, milliseconds),
  },
  {
    key: 'hydrateMs',
    label: 'Hydrate snapshot',
    hint: 'Apply that snapshot to a new document in an already instantiated Wasm module.',
    rate: (receipt, milliseconds) => byteRate(receipt.sizes.snapshotBytes.median, milliseconds),
  },
  {
    key: 'mergeMs',
    label: 'Merge branches',
    hint: 'Two offline branches each make one batched trace, exchange deltas, and converge.',
    rate: (receipt, milliseconds) => rate(receipt.fixture.branchOps * 2, milliseconds, 'edits'),
  },
];

export function Benchmark({ onBack }: BenchmarkProps) {
  const [size, setSize] = useState(SIZES[0]);
  const [receipt, setReceipt] = useState<BenchReceipt | null>(null);
  const [phase, setPhase] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const workerRef = useRef<Worker | null>(null);

  useEffect(() => () => workerRef.current?.terminate(), []);

  const run = (): void => {
    workerRef.current?.terminate();
    setReceipt(null);
    setError(null);
    setPhase('Starting…');

    const worker = new BenchWorker();
    workerRef.current = worker;
    worker.onmessage = (event: MessageEvent<BenchMessage>) => {
      const message = event.data;
      if (message.type === 'progress') setPhase(message.phase);
      else if (message.type === 'receipt') setReceipt(message.receipt);
      else if (message.type === 'error') {
        setError(message.message);
        setPhase(null);
      } else if (message.type === 'done') {
        setPhase(null);
        worker.terminate();
        workerRef.current = null;
      }
    };

    worker.postMessage({
      type: 'run',
      options: { ops: size.ops, branchOps: size.branchOps, trials: size.trials, seed: 20260821 },
    });
  };

  const downloadReceipt = (): void => {
    if (!receipt) return;
    const blob = new Blob([`${JSON.stringify(receipt, null, 2)}\n`], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `marks-esbt-benchmark-${receipt.artifact.wasmSha256.slice(0, 12)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="benchmark">
      <div className="benchmark-inner">
        <button type="button" className="link-button" onClick={onBack}>
          ← Back to documents
        </button>

        <h2>Engine performance receipt</h2>
        <p className="benchmark-lede">
          This runs the production Rust/Wasm artifact in a worker. It discards one warm-up, records
          three to five fresh replicas, reports median and p95, and keeps every raw sample with the
          artifact, fixture, and browser identity. It measures ESBT only; it does not declare a
          cross-engine winner.
        </p>

        <div className="benchmark-controls">
          <div className="segmented" role="group" aria-label="Trace size">
            {SIZES.map((option) => (
              <button
                key={option.label}
                type="button"
                className={`segmented-button${size.label === option.label ? ' active' : ''}`}
                onClick={() => setSize(option)}
                disabled={phase !== null}
              >
                {option.label}
                <span>
                  {formatCount(option.ops)} edits · {option.trials} trials
                </span>
              </button>
            ))}
          </div>

          <button type="button" className="button primary" onClick={run} disabled={phase !== null}>
            <Icon path={icons.gauge} />
            {phase ? 'Running…' : 'Run and record'}
          </button>
        </div>

        {phase && <p className="benchmark-phase">{phase}</p>}
        {error && <p className="benchmark-error">{error}</p>}

        {receipt && (
          <>
            {receipt.artifact.sourceDirty && (
              <p className="benchmark-warning">
                Development artifact: its manifest records uncommitted engine source. Release
                verification rejects this receipt until the engine revision is pinned.
              </p>
            )}

            <div className="benchmark-receipt-meta">
              <span>Wasm {receipt.artifact.wasmSha256.slice(0, 12)}</span>
              <span>engine {receipt.artifact.engineRevision.slice(0, 12)}</span>
              <span>ABI v{receipt.artifact.abiVersion}</span>
              <span>seed {receipt.fixture.seed}</span>
              <span>{receipt.fixture.trials} recorded trials</span>
            </div>

            <table className="benchmark-table">
              <thead>
                <tr>
                  <th scope="col">Measured path</th>
                  <th scope="col">Median</th>
                  <th scope="col">p95</th>
                  <th scope="col">Median rate</th>
                </tr>
              </thead>
              <tbody>
                {TIMING_ROWS.map((row) => {
                  const summary = receipt.timings[row.key];
                  return (
                    <tr key={row.key}>
                      <th scope="row" title={row.hint}>
                        {row.label}
                        <span className="metric-hint">{row.hint}</span>
                      </th>
                      <td>{formatMs(summary.median)}</td>
                      <td>{formatMs(summary.p95)}</td>
                      <td>{row.rate(receipt, summary.median)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            <div className="benchmark-size-grid">
              <ReceiptValue label="First compile + instantiate" value={formatMs(receipt.firstCompileInstantiateMs)} />
              <ReceiptValue label="Artifact fetch" value={formatMs(receipt.fetchMs)} />
              <ReceiptValue label="Wasm artifact" value={formatBytes(receipt.artifact.wasmBytes)} />
              <ReceiptValue label="Full snapshot" value={formatBytes(receipt.sizes.snapshotBytes.median)} />
              <ReceiptValue label="Interactive traffic" value={formatBytes(receipt.sizes.updateBytes.median)} />
              <ReceiptValue label="Branch traffic" value={formatBytes(receipt.sizes.mergeBytes.median)} />
              <ReceiptValue label="Wasm memory after trace" value={formatBytes(receipt.sizes.wasmMemoryBytes.median)} />
              <ReceiptValue
                label="Convergence"
                value={`${receipt.outcome.converged ? 'verified' : 'FAILED'} · ${formatCount(receipt.outcome.chars)} chars`}
              />
            </div>

            <div className="benchmark-receipt-actions">
              <button type="button" className="button subtle" onClick={downloadReceipt}>
                Download JSON receipt
              </button>
              <details>
                <summary>Inspect raw samples</summary>
                <pre>{JSON.stringify(receipt.rawTrials, null, 2)}</pre>
              </details>
            </div>
          </>
        )}

        <section className="benchmark-notes">
          <h3>Interpretation boundary</h3>
          <p>
            Interactive edits are intentionally one transaction each; offline branches are
            intentionally batched. Snapshot hydration excludes network time, while artifact fetch
            and first compile are reported separately. Browser scheduling, thermal state, and
            hardware still affect the result, which is why the receipt records the environment and
            exposes samples instead of publishing a timeless number.
          </p>
          <p>
            A comparative CRDT claim requires equivalent adapters, the same trace and transaction
            policy, pinned revisions, and published raw receipts. This page does not load substitute
            engines or infer how another algorithm would perform.
          </p>
        </section>
      </div>
    </div>
  );
}

function ReceiptValue({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function rate(count: number, milliseconds: number, unit: string): string {
  if (milliseconds <= 0) return '—';
  return `${formatCount(Math.round((count * 1_000) / milliseconds))} ${unit}/s`;
}

function byteRate(bytes: number, milliseconds: number): string {
  if (milliseconds <= 0) return '—';
  return `${formatBytes((bytes * 1_000) / milliseconds)}/s`;
}
