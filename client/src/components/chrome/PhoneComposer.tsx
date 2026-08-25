import { useEffect, useMemo, useRef, useState } from 'react';
import type { EditorView } from '@codemirror/view';
import {
  getPresenceDisplay,
  PRESENCE_DISPLAY_EVENT,
  setPresenceDisplay,
  type DocumentPresenceDisplay,
} from '../../collab/presence-display';
import type { CollabSession } from '../../collab/types';
import { useCommandCenter } from '../../commands/context';
import { ribbonTask } from '../../commands/projection';
import type {
  ProjectedCommand,
  ProjectedCommandGroup,
  ProjectedRibbonTab,
  RibbonTabId,
} from '../../commands/types.ts';
import type { PhoneGhostControl } from '../../lib/phone-ghost';
import type { Posture } from '../../lib/posture';
import { AGENT_CHAT_ENABLED } from '../../lib/product';
import type { UiActionId } from '../../lib/ui-actions';
import type { ViewMode } from '../shell/TopBar';
import { Glyph } from '../glyphs/Glyph';
import { Icon, SurfaceMaterial } from '../ui';

interface PhoneComposerProps {
  documentId: string;
  session: CollabSession | null;
  posture: Posture;
  documentReady: boolean;
  documentTitle: string;
  mode: ViewMode;
  reviewOpen?: 'comments' | 'history' | null;
  getView: () => EditorView | null;
  onModeChange: (mode: ViewMode) => void;
  onAction: (action: UiActionId) => void;
  onToggleOutline: () => void;
  phoneGhost: PhoneGhostControl;
  onVoice?: () => void;
  voiceActive?: boolean;
  voiceSupported?: boolean;
  onNotify?: (title: string, detail?: string, tone?: 'neutral' | 'success' | 'danger') => void;
  temporary?: boolean;
}

const PHONE_TAB_ORDER: RibbonTabId[] = [
  'import', 'file', 'home', 'insert', 'review', 'view', 'login',
  'draw', 'tools', 'picture', 'table', 'shape',
];
const PHONE_MODE_COMMANDS = new Set(['view.editor', 'view.split', 'view.preview']);

/**
 * Office-mobile presentation: one category owns one command deck. Categories
 * live in an explicit picker; Edit/Preview is a separate persistent control.
 */
