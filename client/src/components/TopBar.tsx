import type { EditorView } from '@codemirror/view';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { ConnectionStatus, Peer } from '../collab/types';
import type { UiActionId } from '../lib/ui-actions';
import { Icon, icons } from './Icon';
import { MarksMark } from './MarksMark';
import { PresenceBar } from './PresenceBar';
import { SurfaceMaterial } from './SurfaceMaterial';

export type ViewMode = 'edit' | 'split' | 'preview';
export type SurfaceRoute = 'home' | 'document' | 'benchmark';
type RibbonTab = 'file' | 'home' | 'insert' | 'review' | 'view';

const RibbonToolbar = lazy(() =>
  import('./Toolbar').then((module) => ({ default: module.Toolbar })),
);

interface TopBarProps {
  title: string;
  docId: string | null;
  route: SurfaceRoute;
  documentReady: boolean;
  documentAvailable: boolean;
  phone: boolean;
  getView: () => EditorView | null;
  status: ConnectionStatus;
  peers: Peer[];
  mode: ViewMode;
  theme: 'light' | 'dark';
  sidebarOpen: boolean;
  hudOpen: boolean;
  outlineOpen: boolean;
  reviewOpen?: 'comments' | 'history' | null;
  localMode?: boolean;
  focusMode?: boolean;
  ribbonCollapsed?: boolean;
  onModeChange: (mode: ViewMode) => void;
  onToggleSidebar: () => void;
  onToggleTheme: () => void;
  onToggleHud: () => void;
  onToggleOutline: () => void;
  onToggleRibbon: () => void;
  onAction: (action: UiActionId) => void;
  onVoice?: () => void;
  voiceActive?: boolean;
  voiceSupported?: boolean;
}

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  connecting: 'Opening',
  connected: 'Saved',
  offline: 'Offline',
};

const MODES: Array<{ id: ViewMode; label: string; icon: keyof typeof icons }> = [
  { id: 'edit', label: 'Editor', icon: 'pencil' },
  { id: 'split', label: 'Split', icon: 'split' },
  { id: 'preview', label: 'Preview', icon: 'eye' },
];

const TABS: Array<{ id: RibbonTab; label: string }> = [
  { id: 'file', label: 'File' },
  { id: 'home', label: 'Home' },
  { id: 'insert', label: 'Insert' },
  { id: 'review', label: 'Review' },
  { id: 'view', label: 'View' },
];

