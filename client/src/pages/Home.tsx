import type { DocumentMeta } from '../lib/api';
import { formatCount, formatRelativeTime } from '../lib/format';
import { ABOUT_DOCUMENT_ID, DOCUMENT_TEMPLATES, type TemplateId } from '../demo/workspace';
import { UI_PERFORMANCE_RECEIPT } from '../lib/product';
import { Icon, MarksMark, SurfaceMaterial } from '../components/ui';
import '../styles/home.css';

interface HomeProps {
  documents: DocumentMeta[];
  loading: boolean;
  workspaceKind: 'local' | 'scratch' | 'account';
  onCreate: () => void;
  onCreateFromTemplate: (templateId: TemplateId) => void;
  onOpen: (id: string) => void;
  onOpenTemplates: () => void;
  onImport: () => void;
  onOpenBenchmark: () => void;
  onOpenPreferences: () => void;
  onKeepWorkspace: () => void;
}

export function Home({
  documents,
  loading,
  workspaceKind,
  onCreate,
  onCreateFromTemplate,
  onOpen,
  onOpenTemplates,
  onImport,
  onOpenBenchmark,
  onOpenPreferences,
  onKeepWorkspace,
}: HomeProps) {
  const recent = documents.slice(0, 4);
  const temporary = workspaceKind === 'scratch';
  const local = workspaceKind === 'local';

  return (
    <div className="home-surface">
      <section className="home-hero surface-material-host">
        <SurfaceMaterial variant="hero" />
        <div className="home-hero-copy">
          <span className="home-kicker"><MarksMark size={16} /> {temporary ? 'Public anonymous page' : local ? 'Local workspace' : 'Your workspace'}</span>
          <h2>Pick up the thought.<br />The page is ready.</h2>
          <p>{temporary
            ? 'First paint has no registration form. Every page gets an opaque public URL for instant collaboration, and edits are durably committed by the service.'
            : local
              ? 'Documents, review threads, and versions stay in this browser. The same Rust/Wasm editor runs locally, with no account or remote collaboration implied.'
              : 'Your durable Marks documents are available through the Rust service, with live collaboration, role-based review, and named versions.'}</p>
          <div className="home-actions">
            <button type="button" className="button primary" onClick={onCreate}>
              <Icon name="plus" /> New document
            </button>
            <button type="button" className="button" onClick={onOpenTemplates}>
              <Icon name="template" /> Browse templates
            </button>
            <button type="button" className="button" onClick={onImport}>
              <Icon name="download" /> Import document
            </button>
            {temporary && <button type="button" className="button" onClick={onKeepWorkspace}>Log In</button>}
          </div>
        </div>
        <div className="home-receipt surface-material-host" aria-label="Performance promise">
          <SurfaceMaterial variant="floating" />
          <div className="receipt-orbit"><Icon name="sparkles" size={19} /></div>
          <span>Critical app shell</span>
          <strong>{UI_PERFORMANCE_RECEIPT.appCriticalKb}<small> KB</small></strong>
          <p>Glass at the edges. No editor, renderer, or collaboration engine until a page opens.</p>
          <button type="button" onClick={onOpenBenchmark}>Open performance receipt <Icon name="chevron" size={13} /></button>
        </div>
      </section>

      <section className="home-section" aria-labelledby="recent-title">
        <header className="home-section-head">
          <div><span>Continue</span><h3 id="recent-title">Recent documents</h3></div>
          <span>{documents.length} {local ? 'in this browser' : 'available'}</span>
        </header>
        <div className="recent-grid">
          {loading && recent.length === 0 && [0, 1, 2].map((item) => <div className="recent-card recent-skeleton" key={item} />)}
          {recent.map((document, index) => (
            <button key={document.id} type="button" className="recent-card" onClick={() => onOpen(document.id)} style={{ '--item-index': index } as React.CSSProperties}>
              <span className="recent-page" aria-hidden="true"><i /><i /><i /><i /></span>
              <span className="recent-copy">
                <strong>{document.title}</strong>
                <small>{formatCount(document.chars)} characters · {formatRelativeTime(document.updated_at)}</small>
              </span>
              <Icon name="chevron" size={14} />
            </button>
          ))}
          {!loading && recent.length === 0 && (
            <button type="button" className="recent-card recent-empty" onClick={onCreate}>
              <Icon name="plus" />
              <span><strong>Create the first page</strong><small>It will be saved in this browser.</small></span>
            </button>
          )}
        </div>
      </section>

      <section className="home-section" aria-labelledby="templates-title">
        <header className="home-section-head">
          <div><span>Start with structure</span><h3 id="templates-title">Templates</h3></div>
          <button type="button" onClick={onOpenTemplates}>See all</button>
        </header>
        <div className="home-template-grid">
          {DOCUMENT_TEMPLATES.slice(1).map((template) => (
            <button key={template.id} type="button" className={`home-template template-${template.accent}`} onClick={() => onCreateFromTemplate(template.id)}>
              <span><Icon name="document" /></span>
              <strong>{template.name}</strong>
              <small>{template.description}</small>
            </button>
          ))}
        </div>
      </section>

      <footer className="home-footer-card">
        <span><Icon name="check" size={14} /> <strong>{local ? 'Browser-local mode' : temporary ? 'Anonymous service mode' : 'Logged-in service mode'}</strong> · {local ? 'local persistence' : 'Rust persistence and ESBT collaboration'}</span>
        <div className="home-footer-actions">
          <button type="button" onClick={() => onOpen(ABOUT_DOCUMENT_ID)}>Google Docs for Markdown</button>
          <button type="button" onClick={onOpenPreferences}><Icon name="settings" size={14} /> Appearance</button>
        </div>
      </footer>
    </div>
  );
}
