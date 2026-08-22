import { ENGINE } from '../lib/product';
import { Icon, icons } from './Icon';

interface EmptyStateProps {
  onCreate: () => void;
  onOpenBenchmark: () => void;
  error?: string | null;
}

export function EmptyState({ onCreate, onOpenBenchmark, error }: EmptyStateProps) {
  return (
    <div className="empty-state">
      <div className="empty-card">
        <span className="empty-mark">
          <Icon path={icons.bolt} size={22} />
        </span>
        <p className="empty-eyebrow">Your writing space</p>
        <h2>Start with a thought.<br />Keep its momentum.</h2>
        <p>
          Create a document to write, preview, and collaborate in one fast surface. Marks keeps the
          chrome light and the document close.
        </p>

        {error && <p className="empty-error" role="alert">{error}</p>}

        <div className="empty-actions">
          <button type="button" className="button primary" onClick={onCreate}>
            <Icon path={icons.plus} />
            New document
          </button>
          <a className="button subtle" href="/welcome/">Explore marks</a>
        </div>

        <dl className="empty-engines">
          <div>
            <dt className={`engine-tag engine-${ENGINE.id}`}>{ENGINE.label}</dt>
            <dd>{ENGINE.blurb}</dd>
          </div>
        </dl>

        <button type="button" className="link-button" onClick={onOpenBenchmark}>
          <Icon path={icons.gauge} size={14} />
          See the in-browser performance receipt
        </button>
      </div>
    </div>
  );
}