export function TopBar(props: TopBarProps) {
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const [activeTab, setActiveTab] = useState<RibbonTab>(() =>
    props.mode === 'preview' ? 'view' : 'home',
  );

  useEffect(() => {
    if (!moreOpen) return;
    const close = (event: PointerEvent) => {
      if (!moreRef.current?.contains(event.target as Node)) setMoreOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMoreOpen(false);
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [moreOpen]);

  const documentRoute = props.route === 'document';
  const visibleModes = props.phone ? MODES.filter((mode) => mode.id !== 'split') : MODES;

  return (
    <header className={`app-ribbon ribbon-${props.route} surface-material-host`}>
      <SurfaceMaterial variant="chrome" intensity={0.96} />
      <div className="titlebar">
        <div className="topbar-left">
          <button
            type="button"
            className="icon-button"
            aria-label={props.sidebarOpen ? 'Hide documents' : 'Show documents'}
            aria-pressed={props.sidebarOpen}
            title="Toggle document list"
            onClick={props.onToggleSidebar}
          >
            <Icon path={icons.sidebar} />
          </button>

          <span className="product-mark" aria-hidden="true">
            <MarksMark size={24} />
          </span>

          {documentRoute ? (
            <button type="button" className="doc-heading doc-heading-button" title="Rename document" onClick={() => props.onAction('rename')}>
              {props.title}
            </button>
          ) : (
            <h1 className="doc-heading" title={props.title}>{props.title}</h1>
          )}

          {documentRoute && props.documentAvailable && (
            <span
              className={`status status-${props.status}`}
              title={
                props.status === 'offline'
                  ? 'Offline — edits remain available locally'
                  : STATUS_LABEL[props.status]
              }
            >
              <span className="status-dot" />
              {props.localMode ? 'On this device' : STATUS_LABEL[props.status]}
            </span>
          )}
        </div>

          <div className="topbar-right">
          {props.focusMode && (
            <button type="button" className="focus-exit" onClick={() => props.onAction('focus')}>
              <Icon path={icons.focus} size={14} /> Exit focus
            </button>
          )}
          {documentRoute && props.documentAvailable && <PresenceBar peers={props.peers} />}

          {documentRoute && props.documentAvailable && (
            <button
              type="button"
              className="titlebar-action"
              aria-label="Share document"
              title="Share document"
              onClick={() => props.onAction('share')}
            >
              <Icon path={icons.share} />
              <span>Share</span>
            </button>
          )}

          {props.docId && props.documentAvailable && (
            <button
              type="button"
              className="icon-button titlebar-download"
              aria-label="Download markdown"
              title="Download .md"
              onClick={() => props.onAction('download')}
            >
              <Icon path={icons.download} />
            </button>
          )}

          <button type="button" className="icon-button titlebar-search" aria-label="Open command palette" title="Command palette (⌘⇧P)" onClick={() => props.onAction('command-palette')}>
            <Icon path={icons.search} />
          </button>

          <button
            type="button"
            className="icon-button titlebar-theme"
            aria-label={props.theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            title="Toggle theme"
            onClick={props.onToggleTheme}
          >
            <Icon path={props.theme === 'dark' ? icons.sun : icons.moon} />
          </button>

          {documentRoute && !props.phone && !props.focusMode && (
            <button
              type="button"
              className={`icon-button ribbon-collapse${props.ribbonCollapsed ? ' collapsed' : ''}`}
              aria-label={props.ribbonCollapsed ? 'Expand command ribbon' : 'Collapse command ribbon'}
              aria-pressed={props.ribbonCollapsed}
              title={`${props.ribbonCollapsed ? 'Expand' : 'Collapse'} ribbon (⌃F1)`}
              onClick={props.onToggleRibbon}
            >
              <Icon path={icons.chevron} />
            </button>
          )}

          <div className="titlebar-menu" ref={moreRef}>
            <button type="button" className="icon-button" aria-label="More actions" aria-haspopup="menu" aria-expanded={moreOpen} onClick={() => setMoreOpen((open) => !open)}>
              <Icon path={icons.more} />
            </button>
            {moreOpen && (
              <div className="popover-menu" role="menu">
                <button type="button" role="menuitem" onClick={() => { setMoreOpen(false); props.onAction('preferences'); }}><Icon path={icons.settings} /> Appearance</button>
                <button type="button" role="menuitem" onClick={() => { setMoreOpen(false); props.onAction('benchmark'); }}><Icon path={icons.gauge} /> Performance</button>
                <button type="button" role="menuitem" onClick={() => { setMoreOpen(false); props.onAction('about'); }}><Icon path={icons.bolt} /> About marks</button>
              </div>
            )}
          </div>
        </div>
      </div>

      {documentRoute && (
        <div className="ribbon-body">
          <nav className="ribbon-tabs" aria-label="Command ribbon" onDoubleClick={props.onToggleRibbon}>
            {TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={`ribbon-tab${activeTab === tab.id ? ' active' : ''}`}
                aria-pressed={activeTab === tab.id}
                onClick={() => setActiveTab(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </nav>

          <div className="ribbon-deck">
            {activeTab === 'file' && (
              <div className="ribbon-toolbar ribbon-deck-enter" role="toolbar" aria-label="File commands">
                <div className="ribbon-command-group">
                  <div className="ribbon-command-row">
                    <button type="button" className="ribbon-command" onClick={() => props.onAction('new')}><Icon path={icons.plus} /><span className="ribbon-command-label">New</span></button>
                    <button type="button" className="ribbon-command" onClick={() => props.onAction('templates')}><Icon path={icons.template} /><span className="ribbon-command-label">Template</span></button>
                  </div>
                  <span className="ribbon-group-label">Create</span>
                </div>
                <div className="ribbon-command-group">
                  <div className="ribbon-command-row">
                    <button type="button" className="ribbon-command" disabled={!props.documentReady} onClick={() => props.onAction('rename')}><Icon path={icons.pencil} /><span className="ribbon-command-label">Rename</span></button>
                    <button type="button" className="ribbon-command" disabled={!props.documentReady} onClick={() => props.onAction('duplicate')}><Icon path={icons.duplicate} /><span className="ribbon-command-label">Duplicate</span></button>
                  </div>
                  <span className="ribbon-group-label">Document</span>
                </div>
                <div className="ribbon-command-group">
                  <div className="ribbon-command-row">
                    <button type="button" className="ribbon-command" disabled={!props.documentReady} onClick={() => props.onAction('download')}><Icon path={icons.download} /><span className="ribbon-command-label">Markdown</span></button>
                    <button type="button" className="ribbon-command" disabled={!props.documentReady} onClick={() => props.onAction('print')}><Icon path={icons.print} /><span className="ribbon-command-label">Print</span></button>
                    <button type="button" className="ribbon-command danger-command" disabled={!props.documentReady} onClick={() => props.onAction('delete')}><Icon path={icons.trash} /><span className="ribbon-command-label">Delete</span></button>
                  </div>
                  <span className="ribbon-group-label">Export</span>
                </div>
              </div>
            )}

            {(activeTab === 'home' || activeTab === 'insert') && (
              <Suspense fallback={<div className="ribbon-loading">Loading commands…</div>}>
                <RibbonToolbar
                  getView={props.getView}
                  section={activeTab}
                  disabled={!props.documentReady}
                  onVoice={props.onVoice}
                  voiceActive={props.voiceActive}
                  voiceSupported={props.voiceSupported}
                />
              </Suspense>
            )}

            {activeTab === 'review' && (
              <div className="ribbon-toolbar ribbon-deck-enter" role="toolbar" aria-label="Review commands">
                <div className="ribbon-command-group">
                  <div className="ribbon-command-row">
                    <button
                      type="button"
                      className={`ribbon-command${props.reviewOpen === 'comments' ? ' active' : ''}`}
                      aria-pressed={props.reviewOpen === 'comments'}
                      onClick={() => props.onAction('comments')}
                    >
                      <Icon path={icons.comment} />
                      <span className="ribbon-command-label">Comments</span>
                    </button>
                    <button
                      type="button"
                      className={`ribbon-command${props.reviewOpen === 'history' ? ' active' : ''}`}
                      aria-pressed={props.reviewOpen === 'history'}
                      onClick={() => props.onAction('history')}
                    >
                      <Icon path={icons.history} />
                      <span className="ribbon-command-label">History</span>
                    </button>
                  </div>
                  <span className="ribbon-group-label">Review</span>
                </div>
                <div className="ribbon-command-group">
                  <div className="ribbon-command-row">
                    <button
                      type="button"
                      className={`ribbon-command${props.hudOpen ? ' active' : ''}`}
                      aria-pressed={props.hudOpen}
                      onClick={props.onToggleHud}
                    >
                      <Icon path={icons.gauge} />
                      <span className="ribbon-command-label">Performance</span>
                    </button>
                  </div>
                  <span className="ribbon-group-label">Inspect</span>
                </div>
              </div>
            )}

            {activeTab === 'view' && (
              <div className="ribbon-toolbar ribbon-deck-enter" role="toolbar" aria-label="View commands">
                <div className="ribbon-command-group">
                  <div className="ribbon-command-row mode-command-row">
                    {visibleModes.map((mode) => (
                      <button
                        key={mode.id}
                        type="button"
                        className={`ribbon-command${props.mode === mode.id ? ' active' : ''}`}
                        aria-pressed={props.mode === mode.id}
                        onClick={() => props.onModeChange(mode.id)}
                      >
                        <Icon path={icons[mode.icon]} />
                        <span className="ribbon-command-label">{mode.label}</span>
                      </button>
                    ))}
                  </div>
                  <span className="ribbon-group-label">Layout</span>
                </div>
                <div className="ribbon-command-group">
                  <div className="ribbon-command-row">
                    <button
                      type="button"
                      className={`ribbon-command${props.outlineOpen ? ' active' : ''}`}
                      aria-pressed={props.outlineOpen}
                      onClick={props.onToggleOutline}
                    >
                      <Icon path={icons.outline} />
                      <span className="ribbon-command-label">Outline</span>
                    </button>
                    <button
                      type="button"
                      className={`ribbon-command${props.focusMode ? ' active' : ''}`}
                      aria-pressed={props.focusMode}
                      onClick={() => props.onAction('focus')}
                    >
                      <Icon path={icons.focus} />
                      <span className="ribbon-command-label">Focus</span>
                    </button>
                    <button type="button" className="ribbon-command" onClick={() => props.onAction('preferences')}>
                      <Icon path={icons.settings} />
                      <span className="ribbon-command-label">Appearance</span>
                    </button>
                    <button type="button" className="ribbon-command" onClick={props.onToggleTheme}>
                      <Icon path={props.theme === 'dark' ? icons.sun : icons.moon} />
                      <span className="ribbon-command-label">
                        {props.theme === 'dark' ? 'Light' : 'Dark'}
                      </span>
                    </button>
                    <button
                      type="button"
                      className={`ribbon-command${props.hudOpen ? ' active' : ''}`}
                      aria-pressed={props.hudOpen}
                      onClick={props.onToggleHud}
                    >
                      <Icon path={icons.gauge} />
                      <span className="ribbon-command-label">Performance</span>
                    </button>
                  </div>
                  <span className="ribbon-group-label">Workspace</span>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </header>
  );
}
