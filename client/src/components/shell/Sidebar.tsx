import { Fragment, useEffect, useRef, useState } from 'react';
import type { DocumentMeta } from '../../lib/api';
import { formatCount, formatRelativeTime } from '../../lib/format';
import { Icon, icons } from '../ui/Icon';
import { MarksMark } from '../ui/MarksMark';
import { SurfaceMaterial } from '../ui/SurfaceMaterial';

interface SidebarProps {
  documents: DocumentMeta[];
  activeId: string | null;
  loading: boolean;
  stale?: boolean;
  error?: string | null;
  overlay: boolean;
  onClose: () => void;
  onOpen: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
  onOpenBenchmark: () => void;
  onOpenAbout: () => void;
}

export function Sidebar({
  documents,
  activeId,
  loading,
  stale,
  error,
  overlay,
  onClose,
  onOpen,
  onCreate,
  onDelete,
  onOpenBenchmark,
  onOpenAbout,
}: SidebarProps) {
  const [query, setQuery] = useState('');
  const panelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!overlay) return;
    const panel = panelRef.current;
    const previous = document.activeElement as HTMLElement | null;
    const selector =
      'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const focusable = () => Array.from(panel?.querySelectorAll<HTMLElement>(selector) ?? []);
    focusable()[0]?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusable();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previous?.focus();
    };
  }, [onClose, overlay]);

  const filtered = query.trim()
    ? documents.filter((doc) => doc.title.toLowerCase().includes(query.trim().toLowerCase()))
    : documents;

  return (
    <Fragment>
      {overlay && (
        <button
          type="button"
          className="sidebar-scrim"
          aria-label="Close document drawer"
          onClick={onClose}
        />
      )}
      <aside
        className={`sidebar surface-material-host${overlay ? ' sidebar-overlay' : ''}`}
        aria-label="Documents"
        aria-modal={overlay || undefined}
        role={overlay ? 'dialog' : undefined}
        ref={panelRef}
      >
        <SurfaceMaterial variant="panel" intensity={0.82} />
        <div className="sidebar-head">
          <div className="sidebar-brand-row">
            <div className="brand">
              <MarksMark size={23} />
              <span>marks</span>
            </div>
            {overlay && (
              <button
                type="button"
                className="icon-button"
                aria-label="Close documents"
                onClick={onClose}
              >
                <Icon path={icons.close} />
              </button>
            )}
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
          {stale && documents.length > 0 && (
            <p className="hint">Showing last known documents.</p>
          )}
          {error && <p className="hint sidebar-error">Document service is unavailable.</p>}
          {!loading && !error && filtered.length === 0 && (
            <p className="hint">No documents yet.</p>
          )}

          {filtered.map((doc) => (
            <div key={doc.id} className={`doc-item${doc.id === activeId ? ' active' : ''}`}>
              <button type="button" className="doc-item-body" onClick={() => onOpen(doc.id)}>
                <span className="doc-title">{doc.title}</span>
                <span className="doc-meta">
                  <span className={`engine-tag engine-${doc.engine}`}>{doc.engine}</span>
                  {formatCount(doc.chars)} chars · {formatRelativeTime(doc.updated_at)}
                </span>
              </button>
              <button
                type="button"
                className="icon-button danger"
                aria-label={`Delete ${doc.title}`}
                title="Delete"
                onClick={(event) => {
                  event.stopPropagation();
                  onDelete(doc.id);
                }}
              >
                <Icon path={icons.trash} size={14} />
              </button>
            </div>
          ))}
        </div>

        <div className="sidebar-foot">
          <button type="button" onClick={onOpenBenchmark}>
            <Icon path={icons.gauge} />
            Benchmark
          </button>
          <a href="/d/about-marks" onClick={(event) => { event.preventDefault(); onOpenAbout(); }}>
            Google Docs for Markdown
          </a>
        </div>
      </aside>
    </Fragment>
  );
}
