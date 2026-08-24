import { useEffect, useMemo, useRef, useState } from 'react';
import type { EditorView } from '@codemirror/view';
import {
  getPresenceDisplay,
  PRESENCE_DISPLAY_EVENT,
  setPresenceDisplay,
  type DocumentPresenceDisplay,
} from '../../collab/presence-display';
import type { CollabSession } from '../../collab/types';
import { assignKeyTips } from '../../commands/keytips.ts';
import { solveRibbonLayout, type RibbonLayout } from '../../commands/layout.ts';
import { useCommandCenter } from '../../commands/context';
import { COMMANDS } from '../../commands/registry.ts';
import type {
  ProjectedCommand,
  ProjectedCommandGroup,
  RibbonTabId,
} from '../../commands/types.ts';
import { clearFormatPreview, showFormatPreview, type FormatPreviewKind } from '../../editor/format-preview';
import type { UiActionId } from '../../lib/ui-actions';
import type { ViewMode } from '../shell/TopBar';
import { Glyph } from '../glyphs/Glyph';
import { RibbonCommand, RibbonGroup } from './RibbonCommand';

export type RibbonTab = RibbonTabId;

interface DesktopRibbonProps {
  documentId: string;
  session: CollabSession | null;
  documentReady: boolean;
  mode: ViewMode;
  theme: 'light' | 'dark';
  hudOpen: boolean;
  outlineOpen: boolean;
  reviewOpen?: 'comments' | 'history' | null;
  focusMode?: boolean;
  phone: boolean;
  selected: number;
  getView: () => EditorView | null;
  onModeChange: (mode: ViewMode) => void;
  onToggleHud: () => void;
  onToggleOutline: () => void;
  onAction: (action: UiActionId) => void;
  onOpenDraftTools: () => void;
  onToggleTheme?: () => void;
  onVoice?: () => void;
  voiceActive?: boolean;
  voiceSupported?: boolean;
  onNotify?: (title: string, detail?: string, tone?: 'neutral' | 'success' | 'danger') => void;
}

type KeyTipLayer = 'tabs' | 'commands' | null;

const TAB_PREFERRED: Partial<Record<RibbonTabId, string>> = {
  file: 'F',
  home: 'H',
  insert: 'N',
  draw: 'D',
  tools: 'T',
  review: 'R',
  view: 'V',
  picture: 'P',
  table: 'A',
  shape: 'S',
};

