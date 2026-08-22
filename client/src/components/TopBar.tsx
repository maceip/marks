import type { EditorView } from '@codemirror/view';
import { lazy, Suspense, useEffect, useState } from 'react';
import type { ConnectionStatus, Peer } from '../collab/types';
import { exportUrl } from '../lib/api';
import { Icon, icons } from './Icon';
import { PresenceBar } from './PresenceBar';

export type ViewMode = 'edit' | 'split' | 'preview';
export type SurfaceRoute = 'home' | 'document' | 'benchmark';
type RibbonTab = 'home' | 'insert' | 'review' | 'view';

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
  onModeChange: (mode: ViewMode) => void;
  onToggleSidebar: () => void;
  onToggleTheme: () => void;
  onToggleHud: () => void;
  onToggleOutline: () => void;
  onVoice?: () => void;
  voiceActive?: boolean;
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
  { id: 'home', label: 'Home' },
  { id: 'insert', label: 'Insert' },
  { id: 'review', label: 'Review' },
  { id: 'view', label: 'View' },
];

export function TopBar(props: TopBarProps) {
  const [copied, setCopied] = useState(false);
  const [activeTab, setActiveTab] = useState<RibbonTab>(() =>
    props.mode === 'preview' ? 'view' : 'home',
  );

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(timer);
  }, [copied]);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      setCopied(true);
    } catch {
      // Clipboard permission denied: the URL bar still has the link.
    }
  };

  const documentRoute = props.route === 'document';
  const visibleModes = props.phone ? MODES.filter((mode) => mode.id !== 'split') : MODES;

  return (
    <header className={`app-ribbon ribbon-${props.route}`}>
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
            <Icon path={icons.bolt} size={14} />
          </span>

          <h1 className="doc-heading" title={props.title}>
            {props.title}
          </h1>

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
              {STATUS_LABEL[props.status]}
            </span>
          )}
        </div>

        <div className="topbar-right">
          {documentRoute && props.documentAvailable && <PresenceBar peers={props.peers} />}

          {documentRoute && props.documentAvailable && (
            <button
              type="button"
              className="titlebar-action"
              aria-label={copied ? 'Link copied' : 'Copy share link'}
              title="Copy share link"
              onClick={copyLink}
            >
              <Icon path={copied ? icons.check : icons.share} />
              <span>{copied ? 'Copied' : 'Share'}</span>
            </button>
          )}

          {props.docId && props.documentAvailable && (
            <a
              className="icon-button titlebar-download"
              href={exportUrl(props.docId)}
              download
              aria-label="Download markdown"
              title="Download .md"
            >
              <Icon path={icons.download} />
            </a>
          )}

          <button
            type="button"
            className="icon-button titlebar-theme"
            aria-label={props.theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            title="Toggle theme"
            onClick={props.onToggleTheme}
          >
            <Icon path={props.theme === 'dark' ? icons.sun : icons.moon} />
          </button>
        </div>
      </div>

      {documentRoute && (
        <div className="ribbon-body">
          <nav className="ribbon-tabs" aria-label="Command ribbon">
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
            {(activeTab === 'home' || activeTab === 'insert') && (
              <Suspense fallback={<div className="ribbon-loading">Loading commands…</div>}>
                <RibbonToolbar
                  getView={props.getView}
                  section={activeTab}
                  disabled={!props.documentReady}
                  onVoice={props.onVoice}
                  voiceActive={props.voiceActive}
                />
              </Suspense>
            )}

            {activeTab === 'review' && (
              <div className="ribbon-toolbar" role="toolbar" aria-label="Review commands">
                <div className="ribbon-command-group">
                  <div className="ribbon-command-row">
                    <button
                      type="button"
                      className="ribbon-command"
                      disabled
                      title="Available when review services come online"
                    >
                      <Icon path={icons.outline} />
                      <span className="ribbon-command-label">Comments</span>
                    </button>
                    <button
                      type="button"
                      className="ribbon-command"
                      disabled
                      title="Available when document history comes online"
                    >
                      <Icon path={icons.document} />
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
              <div className="ribbon-toolbar" role="toolbar" aria-label="View commands">
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
