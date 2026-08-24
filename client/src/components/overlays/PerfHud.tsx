import { formatBytes, formatCount, formatMs } from '../../lib/format';
import type { HudSnapshot } from '../../lib/hud';
import { Icon, icons } from '../ui/Icon';

interface PerfHudProps {
  snapshot: HudSnapshot;
  onClose: () => void;
  onOpenBenchmark: () => void;
}

function Row({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="hud-row" title={hint}>
      <span className="hud-label">{label}</span>
      <span className="hud-value">{value}</span>
    </div>
  );
}

export function PerfHud({ snapshot, onClose, onOpenBenchmark }: PerfHudProps) {
  const reused = snapshot.blocks > 0 ? 1 - snapshot.dirty / snapshot.blocks : 0;

  return (
    <aside className="hud" aria-label="Performance">
      <header className="hud-head">
        <h2>
          <Icon path={icons.gauge} size={14} /> Performance
        </h2>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
          <Icon path={icons.close} size={14} />
        </button>
      </header>

      <section className="hud-section">
        <h3>Edit → preview painted</h3>
        <div className="hud-metrics">
          <div className="hud-metric">
            <span className="hud-metric-value">{formatMs(snapshot.p50)}</span>
            <span className="hud-metric-label">p50</span>
          </div>
          <div className="hud-metric">
            <span className="hud-metric-value">{formatMs(snapshot.p95)}</span>
            <span className="hud-metric-label">p95</span>
          </div>
          <div className="hud-metric">
            <span className="hud-metric-value">{formatMs(snapshot.max)}</span>
            <span className="hud-metric-label">max</span>
          </div>
        </div>
        <p className="hud-note">{formatCount(snapshot.samples)} samples in this session</p>
      </section>

      <section className="hud-section">
        <h3>Last render pass</h3>
        <Row
          label="Blocks reused"
          value={`${Math.round(reused * 100)}%`}
          hint="Blocks whose DOM was left untouched because their source did not change"
        />
        <Row label="Blocks" value={`${formatCount(snapshot.dirty)} dirty / ${formatCount(snapshot.blocks)}`} />
        <Row label="DOM ops" value={formatCount(snapshot.touched)} hint="Nodes created, replaced or moved" />
        <Row
          label="Parse"
          value={`${formatMs(snapshot.parseMs)}${snapshot.parseMode ? ` · ${snapshot.parseMode}` : ''}`}
          hint="markdown-it tokenizing, in the worker. Incremental parses only dirty source blocks."
        />
        <Row label="Render" value={formatMs(snapshot.renderMs)} hint="HTML generation for dirty blocks only" />
        <Row label="Patch" value={formatMs(snapshot.patchMs)} hint="Main-thread DOM mutation" />
        <Row label="HTML shipped" value={formatBytes(snapshot.htmlBytes)} hint="Worker → main thread, this pass" />
      </section>

      <section className="hud-section">
        <h3>Document</h3>
        <Row label="Engine" value={snapshot.engine} />
        <Row label="Size" value={`${formatCount(snapshot.chars)} chars`} />
        <Row label="Snapshot" value={formatBytes(snapshot.snapshotBytes)} hint="Encoded CRDT state" />
        <Row label="Last update" value={formatBytes(snapshot.lastUpdateBytes)} hint="Canonical bytes of the last local transaction" />
        <Row label="Retained ops" value={formatCount(snapshot.retainedOperations)} hint="Journal pressure; compaction prunes after a server ack" />
        <Row label="Pending ops" value={formatCount(snapshot.pendingOperations)} hint="Causally early operations waiting on the transport" />
        <Row label="Dmax" value={formatCount(snapshot.currentDmax)} hint="Adaptive allocation bound" />
        <Row label="On this device" value={snapshot.localSaved ? 'saved' : 'writing'} hint="IndexedDB journal commit" />
        <Row label="Sent" value={formatBytes(snapshot.sent)} />
        <Row label="Received" value={formatBytes(snapshot.received)} />
      </section>

      <button type="button" className="button subtle hud-cta" onClick={onOpenBenchmark}>
        Run the engine benchmark
      </button>
    </aside>
  );
}
import '../../styles/perf-hud.css';