export function DesktopRibbon(props: DesktopRibbonProps) {
  const center = useCommandCenter();
  const [tab, setTab] = useState<RibbonTabId>('home');
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [galleryOpen, setGalleryOpen] = useState<string | null>(null);
  const [keyTipLayer, setKeyTipLayer] = useState<KeyTipLayer>(null);
  const [keySequence, setKeySequence] = useState('');
  const [width, setWidth] = useState(1200);
  const rootRef = useRef<HTMLDivElement>(null);
  const lastLayout = useRef<RibbonLayout | undefined>(undefined);
  const lastManualTabAt = useRef(0);
  const [presenceDisplay, setPresenceState] = useState<DocumentPresenceDisplay>(() =>
    getPresenceDisplay(props.mode === 'preview'));

  const tabs = center.ribbon;
  const selectedTab = tabs.find((candidate) => candidate.id === tab) ?? tabs[0];
  const groups = selectedTab?.groups ?? [];
  const layout = useMemo(() => {
    const next = solveRibbonLayout(groups, width, lastLayout.current);
    lastLayout.current = next;
    return next;
  }, [groups, width]);
  const visibleGroups = groups.filter((group) => layout.visible.includes(group.id));
  const collapsedGroups = groups.filter((group) => layout.collapsed.includes(group.id));

  const tabTips = useMemo(() => assignKeyTips(tabs.map((item) => ({
    id: item.id,
    label: item.label,
    preferred: TAB_PREFERRED[item.id],
  }))), [tabs]);
  const commandTips = useMemo(() => assignKeyTips(groups.flatMap((group) => group.commands.map((command) => ({
    id: command.id,
    label: command.label,
    preferred: command.keyTip,
  })))), [groups]);

  useEffect(() => {
    const element = rootRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const sync = () => setPresenceState(getPresenceDisplay(props.mode === 'preview'));
    sync();
    window.addEventListener(PRESENCE_DISPLAY_EVENT, sync);
    return () => window.removeEventListener(PRESENCE_DISPLAY_EVENT, sync);
  }, [props.mode]);

  useEffect(() => {
    if (tabs.some((candidate) => candidate.id === tab)) return;
    const preferred = center.environment.mode === 'preview'
      ? tabs.find((candidate) => candidate.id === 'view' || candidate.id === 'review')
      : tabs.find((candidate) => candidate.id === 'home');
    setTab(preferred?.id ?? tabs[0]?.id ?? 'home');
  }, [center.environment.mode, tab, tabs]);

  useEffect(() => {
    const active = center.runs.findLast((run) =>
      (run.source === 'agent' || run.source === 'bridge') &&
      (run.status === 'proposed' || run.status === 'awaiting-approval' || run.status === 'running'));
    if (!active || Date.now() - lastManualTabAt.current < 4500) return;
    const destination = tabs.find((candidate) => candidate.groups.some((group) =>
      group.commands.some((command) => command.id === active.commandId)));
    if (destination) setTab(destination.id);
  }, [center.runs, tabs]);

  useEffect(() => {
    const contextual = tabs.find((candidate) => candidate.contextual);
    if (!contextual || tab !== 'home' || Date.now() - lastManualTabAt.current < 2500) return;
    setTab(contextual.id);
  }, [tab, tabs]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target?.matches('input, textarea, select, [contenteditable="true"]');
      if (event.key === 'Alt' && !typing && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
        event.preventDefault();
        setKeyTipLayer((current) => current ? null : 'tabs');
        setKeySequence('');
        return;
      }
      if (!keyTipLayer) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        setKeyTipLayer(null);
        setKeySequence('');
        const view = props.getView();
        if (view) clearFormatPreview(view);
        return;
      }
      if (!/^[a-z0-9]$/i.test(event.key)) return;
      event.preventDefault();
      const next = `${keySequence}${event.key.toUpperCase()}`;
      const tips = keyTipLayer === 'tabs' ? tabTips : commandTips;
      const matches = [...tips.entries()].filter(([, tip]) => tip.startsWith(next));
      if (matches.length === 0) {
        setKeySequence('');
        return;
      }
      const exact = matches.find(([, tip]) => tip === next);
      if (!exact || matches.some(([, tip]) => tip !== next && tip.startsWith(next))) {
        setKeySequence(next);
        return;
      }
      if (keyTipLayer === 'tabs') {
        setTab(exact[0] as RibbonTabId);
        setKeyTipLayer('commands');
        setKeySequence('');
      } else {
        const command = groups.flatMap((group) => group.commands).find((item) => item.id === exact[0]);
        if (command?.enabled) void center.invoke(command.id, 'keyboard');
        setKeyTipLayer(null);
        setKeySequence('');
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [center, commandTips, groups, keySequence, keyTipLayer, props.getView, tabTips]);

  useEffect(() => () => {
    const view = props.getView();
    if (view) clearFormatPreview(view);
  }, [props.getView]);

  const selectTab = (id: RibbonTabId) => {
    lastManualTabAt.current = Date.now();
    setTab(id);
    setOverflowOpen(false);
    setGalleryOpen(null);
  };

  const changePresence = (value: DocumentPresenceDisplay) => {
    setPresenceDisplay(value);
    setPresenceState(value);
  };

  return (
    <div
      ref={rootRef}
      className={`ribbon-body${keyTipLayer ? ' keytips-visible' : ''}`}
      data-command-context={center.environment.context}
      data-agent-active={center.raised.size > 0 ? 'true' : undefined}
    >
      <nav className="ribbon-tabs" aria-label="Command ribbon">
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`ribbon-tab${tab === item.id ? ' active' : ''}${item.contextual ? ' contextual' : ''}${item.agentRaised ? ' agent-raised' : ''}`}
            aria-pressed={tab === item.id}
            onClick={() => selectTab(item.id)}
          >
            {item.label}
            {item.agentRaised && <span className="agent-tab-dot" aria-label="Agent-relevant commands" />}
            {keyTipLayer === 'tabs' && <KeyTip value={tabTips.get(item.id)} sequence={keySequence} />}
          </button>
        ))}
        <button
          type="button"
          className="ribbon-profile-toggle"
          aria-pressed={center.profile.expanded}
          title={center.profile.expanded ? 'Use the essential ribbon' : 'Show every ribbon task and command'}
          onClick={() => center.setExpanded(!center.profile.expanded)}
        >
          {center.profile.expanded ? 'Essentials' : 'All commands'}
        </button>
      </nav>

      <div className="ribbon-deck">
        <div className="ribbon-toolbar ribbon-deck-enter" role="toolbar" aria-label={`${selectedTab?.label ?? 'Command'} commands`}>
          {visibleGroups.map((group) => (
            <CommandGroup
              key={group.id}
              group={group}
              keyTips={keyTipLayer === 'commands' ? commandTips : null}
              keySequence={keySequence}
              galleryOpen={galleryOpen === group.id}
              onGallery={(open) => setGalleryOpen(open ? group.id : null)}
              getView={props.getView}
            />
          ))}
          {tab === 'view' && (
            <RibbonGroup label="Presence">
              {(['exact', 'section', 'off'] as const).map((value) => (
                <RibbonCommand
                  key={value}
                  glyph={value === 'off' ? 'clear' : value === 'exact' ? 'find' : 'outline'}
                  label={value[0].toUpperCase() + value.slice(1)}
                  pressed={presenceDisplay === value}
                  onClick={() => changePresence(value)}
                />
              ))}
            </RibbonGroup>
          )}
          {collapsedGroups.length > 0 && (
            <div className="ribbon-command-group ribbon-overflow-group">
              <button
                type="button"
                className="ribbon-overflow-trigger"
                aria-haspopup="menu"
                aria-expanded={overflowOpen}
                onClick={() => setOverflowOpen((open) => !open)}
              >
                <Glyph name="more" size={22} />
                <span>More</span>
              </button>
              <span className="ribbon-group-label">Overflow</span>
              {overflowOpen && (
                <div className="ribbon-overflow-menu" role="menu">
                  {collapsedGroups.map((group) => (
                    <section key={group.id} aria-label={group.label}>
                      <h3>{group.label}</h3>
                      <div>
                        {group.commands.map((command) => (
                          <CommandControl key={command.id} command={command} compact />
                        ))}
                      </div>
                    </section>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function CommandGroup({
  group,
  keyTips,
  keySequence,
  galleryOpen,
  onGallery,
  getView,
}: {
  group: ProjectedCommandGroup;
  keyTips: Map<string, string> | null;
  keySequence: string;
  galleryOpen: boolean;
  onGallery: (open: boolean) => void;
  getView: () => EditorView | null;
}) {
  const galleryCommands = group.commands.filter((command) => command.presentation === 'gallery');
  const ordinary = group.commands.filter((command) => command.presentation !== 'gallery');
  return (
    <RibbonGroup label={group.label} agentRaised={group.agentRaised}>
      {galleryCommands.length > 0 && (
        <div className="ribbon-gallery-control">
          <div className="ribbon-gallery-strip" role="listbox" aria-label={`${group.label} gallery`}>
            {galleryCommands.slice(0, 3).map((command) => (
              <GalleryOption
                key={command.id}
                command={command}
                keyTip={keyTips?.get(command.id)}
                keySequence={keySequence}
                getView={getView}
              />
            ))}
          </div>
          {galleryCommands.length > 3 && (
            <button type="button" className="ribbon-gallery-expand" aria-label={`Expand ${group.label} gallery`} aria-expanded={galleryOpen} onClick={() => onGallery(!galleryOpen)}>
              ⌄
            </button>
          )}
          {galleryOpen && (
            <div className="ribbon-gallery-popup" role="listbox" aria-label={`All ${group.label} styles`}>
              {galleryCommands.map((command) => (
                <GalleryOption
                  key={command.id}
                  command={command}
                  keyTip={keyTips?.get(command.id)}
                  keySequence={keySequence}
                  getView={getView}
                />
              ))}
            </div>
          )}
        </div>
      )}
      {ordinary.map((command) => (
        <CommandControl
          key={command.id}
          command={command}
          keyTip={keyTips?.get(command.id)}
          keySequence={keySequence}
        />
      ))}
    </RibbonGroup>
  );
}

function GalleryOption({ command, keyTip, keySequence, getView }: {
  command: ProjectedCommand;
  keyTip?: string;
  keySequence: string;
  getView: () => EditorView | null;
}) {
  const center = useCommandCenter();
  const preview = () => {
    const kind = previewKind(command.id);
    const view = getView();
    if (kind && view) showFormatPreview(view, kind);
  };
  const clear = () => {
    const view = getView();
    if (view) clearFormatPreview(view);
  };
  return (
    <button
      type="button"
      className={`style-chip ${command.id.replaceAll('.', '-')}${command.agentRaised ? ' agent-raised' : ''}`}
      role="option"
      data-command-id={command.id}
      disabled={!command.enabled}
      title={command.unavailableReason ?? command.description}
      onPointerEnter={preview}
      onPointerLeave={clear}
      onFocus={preview}
      onBlur={clear}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => {
        clear();
        void center.invoke(command.id);
      }}
    >
      <span>{command.label === 'Body' ? 'Aa' : command.label.replace('Heading ', 'H')}</span>
      {command.label}
      {keyTip && <KeyTip value={keyTip} sequence={keySequence} />}
    </button>
  );
}

function CommandControl({ command, keyTip, keySequence = '', compact = false }: {
  command: ProjectedCommand;
  keyTip?: string;
  keySequence?: string;
  compact?: boolean;
}) {
  const center = useCommandCenter();
  const active = center.runs.findLast((run) => run.commandId === command.id &&
    (run.status === 'proposed' || run.status === 'awaiting-approval' || run.status === 'running'));
  const label = dynamicLabel(command, center.environment.theme);
  return (
    <RibbonCommand
      glyph={dynamicGlyph(command, center.environment.theme)}
      label={label}
      title={command.unavailableReason ?? `${command.description}${command.shortcut ? ` (${command.shortcut})` : ''}`}
      pressed={command.pressed}
      disabled={!command.enabled}
      danger={command.risk === 'destructive'}
      large={!compact && command.presentation === 'large'}
      commandId={command.id}
      agentState={active?.status}
      agentRaised={command.agentRaised}
      onContextMenu={() => center.togglePin(command.id)}
      onClick={() => void center.invoke(command.id)}
    >
      {keyTip && <KeyTip value={keyTip} sequence={keySequence} />}
    </RibbonCommand>
  );
}

function KeyTip({ value, sequence }: { value?: string; sequence: string }) {
  if (!value || (sequence && !value.startsWith(sequence))) return null;
  return <kbd className="ribbon-keytip">{value}</kbd>;
}

function previewKind(commandId: string): FormatPreviewKind | null {
  if (commandId === 'format.paragraph') return 'body';
  const match = /^format\.heading-([1-4])$/.exec(commandId);
  return match ? `heading-${match[1]}` as FormatPreviewKind : null;
}

function dynamicLabel(command: ProjectedCommand, theme: 'light' | 'dark'): string {
  if (command.id === 'view.theme') return theme === 'dark' ? 'Light' : 'Dark';
  return command.label;
}

function dynamicGlyph(command: ProjectedCommand, theme: 'light' | 'dark'): ProjectedCommand['glyph'] {
  if (command.id === 'view.theme') return theme === 'dark' ? 'sun' : 'moon';
  return command.glyph;
}

export function QuickAccess({ disabled: _disabled, getView: _getView }: {
  disabled?: boolean;
  getView: () => EditorView | null;
}) {
  const center = useCommandCenter();
  const [open, setOpen] = useState(false);
  const available = center.commands('palette')
    .filter((command) => command.risk !== 'destructive')
    .sort((a, b) => b.priority - a.priority)
    .slice(0, 24);
  return (
    <div className="quick-access" role="toolbar" aria-label="Quick access">
      {center.quickAccess.map((command) => (
        <button
          key={command.id}
          type="button"
          className={`icon-button${command.agentRaised ? ' agent-raised' : ''}`}
          data-command-id={command.id}
          aria-label={command.label}
          title={command.unavailableReason ?? command.description}
          disabled={!command.enabled}
          onClick={() => void center.invoke(command.id)}
        >
          <Glyph name={command.glyph} size={16} />
        </button>
      ))}
      <button type="button" className="quick-access-customize" aria-label="Customize Quick Access" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
        ⌄
      </button>
      {open && (
        <div className="quick-access-menu" role="menu" aria-label="Customize Quick Access">
          <header><strong>Quick Access</strong><span>Pin up to 12 commands</span></header>
          {available.map((command) => (
            <button key={command.id} type="button" role="menuitemcheckbox" aria-checked={center.profile.pinned.includes(command.id)} onClick={() => center.togglePin(command.id)}>
              <span>{center.profile.pinned.includes(command.id) ? '✓' : ''}</span>
              <Glyph name={command.glyph} size={16} />
              {command.label}
            </button>
          ))}
          <button type="button" className="quick-access-profile" onClick={() => center.setExpanded(!center.profile.expanded)}>
            {center.profile.expanded ? 'Use essential ribbon' : 'Show all ribbon commands'}
          </button>
        </div>
      )}
    </div>
  );
}

export const REGISTERED_RIBBON_COMMAND_COUNT = COMMANDS.length;
