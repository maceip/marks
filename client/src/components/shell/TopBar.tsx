import type { EditorView } from '@codemirror/view';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { CollabSession, ConnectionStatus, Peer } from '../../collab/types';
import { useOptionalCommandCenter } from '../../commands/context';
import type { Posture } from '../../lib/posture';
import type { UiActionId } from '../../lib/ui-actions';
import { Icon, icons } from '../ui/Icon';
import { MarksMark } from '../ui/MarksMark';
import { PresenceBar } from './PresenceBar';
import { SurfaceMaterial } from '../ui/SurfaceMaterial';

export type ViewMode = 'edit' | 'split' | 'preview';
export type SurfaceRoute = 'home' | 'document' | 'benchmark' | 'link';

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
  session: CollabSession | null;
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
  workspaceKind: 'local' | 'scratch' | 'session';
  focusMode?: boolean;
  ribbonCollapsed?: boolean;
  onModeChange: (mode: ViewMode) => void;
  onToggleSidebar: () => void;
  onToggleTheme: () => void;
  onToggleHud: () => void;
  onToggleOutline: () => void;
  onToggleRibbon: () => void;
  onAction: (action: UiActionId) => void;
  onOpenDraftTools?: () => void;
  onVoice?: () => void;
  voiceActive?: boolean;
  voiceSupported?: boolean;
  onNotify?: (title: string, detail?: string, tone?: 'neutral' | 'success' | 'danger') => void;
}

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  connecting: 'Opening',
  saving: 'Saving',
  connected: 'Saved',
  offline: 'Offline',
};

