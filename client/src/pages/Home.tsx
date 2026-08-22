import type { DocumentMeta } from '../lib/api';
import { formatCount, formatRelativeTime } from '../lib/format';
import { ABOUT_DOCUMENT_ID, DOCUMENT_TEMPLATES, type TemplateId } from '../demo/workspace';
import { UI_PERFORMANCE_RECEIPT } from '../lib/product';
import { Icon, icons } from '../components/ui/Icon';
import { MarksMark } from '../components/ui/MarksMark';
import { SurfaceMaterial } from '../components/ui/SurfaceMaterial';
import '../styles/home.css';

interface HomeProps {
  documents: DocumentMeta[];
  loading: boolean;
  onCreate: () => void;
  onCreateFromTemplate: (templateId: TemplateId) => void;
  onOpen: (id: string) => void;
  onOpenTemplates: () => void;
  onOpenBenchmark: () => void;
  onOpenPreferences: () => void;
  onKeepWorkspace: () => void;
}

export function Home({
  documents,
  loading,
  onCreate,
  onCreateFromTemplate,
  onOpen,
  onOpenTemplates,
  onOpenBenchmark,
  onOpenPreferences,
  onKeepWorkspace,
}: HomeProps) {
  const recent = documents.slice(0, 4);

  return (
    <div className="home-surface">
      <section className="home-hero surface-material-host">
        <SurfaceMaterial variant="hero" intensity={0.92} />
        <div className="home-hero-copy">
          <span className="home-kicker"><MarksMark size={16} /> Temporary workspace</span>
          <h2>Pick up the thought.<br />The interface is already ready.</h2>
          <p>
            First paint has no registration form. This tab is a scratch workspace. Create, edit,
            preview, review, and export from a real local document model. Closing the tab before
            you keep it is unrecoverable.
          </p>
          <div className="home-actions">
            <button type="button" className="button primary" onClick={onCreate}>
              <Icon path={icons.plus} /> New document
            </button>
            <button type="button" className="button" onClick={onOpenTemplates}>
              <Icon path={icons.template} /> Browse templates
            </button>
            <button type="button" className="button" onClick={onKeepWorkspace}>
              Keep this workspace
            </button>
          </div>
        </div>
        <div className="home-receipt surface-material-host" aria-label="Performance promise">
          <SurfaceMaterial variant="floating" intensity={1.08} />
          <div className="receipt-orbit"><Icon path={icons.sparkles} size={19} /></div>
          <span>Critical app shell</span>
          <strong>{UI_PERFORMANCE_RECEIPT.appCriticalKb}<small> KB</small></strong>
          <p>Glass at the edges. No editor, renderer, or collaboration engine until a page opens.</p>
          <button type="button" onClick={onOpenBenchmark}>Open performance receipt <Icon path={icons.chevron} size={13} /></button>
        </div>
      </section>

      <section className="home-section" aria-labelledby="recent-title">
        <header className="home-section-head">
          <div><span>Continue</span><h3 id="recent-title">Recent documents</h3></div>
          <span>{documents.length} on this device</span>
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
              <Icon path={icons.chevron} size={14} />
            </button>
          ))}
          {!loading && recent.length === 0 && (
            <button type="button" className="recent-card recent-empty" onClick={onCreate}>
              <Icon path={icons.plus} />
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
              <span><Icon path={icons.document} /></span>
              <strong>{template.name}</strong>
              <small>{template.description}</small>
            </button>
          ))}
        </div>
      </section>

      <footer className="home-footer-card">
        <span><Icon path={icons.check} size={14} /> <strong>UI prototype mode</strong> · real local persistence, replaceable data adapters</span>
        <div className="home-footer-actions">
          <button type="button" onClick={() => onOpen(ABOUT_DOCUMENT_ID)}>About Marks</button>
          <button type="button" onClick={onOpenPreferences}><Icon path={icons.settings} size={14} /> Appearance</button>
        </div>
      </footer>
    </div>
  );
}
