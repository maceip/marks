import type { EditorView } from '@codemirror/view';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { ConnectionStatus, Peer } from '../../collab/types';
import type { Posture } from '../../lib/posture';
import type { UiActionId } from '../../lib/ui-actions';
import { Icon, icons } from '../ui/Icon';
import { MarksMark } from '../ui/MarksMark';
import { PresenceBar } from './PresenceBar';
import { SurfaceMaterial } from '../ui/SurfaceMaterial';

export type ViewMode = 'edit' | 'split' | 'preview';
export type SurfaceRoute = 'home' | 'document' | 'benchmark';

const DocumentChrome = lazy(() =>
  import('../chrome/DocumentChrome').then((module) => ({ default: module.DocumentChrome })),
);
const QuickAccess = lazy(() =>
  import('../chrome/DocumentChrome').then((module) => ({ default: module.QuickAccess })),
);

interface TopBarProps {
  title: string;
  docId: string | null;
  route: SurfaceRoute;
  documentReady: boolean;
  documentAvailable: boolean;
  posture: Posture;
  selected?: number;
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
  onOpenAi?: () => void;
  onVoice?: () => void;
  voiceActive?: boolean;
  voiceSupported?: boolean;
  onNotify?: (title: string, detail?: string, tone?: 'neutral' | 'success' | 'danger') => void;
}

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  connecting: 'Opening',
  connected: 'Saved',
  offline: 'Offline',
};

export function TopBar(props: TopBarProps) {
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);

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

  return (
    <header className={`app-ribbon ribbon-${props.route} surface-material-host`}>
      <SurfaceMaterial variant="chrome" intensity={0.96} />
      <div className="titlebar">
        <div className="topbar-left">
          {documentRoute && !props.posture.phone && (
            <Suspense fallback={null}>
              <QuickAccess disabled={!props.documentReady} getView={props.getView} />
            </Suspense>
          )}
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

          {props.localMode && !props.posture.phone && (
            <button
              type="button"
              className="identity-chip"
              onClick={() => props.onAction('keep-workspace')}
            >
              Temporary
            </button>
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

          {documentRoute && !props.posture.phone && !props.focusMode && (
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
                <button type="button" role="menuitem" onClick={() => { setMoreOpen(false); props.onAction('keep-workspace'); }}><Icon path={icons.share} /> Keep workspace</button>
                <button type="button" role="menuitem" onClick={() => { setMoreOpen(false); props.onAction('account'); }}><Icon path={icons.settings} /> Account</button>
                <button type="button" role="menuitem" onClick={() => { setMoreOpen(false); props.onAction('preferences'); }}><Icon path={icons.settings} /> Appearance</button>
                <button type="button" role="menuitem" onClick={() => { setMoreOpen(false); props.onAction('benchmark'); }}><Icon path={icons.gauge} /> Performance</button>
                <button type="button" role="menuitem" onClick={() => { setMoreOpen(false); props.onAction('about'); }}><Icon path={icons.bolt} /> About marks</button>
              </div>
            )}
          </div>
        </div>
      </div>

      {documentRoute && (
        <Suspense fallback={props.posture.phone ? null : <div className="ribbon-loading">Loading commands…</div>}>
          <DocumentChrome
            posture={props.posture}
            documentReady={props.documentReady}
            documentTitle={props.title}
            mode={props.mode}
            theme={props.theme}
            hudOpen={props.hudOpen}
            outlineOpen={props.outlineOpen}
            reviewOpen={props.reviewOpen}
            focusMode={props.focusMode}
            selected={props.selected ?? 0}
            getView={props.getView}
            onModeChange={props.onModeChange}
            onToggleHud={props.onToggleHud}
            onToggleOutline={props.onToggleOutline}
            onAction={props.onAction}
            onOpenAi={() => props.onOpenAi?.()}
            onToggleTheme={props.onToggleTheme}
            onVoice={props.onVoice}
            voiceActive={props.voiceActive}
            voiceSupported={props.voiceSupported}
            onNotify={props.onNotify}
          />
        </Suspense>
      )}
    </header>
  );
}