export function PhoneComposer(props: PhoneComposerProps) {
  const center = useCommandCenter();
  const task = ribbonTask(center.environment);
  const [showAll, setShowAll] = useState(false);
  const tabs = useMemo(
    () => orderTabs(center.ribbonFor('phone', showAll)),
    [center, showAll],
  );
  const phoneCommands = useMemo(() => center.commands('phone'), [center]);
  const [tab, setTab] = useState<RibbonTabId>(() => props.mode === 'preview' ? 'view' : 'home');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const pickerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [presenceDisplay, setPresenceState] = useState<DocumentPresenceDisplay>(() =>
    getPresenceDisplay(props.mode === 'preview'));
  const lastManualTabAt = useRef(0);
  const previousTask = useRef(task);
  const selectedTab = tabs.find((candidate) => candidate.id === tab) ?? tabs[0];
  const visibleGroups = useMemo(
    () => withoutModeCommands(selectedTab?.groups ?? []),
    [selectedTab],
  );

  useEffect(() => {
    const sync = () => setPresenceState(getPresenceDisplay(props.mode === 'preview'));
    sync();
    window.addEventListener(PRESENCE_DISPLAY_EVENT, sync);
    return () => window.removeEventListener(PRESENCE_DISPLAY_EVENT, sync);
  }, [props.mode]);

  useEffect(() => {
    if (!pickerOpen) return;
    const selected = pickerRef.current?.querySelector<HTMLElement>('[data-ribbon-tab][aria-pressed="true"]');
    requestAnimationFrame(() => selected?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setPickerOpen(false);
        requestAnimationFrame(() => triggerRef.current?.focus());
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(pickerRef.current?.querySelectorAll<HTMLElement>('button:not([disabled])') ?? []);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [pickerOpen]);

  useEffect(() => {
    if (previousTask.current === task) return;
    previousTask.current = task;
    const preferred = task === 'inspect'
      ? tabs.find((candidate) => candidate.id === 'view')
      : tabs.find((candidate) => candidate.id === 'home');
    if (!preferred) return;
    setTab(preferred.id);
    setAnnouncement(`${phoneTabLabel(preferred)} ribbon shown.`);
  }, [tabs, task]);

  useEffect(() => {
    const contextual = tabs.find((candidate) => candidate.contextual);
    if (!contextual || Date.now() - lastManualTabAt.current < 2500) return;
    setTab(contextual.id);
    setAnnouncement(`${contextual.label} contextual ribbon shown.`);
  }, [center.environment.context, tabs]);

  useEffect(() => {
    if (!AGENT_CHAT_ENABLED) return;
    const active = center.runs.findLast((run) =>
      (run.source === 'agent' || run.source === 'bridge') &&
      (run.status === 'proposed' || run.status === 'awaiting-approval' || run.status === 'running'));
    if (!active || Date.now() - lastManualTabAt.current < 4500) return;
    const destination = tabs.find((candidate) => candidate.groups.some((group) =>
      group.commands.some((command) => command.id === active.commandId)));
    if (!destination) return;
    setTab(destination.id);
    setAnnouncement(`${phoneTabLabel(destination)} ribbon shown for the active command.`);
  }, [center.runs, tabs]);

  const invoke = (command: ProjectedCommand) => {
    if (command.enabled) void center.invoke(command.id);
  };
  const selectTab = (id: RibbonTabId) => {
    lastManualTabAt.current = Date.now();
    setTab(id);
    setPickerOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
    const destination = tabs.find((item) => item.id === id);
    if (id === 'login') {
      const login = destination?.groups
        .flatMap((group) => group.commands)
        .find((command) => command.id === 'identity.keep');
      if (login?.enabled) void center.invoke(login.id);
    }
  };
  const changePresence = (value: DocumentPresenceDisplay) => {
    setPresenceDisplay(value);
    setPresenceState(value);
  };
  const selectMode = (commandId: 'view.editor' | 'view.preview', fallback: ViewMode) => {
    const command = phoneCommands.find((candidate) => candidate.id === commandId);
    if (command?.enabled) void center.invoke(command.id);
    else if (!command) props.onModeChange(fallback);
  };

  return (
    <div className={`phone-composer${props.posture.keyboardOpen ? ' keyboard-open' : ''}`} data-command-context={center.environment.context} data-ribbon-task={task}>
      {props.temporary && (
        <button type="button" className="phone-identity" data-command-id="identity.keep" onClick={() => {
          const keep = tabs.flatMap((item) => item.groups).flatMap((group) => group.commands).find((command) => command.id === 'identity.keep');
          if (keep) invoke(keep);
        }}>
          <span>Log In</span>
          Open this page on a laptop to log in. The page is already saved and public.
        </button>
      )}

      {pickerOpen && (
        <div className="phone-category-layer">
          <button type="button" className="phone-category-scrim" aria-label="Close ribbon categories" onClick={() => { setPickerOpen(false); requestAnimationFrame(() => triggerRef.current?.focus()); }} />
          <div id="phone-ribbon-categories" className="phone-category-sheet surface-material-host" role="dialog" aria-modal="true" aria-labelledby="phone-ribbon-categories-title" aria-describedby="phone-ribbon-categories-description" ref={pickerRef}>
            <SurfaceMaterial variant="floating" />
            <header>
              <span><strong id="phone-ribbon-categories-title">Ribbon categories</strong><small id="phone-ribbon-categories-description">Choose a task, then use its command row.</small></span>
              <button type="button" className="phone-category-close" aria-label="Close ribbon categories" onClick={() => { setPickerOpen(false); requestAnimationFrame(() => triggerRef.current?.focus()); }}><Icon name="close" size={14} /></button>
            </header>
            <div className="phone-category-grid">
              {tabs.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  data-ribbon-tab={item.id}
                  aria-pressed={selectedTab?.id === item.id}
                  className={`${item.contextual ? 'contextual ' : ''}${item.agentRaised ? 'agent-raised' : ''}`.trim()}
                  onClick={() => selectTab(item.id)}
                >
                  <Glyph name={tabGlyph(item.id)} size={27} />
                  <span>
                    <strong>{phoneTabLabel(item)}</strong>
                    <small>{item.groups.map((group) => group.label).join(' · ')}</small>
                  </span>
                  {item.agentRaised && <i className="agent-tab-dot" aria-label="Agent-relevant commands" />}
                  <b aria-hidden="true"><Icon name={selectedTab?.id === item.id ? 'check' : 'chevron'} size={13} interactive={false} /></b>
                </button>
              ))}
            </div>
            <button
              type="button"
              className="phone-category-all"
              role="switch"
              aria-checked={showAll}
              onClick={() => setShowAll((current) => !current)}
            >
              <Glyph name={showAll ? 'shrink' : 'more'} size={24} />
              <span><strong>{showAll ? 'Use essential categories' : 'Show all categories'}</strong><small>{showAll ? 'Return to the focused phone ribbon.' : 'Add Draw, Tools, and less-common commands.'}</small></span>
            </button>
          </div>
        </div>
      )}

      <section className="phone-ribbon surface-material-host" aria-label="Mobile ribbon">
        <SurfaceMaterial variant="chrome" modifier="subtle" />
        <div className="phone-ribbon-head">
          <button
            ref={triggerRef}
            type="button"
            className="phone-category-trigger"
            aria-haspopup="dialog"
            aria-expanded={pickerOpen}
            aria-controls="phone-ribbon-categories"
            onClick={() => setPickerOpen((open) => !open)}
          >
            <Glyph name={tabGlyph(selectedTab?.id ?? 'home')} size={24} />
            <span><small>Ribbon</small><strong>{phoneTabLabel(selectedTab)}</strong></span>
            <b aria-hidden="true"><Icon name="chevron" size={12} interactive={false} /></b>
          </button>

          <div className="phone-mode-switch" role="group" aria-label="Document view">
            <button
              type="button"
              data-command-id="view.editor"
              aria-pressed={props.mode !== 'preview'}
              onClick={() => selectMode('view.editor', 'edit')}
            >
              <Glyph name="pencil" size={16} /> Edit
            </button>
            <button
              type="button"
              data-command-id="view.preview"
              aria-pressed={props.mode === 'preview'}
              onClick={() => selectMode('view.preview', 'preview')}
            >
              <Glyph name="eye" size={16} /> Preview
            </button>
          </div>
        </div>

        <div className="phone-ribbon-deck" role="toolbar" aria-label={`${phoneTabLabel(selectedTab)} commands`}>
          {visibleGroups.map((group) => (
            <div className="phone-ribbon-group" key={group.id} aria-label={group.label}>
              <div className="phone-ribbon-commands">
                {group.commands.map((command) => (
                  <PhoneCommand
                    key={command.id}
                    command={command}
                    ghostEnabled={props.phoneGhost.enabled}
                    onInvoke={invoke}
                  />
                ))}
              </div>
              <span className="phone-ribbon-group-label">{group.label}</span>
            </div>
          ))}
          {selectedTab?.id === 'view' && (
            <div className="phone-ribbon-group" aria-label="Presence">
              <div className="phone-ribbon-commands">
                {(['exact', 'section', 'off'] as const).map((value) => (
                  <button key={value} type="button" className={presenceDisplay === value ? 'active' : undefined} aria-pressed={presenceDisplay === value} onClick={() => changePresence(value)}>
                    <Glyph name={value === 'off' ? 'clear' : value === 'exact' ? 'find' : 'outline'} size={22} />
                    <span>{value[0].toUpperCase() + value.slice(1)}</span>
                  </button>
                ))}
              </div>
              <span className="phone-ribbon-group-label">Presence</span>
            </div>
          )}
        </div>
        <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</span>
      </section>
    </div>
  );
}