export function TopBar(props: TopBarProps) {
  const commandCenter = useOptionalCommandCenter();
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
  const resolvedCommands = commandCenter
    ? new Map([
        ...commandCenter.commands('palette'),
        ...commandCenter.ribbon.flatMap((tab) => tab.groups.flatMap((group) => group.commands)),
      ].map((command) => [command.id, command]))
    : null;
  const invoke = (commandId: string, legacy: UiActionId) => {
    if (commandCenter && resolvedCommands?.get(commandId)?.enabled) void commandCenter.invoke(commandId);
    else if (!commandCenter) props.onAction(legacy);
  };
  const available = (commandId: string) => resolvedCommands?.get(commandId);

  return (
    <header className={`app-ribbon ribbon-${props.route} surface-material-host`}>
      <SurfaceMaterial variant="chrome" />
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

          {documentRoute && (!commandCenter || available('document.rename')?.enabled) ? (
            <button type="button" className="doc-heading doc-heading-button" data-command-id="document.rename" title={available('document.rename')?.unavailableReason ?? 'Rename document'} onClick={() => invoke('document.rename', 'rename')}>
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
                  ? props.documentReady
                    ? 'Offline — authorized edits remain in the local journal'
                    : 'Offline — document remains readable'
                  : STATUS_LABEL[props.status]
              }
            >
              <span className="status-dot" />
              {props.localMode ? 'On this device' : STATUS_LABEL[props.status]}
            </span>
          )}

          {props.workspaceKind === 'scratch' && (
            <button
              type="button"
              className="identity-chip"
              onClick={() => props.onAction('keep-workspace')}
            >
              Temporary
            </button>
          )}
          {props.workspaceKind === 'local' && <span className="identity-chip">Local</span>}
        </div>

          <div className="topbar-right">
          {props.focusMode && (
            <button type="button" className="focus-exit" onClick={() => props.onAction('focus')}>
              <Icon path={icons.focus} size={14} /> Exit focus
            </button>
          )}
          {documentRoute && props.documentAvailable && <PresenceBar peers={props.peers} onJump={(peer) => {
            const view = props.getView();
            const position = peer.selection?.to;
            if (!view || position === undefined) return;
            const box = view.coordsAtPos(Math.min(position, view.state.doc.length));
            if (box) view.scrollDOM.scrollTo({ top: Math.max(0, view.scrollDOM.scrollTop + box.top - view.scrollDOM.getBoundingClientRect().top - 48), behavior: 'smooth' });
          }} />}

          {documentRoute && props.documentAvailable && (!commandCenter || available('document.share')) && (
            <button
              type="button"
              className="titlebar-action"
              aria-label="Share document"
              title="Share document"
              data-command-id="document.share"
              disabled={commandCenter ? !available('document.share')?.enabled : false}
              onClick={() => invoke('document.share', 'share')}
            >
              <Icon path={icons.share} />
              <span>Share</span>
            </button>
          )}

          {props.docId && props.documentAvailable && (!commandCenter || available('document.export-markdown')) && (
            <button
              type="button"
              className="icon-button titlebar-download"
              aria-label="Download markdown"
              title="Download .md"
              data-command-id="document.export-markdown"
              disabled={commandCenter ? !available('document.export-markdown')?.enabled : false}
              onClick={() => invoke('document.export-markdown', 'download')}
            >
              <Icon path={icons.download} />
            </button>
          )}

          <button type="button" className="icon-button titlebar-search" data-command-id="workspace.command-palette" aria-label="Open command palette" title="Command palette (⌘⇧P)" onClick={() => invoke('workspace.command-palette', 'command-palette')}>
            <Icon path={icons.search} />
          </button>

          <button
            type="button"
            className="icon-button titlebar-theme"
            aria-label={props.theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            title="Toggle theme"
            data-command-id="view.theme"
            onClick={() => commandCenter ? invoke('view.theme', 'preferences') : props.onToggleTheme()}
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
              data-command-id="view.ribbon"
              onClick={() => commandCenter ? invoke('view.ribbon', 'preferences') : props.onToggleRibbon()}
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
                {(!commandCenter ? props.workspaceKind === 'scratch' : available('identity.keep')) && <button type="button" role="menuitem" data-command-id="identity.keep" onClick={() => { setMoreOpen(false); invoke('identity.keep', 'keep-workspace'); }}><Icon path={icons.share} /> Keep workspace</button>}
                {(!commandCenter ? props.workspaceKind !== 'local' : available('identity.account')) && <button type="button" role="menuitem" data-command-id="identity.account" onClick={() => { setMoreOpen(false); invoke('identity.account', 'account'); }}><Icon path={icons.settings} /> Account</button>}
                {(!commandCenter ? props.workspaceKind !== 'local' : available('identity.pairing')) && <button type="button" role="menuitem" data-command-id="identity.pairing" onClick={() => { setMoreOpen(false); invoke('identity.pairing', 'pairing'); }}><Icon path={icons.link} /> Phone confirmation</button>}
                {(!commandCenter ? props.workspaceKind === 'session' : available('identity.sign-out')) && <button type="button" role="menuitem" data-command-id="identity.sign-out" onClick={() => { setMoreOpen(false); invoke('identity.sign-out', 'logout'); }}><Icon path={icons.close} /> Sign out</button>}
                <button type="button" role="menuitem" data-command-id="view.preferences" onClick={() => { setMoreOpen(false); invoke('view.preferences', 'preferences'); }}><Icon path={icons.settings} /> Appearance</button>
                <button type="button" role="menuitem" data-command-id="review.performance" onClick={() => { setMoreOpen(false); invoke('review.performance', 'benchmark'); }}><Icon path={icons.gauge} /> Performance</button>
                <button type="button" role="menuitem" data-command-id="workspace.about" onClick={() => { setMoreOpen(false); invoke('workspace.about', 'about'); }}><Icon path={icons.bolt} /> Google Docs for Markdown</button>
              </div>
            )}
          </div>
        </div>
      </div>

      {documentRoute && (
        <Suspense fallback={props.posture.phone ? null : <div className="ribbon-loading">Loading commands…</div>}>
          <DocumentChrome
            documentId={props.docId ?? ''}
            session={props.session}
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
            onOpenDraftTools={() => props.onOpenDraftTools?.()}
            onToggleTheme={props.onToggleTheme}
            onVoice={props.onVoice}
            voiceActive={props.voiceActive}
            voiceSupported={props.voiceSupported}
            onNotify={props.onNotify}
            temporary={props.workspaceKind === 'scratch'}
          />
        </Suspense>
      )}
    </header>
  );
}
