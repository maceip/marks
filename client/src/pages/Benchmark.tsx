import { useEffect, useRef, useState } from 'react';
import BenchWorker from '../workers/bench.worker?worker';
import type { BenchMessage, BenchOptions, BenchRow } from '../bench/types';
import { Icon, icons } from '../components/Icon';
import { formatBytes, formatCount, formatMs } from '../lib/format';

interface BenchmarkProps {
  onBack: () => void;
}

const SIZES = [
  { label: 'Quick', ops: 5_000, branchOps: 1_000 },
  { label: 'Standard', ops: 25_000, branchOps: 5_000 },
  { label: 'Heavy', ops: 100_000, branchOps: 20_000 },
];

const METRICS: Array<{
  key: keyof BenchRow;
  label: string;
  hint: string;
  format: (row: BenchRow) => string;
  lowerIsBetter: boolean;
}> = [
  {
    key: 'localMs',
    label: 'Type the trace',
    hint: 'Applying every edit locally, committing after each one — the path a keystroke takes.',
    format: (row) => formatMs(row.localMs),
    lowerIsBetter: true,
  },
  {
    key: 'remoteMs',
    label: 'Receive updates',
    hint: 'A second replica importing every update the first produced.',
    format: (row) => formatMs(row.remoteMs),
    lowerIsBetter: true,
  },
  {
    key: 'mergeMs',
    label: 'Merge two branches',
    hint: 'Two replicas edit offline, then exchange. Neither needs a server to reconcile; operational transform would have to transform every concurrent operation pairwise.',
    format: (row) => formatMs(row.mergeMs),
    lowerIsBetter: true,
  },
  {
    key: 'loadMs',
    label: 'Open from snapshot',
    hint: 'Cold open: decoding stored state into a usable document.',
    format: (row) => formatMs(row.loadMs),
    lowerIsBetter: true,
  },
  {
    key: 'snapshotBytes',
    label: 'Snapshot size',
    hint: 'Encoded document, including the history needed to keep merging.',
    format: (row) => formatBytes(row.snapshotBytes),
    lowerIsBetter: true,
  },
  {
    key: 'updateBytes',
    label: 'Update traffic',
    hint: 'Total bytes the trace put on the wire.',
    format: (row) => formatBytes(row.updateBytes),
    lowerIsBetter: true,
  },
];

export function Benchmark({ onBack }: BenchmarkProps) {
  const [size, setSize] = useState(SIZES[0]);
  const [rows, setRows] = useState<BenchRow[]>([]);
  const [phase, setPhase] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const workerRef = useRef<Worker | null>(null);

  useEffect(() => () => workerRef.current?.terminate(), []);

  const run = () => {
    workerRef.current?.terminate();
    setRows([]);
    setError(null);
    setPhase('starting');

    const worker = new BenchWorker();
    workerRef.current = worker;

    worker.onmessage = (event: MessageEvent<BenchMessage>) => {
      const message = event.data;
      if (message.type === 'progress') setPhase(`${message.engine}: ${message.phase}`);
      else if (message.type === 'row') setRows((current) => [...current, message.row]);
      else if (message.type === 'error') {
        setError(message.message);
        setPhase(null);
      } else if (message.type === 'done') {
        setPhase(null);
        worker.terminate();
        workerRef.current = null;
      }
    };

    const options: BenchOptions = { ops: size.ops, branchOps: size.branchOps, seed: 20260821 };
    worker.postMessage({ type: 'run', options });
  };

  const best = (metric: (typeof METRICS)[number]): number | null => {
    if (rows.length < 2) return null;
    return Math.min(...rows.map((row) => Number(row[metric.key])));
  };

  return (
    <div className="benchmark">
      <div className="benchmark-inner">
        <button type="button" className="link-button" onClick={onBack}>
          ← Back to documents
        </button>

        <h2>Engine benchmark</h2>
        <p className="benchmark-lede">
          Both engines get the same generated editing trace, in a worker, in this browser. Loro
          implements Fugue on top of an Eg-walker style event graph; Yjs implements YATA. Numbers
          are one run on your machine — not a claim about your production workload.
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
                <span>{formatCount(option.ops)} edits</span>
              </button>
            ))}
          </div>

          <button type="button" className="button primary" onClick={run} disabled={phase !== null}>
            <Icon path={icons.gauge} />
            {phase ? 'Running…' : 'Run benchmark'}
          </button>
        </div>

        {phase && <p className="benchmark-phase">{phase}</p>}
        {error && <p className="benchmark-error">{error}</p>}

        {rows.length > 0 && (
          <table className="benchmark-table">
            <thead>
              <tr>
                <th scope="col">Metric</th>
                {rows.map((row) => (
                  <th key={row.engine} scope="col">
                    <span className={`engine-tag engine-${row.engine}`}>{row.engine}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {METRICS.map((metric) => {
                const winner = best(metric);
                return (
                  <tr key={metric.key}>
                    <th scope="row" title={metric.hint}>
                      {metric.label}
                      <span className="metric-hint">{metric.hint}</span>
                    </th>
                    {rows.map((row) => (
                      <td
                        key={row.engine}
                        className={winner !== null && Number(row[metric.key]) === winner ? 'best' : ''}
                      >
                        {metric.format(row)}
                      </td>
                    ))}
                  </tr>
                );
              })}
              <tr>
                <th scope="row">
                  Converged
                  <span className="metric-hint">Both replicas and both branches agree.</span>
                </th>
                {rows.map((row) => (
                  <td key={row.engine}>
                    {row.converged ? '✓' : '✗'} · {formatCount(row.chars)} chars
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        )}

        <section className="benchmark-notes">
          <h3>What is being measured</h3>
          <ul>
            {METRICS.map((metric) => (
              <li key={metric.key}>
                <strong>{metric.label}.</strong> {metric.hint}
              </li>
            ))}
          </ul>
          <p>
            Expect the two engines to trade places. Yjs is pure JavaScript, so it applies a long
            trace of single-character edits with less per-operation overhead than a WebAssembly
            replica that crosses the JS boundary on every keystroke. Loro's advantage is in what it
            stores and ships: a smaller encoded document and a faster cold open, which is what
            actually decides how quickly a document appears when you click it.
          </p>
          <p>
            Both merge diverged branches without a server. Operational transform, by contrast, has
            to transform each concurrent operation against every other, which is why long-running
            offline branches are where it struggles.
          </p>
        </section>
      </div>
    </div>
  );
}