function withoutModeCommands(groups: ProjectedCommandGroup[]): ProjectedCommandGroup[] {
  return groups.flatMap((group) => {
    const commands = group.commands.filter((command) => !PHONE_MODE_COMMANDS.has(command.id));
    return commands.length ? [{ ...group, commands }] : [];
  });
}

function orderTabs(tabs: ProjectedRibbonTab[]): ProjectedRibbonTab[] {
  return [...tabs].sort((a, b) => {
    const aIndex = PHONE_TAB_ORDER.indexOf(a.id);
    const bIndex = PHONE_TAB_ORDER.indexOf(b.id);
    return (aIndex < 0 ? Number.MAX_SAFE_INTEGER : aIndex) -
      (bIndex < 0 ? Number.MAX_SAFE_INTEGER : bIndex);
  });
}

function phoneTabLabel(tab: ProjectedRibbonTab | undefined): string {
  if (!tab) return 'Commands';
  return tab.id === 'import' ? 'Start' : tab.label;
}

function tabGlyph(tab: RibbonTabId) {
  if (tab === 'import') return 'startTemplate' as const;
  if (tab === 'login') return 'share' as const;
  if (tab === 'home') return 'pencil' as const;
  if (tab === 'insert') return 'plus' as const;
  if (tab === 'review') return 'gauge' as const;
  if (tab === 'view') return 'eye' as const;
  if (tab === 'file') return 'file' as const;
  if (tab === 'picture') return 'image' as const;
  if (tab === 'table') return 'table' as const;
  if (tab === 'shape') return 'rect' as const;
  if (tab === 'draw') return 'painter' as const;
  return 'sparkles' as const;
}

function PhoneCommand({
  command,
  ghostEnabled,
  onInvoke,
}: {
  command: ProjectedCommand;
  ghostEnabled: boolean;
  onInvoke: (command: ProjectedCommand) => void;
}) {
  const ghost = command.id === 'view.ghost-overlay';
  const status = ghost ? ghostEnabled ? 'On' : 'Off' : null;
  return (
    <button
      type="button"
      className={`${command.pressed ? 'active ' : ''}${command.contextual ? 'contextual ' : ''}${command.agentRaised ? 'agent-raised' : ''}`.trim()}
      data-command-id={command.id}
      disabled={!command.enabled}
      aria-pressed={command.pressed}
      aria-haspopup={ghost ? 'dialog' : undefined}
      aria-label={status ? `${command.label}, ${status}` : undefined}
      title={command.unavailableReason ?? command.description}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => onInvoke(command)}
    >
      <Glyph name={command.glyph} size={22} />
      <span>{command.label}</span>
      {status && <small className="phone-command-status">{status}</small>}
    </button>
  );
}
