import { ENGINES } from '../collab';
import type { EngineName } from '../collab/types';
import { Icon, icons } from './Icon';

interface EmptyStateProps {
  onCreate: (engine: EngineName) => void;
  onOpenBenchmark: () => void;
}

export function EmptyState({ onCreate, onOpenBenchmark }: EmptyStateProps) {
  return (
    <div className="empty-state">
      <div className="empty-card">
        <Icon path={icons.bolt} size={28} />
        <h2>Collaborative markdown, without the lag</h2>
        <p>
          Edits apply to a local CRDT replica first, and the preview repaints only the blocks you
          touched — so typing stays at frame rate whether the document is one page or one hundred.
        </p>

        <div className="empty-actions">
          {ENGINES.map((engine, index) => (
            <button
              key={engine.id}
              type="button"
              className={`button ${index === 0 ? 'primary' : 'subtle'}`}
              onClick={() => onCreate(engine.id)}
            >
              <Icon path={icons.plus} />
              New {engine.label} document
            </button>
          ))}
        </div>

        <dl className="empty-engines">
          {ENGINES.map((engine) => (
            <div key={engine.id}>
              <dt className={`engine-tag engine-${engine.id}`}>{engine.label}</dt>
              <dd>{engine.blurb}</dd>
            </div>
          ))}
        </dl>

        <button type="button" className="link-button" onClick={onOpenBenchmark}>
          <Icon path={icons.gauge} size={14} />
          Measure both engines in your browser
        </button>
      </div>
    </div>
  );
}
