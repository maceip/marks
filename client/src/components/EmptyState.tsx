import { ENGINE } from '../collab';
import { Icon, icons } from './Icon';

interface EmptyStateProps {
  onCreate: () => void;
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
          <button type="button" className="button primary" onClick={onCreate}>
            <Icon path={icons.plus} />
            New document
          </button>
        </div>

        <dl className="empty-engines">
          <div>
            <dt className={`engine-tag engine-${ENGINE.id}`}>{ENGINE.label}</dt>
            <dd>{ENGINE.blurb}</dd>
          </div>
        </dl>

        <button type="button" className="link-button" onClick={onOpenBenchmark}>
          <Icon path={icons.gauge} size={14} />
          Measure the engine in your browser
        </button>
      </div>
    </div>
  );
}
