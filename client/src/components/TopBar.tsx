import { useEffect, useState } from 'react';
import type { ConnectionStatus, EngineName, Peer } from '../collab/types';
import { exportUrl } from '../lib/api';
import { Icon, icons } from './Icon';
import { PresenceBar } from './PresenceBar';

export type ViewMode = 'edit' | 'split' | 'preview';

interface TopBarProps {
  title: string;
  docId: string | null;
  engine: EngineName;
  status: ConnectionStatus;
  peers: Peer[];
  mode: ViewMode;
  theme: 'light' | 'dark';
  sidebarOpen: boolean;
  hudOpen: boolean;
  outlineOpen: boolean;
  commentsOpen?: boolean;
  commentCount?: number;
  onModeChange: (mode: ViewMode) => void;
  onToggleSidebar: () => void;
  onToggleTheme: () => void;
  onToggleHud: () => void;
  onToggleOutline: () => void;
  onToggleComments?: () => void;
}

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  connecting: 'Connecting',
  connected: 'Synced',
  offline: 'Offline — edits are saved locally',
};

const MODES: Array<{ id: ViewMode; label: string; icon: keyof typeof icons }> = [
  { id: 'edit', label: 'Editor', icon: 'pencil' },
  { id: 'split', label: 'Split', icon: 'split' },
  { id: 'preview', label: 'Preview', icon: 'eye' },
];

export function TopBar(props: TopBarProps) {
  const [copied, setCopied] = useState(false);

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

  return (
    <header className="topbar">
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

        <h1 className="doc-heading" title={props.title}>
          {props.title}
        </h1>

        <span className={`status status-${props.status}`} title={STATUS_LABEL[props.status]}>
          <span className="status-dot" />
          {STATUS_LABEL[props.status]}
        </span>

        <span className={`engine-tag engine-${props.engine}`} title="CRDT engine for this document">
          {props.engine}
        </span>
      </div>

      <div className="topbar-right">
        <PresenceBar peers={props.peers} />

        <div className="mode-switch" role="group" aria-label="View mode">
          {MODES.map((mode) => (
            <button
              key={mode.id}
              type="button"
              className={`mode-button${props.mode === mode.id ? ' active' : ''}`}
              aria-pressed={props.mode === mode.id}
              title={mode.label}
              onClick={() => props.onModeChange(mode.id)}
            >
              <Icon path={icons[mode.icon]} />
              <span className="mode-label">{mode.label}</span>
            </button>
          ))}
        </div>

        <button
          type="button"
          className="icon-button"
          aria-label="Document outline"
          aria-pressed={props.outlineOpen}
          title="Outline"
          onClick={props.onToggleOutline}
        >
          <Icon path={icons.outline} />
        </button>

        {props.onToggleComments && (
          <button
            type="button"
            className="icon-button"
            aria-label="Comments"
            aria-pressed={Boolean(props.commentsOpen)}
            title="Comments"
            onClick={props.onToggleComments}
          >
            <Icon path={icons.comment} />
            {(props.commentCount ?? 0) > 0 && (
              <span className="icon-badge">{props.commentCount}</span>
            )}
          </button>
        )}

        <button
          type="button"
          className="icon-button"
          aria-label={copied ? 'Link copied' : 'Copy share link'}
          title="Copy share link"
          onClick={copyLink}
        >
          <Icon path={copied ? icons.check : icons.share} />
        </button>

        {props.docId && (
          <a
            className="icon-button"
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
          className="icon-button"
          aria-label="Performance"
          aria-pressed={props.hudOpen}
          title="Performance"
          onClick={props.onToggleHud}
        >
          <Icon path={icons.gauge} />
        </button>

        <button
          type="button"
          className="icon-button"
          aria-label={props.theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          title="Toggle theme"
          onClick={props.onToggleTheme}
        >
          <Icon path={props.theme === 'dark' ? icons.sun : icons.moon} />
        </button>
      </div>
    </header>
  );
}
