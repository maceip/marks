import { useState } from 'react';
import type { DocumentMeta } from '../lib/api';
import { formatCount, formatRelativeTime } from '../lib/format';
import { Icon, icons } from './Icon';

interface SidebarProps {
  documents: DocumentMeta[];
  activeId: string | null;
  loading: boolean;
  stale?: boolean;
  onOpen: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
  onOpenBenchmark: () => void;
}

export function Sidebar({
  documents,
  activeId,
  loading,
  stale,
  onOpen,
  onCreate,
  onDelete,
  onOpenBenchmark,
}: SidebarProps) {
  const [query, setQuery] = useState('');

  const filtered = query.trim()
    ? documents.filter((doc) => doc.title.toLowerCase().includes(query.trim().toLowerCase()))
    : documents;

  return (
    <aside className="sidebar" aria-label="Documents">
      <div className="sidebar-head">
        <div className="brand">
          <Icon path={icons.bolt} size={18} />
          <span>marks</span>
        </div>

        <div className="new-doc">
          <button type="button" className="button primary" onClick={onCreate}>
            <Icon path={icons.plus} />
            New
          </button>
        </div>
      </div>

      <input
        className="search"
        type="search"
        placeholder="Filter documents"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        aria-label="Filter documents"
      />

      <div className="doc-list">
        {loading && documents.length === 0 && <p className="hint">Loading…</p>}
        {stale && documents.length > 0 && <p className="hint">Showing last known documents.</p>}
        {!loading && filtered.length === 0 && <p className="hint">No documents yet.</p>}

        {filtered.map((doc) => (
          <div
            key={doc.id}
            className={`doc-item${doc.id === activeId ? ' active' : ''}`}
            role="button"
            tabIndex={0}
            onClick={() => onOpen(doc.id)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onOpen(doc.id);
              }
            }}
          >
            <div className="doc-item-body">
              <span className="doc-title">{doc.title}</span>
              <span className="doc-meta">
                <span className={`engine-tag engine-${doc.engine}`}>{doc.engine}</span>
                {formatCount(doc.chars)} chars · {formatRelativeTime(doc.updated_at)}
              </span>
            </div>
            <button
              type="button"
              className="icon-button danger"
              aria-label={`Delete ${doc.title}`}
              title="Delete"
              onClick={(event) => {
                event.stopPropagation();
                if (confirm(`Delete “${doc.title}”? This cannot be undone.`)) onDelete(doc.id);
              }}
            >
              <Icon path={icons.trash} size={14} />
            </button>
          </div>
        ))}
      </div>

      <button type="button" className="sidebar-foot" onClick={onOpenBenchmark}>
        <Icon path={icons.gauge} />
        Benchmark the engine
      </button>
    </aside>
  );
}
