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
import type { ProjectedCommand, ProjectedRibbonTab, RibbonTabId } from '../../commands/types.ts';
import type { Posture } from '../../lib/posture';
import type { UiActionId } from '../../lib/ui-actions';
import type { ViewMode } from '../shell/TopBar';
import { Glyph } from '../glyphs/Glyph';
import { SurfaceMaterial } from '../ui/SurfaceMaterial';

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
  onVoice?: () => void;
  voiceActive?: boolean;
  voiceSupported?: boolean;
  onNotify?: (title: string, detail?: string, tone?: 'neutral' | 'success' | 'danger') => void;
  temporary?: boolean;
}

const PHONE_TAB_ORDER: RibbonTabId[] = [
  'home', 'insert', 'review', 'view', 'file', 'draw', 'tools', 'picture', 'table', 'shape',
];

/** The phone presentation consumes the exact same projected tabs, groups,
 * availability, feature flags, and agent-raised state as DesktopRibbon. */
export function PhoneComposer(props: PhoneComposerProps) {
  const center = useCommandCenter();
  const task = ribbonTask(center.environment);
  const tabs = useMemo(() => orderTabs(center.ribbon), [center.ribbon]);
  const [tab, setTab] = useState<RibbonTabId>(() => task === 'inspect' ? 'view' : 'home');
  const [presenceDisplay, setPresenceState] = useState<DocumentPresenceDisplay>(() =>
    getPresenceDisplay(props.mode === 'preview'));
  const lastManualTabAt = useRef(0);
  const previousTask = useRef(task);
  const selectedTab = tabs.find((candidate) => candidate.id === tab) ?? tabs[0];

  useEffect(() => {
    const sync = () => setPresenceState(getPresenceDisplay(props.mode === 'preview'));
    sync();
    window.addEventListener(PRESENCE_DISPLAY_EVENT, sync);
    return () => window.removeEventListener(PRESENCE_DISPLAY_EVENT, sync);
  }, [props.mode]);

  useEffect(() => {
    if (previousTask.current === task) return;
    previousTask.current = task;
    const preferred = task === 'inspect' ? tabs.find((candidate) => candidate.id === 'view') : tabs.find((candidate) => candidate.id === 'home');
    if (preferred) setTab(preferred.id);
  }, [tabs, task]);

  useEffect(() => {
    const contextual = tabs.find((candidate) => candidate.contextual);
    if (!contextual || Date.now() - lastManualTabAt.current < 2500) return;
    setTab(contextual.id);
  }, [center.environment.context, tabs]);

  useEffect(() => {
    const active = center.runs.findLast((run) =>
      (run.source === 'agent' || run.source === 'bridge') &&
      (run.status === 'proposed' || run.status === 'awaiting-approval' || run.status === 'running'));
    if (!active || Date.now() - lastManualTabAt.current < 4500) return;
    const destination = tabs.find((candidate) => candidate.groups.some((group) =>
      group.commands.some((command) => command.id === active.commandId)));
    if (destination) setTab(destination.id);
  }, [center.runs, tabs]);

  const invoke = (command: ProjectedCommand) => {
    if (command.enabled) void center.invoke(command.id);
  };
  const selectTab = (id: RibbonTabId) => {
    lastManualTabAt.current = Date.now();
    setTab(id);
  };
  const changePresence = (value: DocumentPresenceDisplay) => {
    setPresenceDisplay(value);
    setPresenceState(value);
  };

  return (
    <div className={`phone-composer${props.posture.keyboardOpen ? ' keyboard-open' : ''}`} data-command-context={center.environment.context} data-ribbon-task={task}>
      {props.temporary && (
        <button type="button" className="phone-identity" data-command-id="identity.keep" onClick={() => {
          const keep = tabs.flatMap((item) => item.groups).flatMap((group) => group.commands).find((command) => command.id === 'identity.keep');
          if (keep) invoke(keep);
        }}>
          <span>Not logged in</span>
          This document will be lost unless you log in.
        </button>
      )}

      <section className="phone-ribbon surface-material-host" aria-label="Mobile ribbon">
        <SurfaceMaterial variant="chrome" modifier="subtle" />
        <div className="phone-ribbon-deck" role="toolbar" aria-label={`${phoneTabLabel(selectedTab)} commands`}>
          {selectedTab?.groups.map((group) => (
            <div className="phone-ribbon-group" key={group.id} aria-label={group.label}>
              <div className="phone-ribbon-commands">
                {group.commands.map((command) => <PhoneCommand key={command.id} command={command} onInvoke={invoke} />)}
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

        <div className="phone-ribbon-tabs" role="tablist" aria-label="Ribbon tasks">
          {tabs.map((item) => (
            <button key={item.id} type="button" role="tab" aria-selected={selectedTab?.id === item.id} className={`${selectedTab?.id === item.id ? 'active ' : ''}${item.contextual ? 'contextual ' : ''}${item.agentRaised ? 'agent-raised' : ''}`.trim()} onClick={() => selectTab(item.id)}>
              <Glyph name={tabGlyph(item.id)} size={19} />
              <span>{phoneTabLabel(item)}</span>
              {item.agentRaised && <i className="agent-tab-dot" aria-label="Agent-relevant commands" />}
            </button>
          ))}
          <button type="button" className="phone-ribbon-all" aria-pressed={center.profile.expanded} title={center.profile.expanded ? 'Show essential ribbon tasks' : 'Show every ribbon task and command'} onClick={() => center.setExpanded(!center.profile.expanded)}>
            <Glyph name={center.profile.expanded ? 'shrink' : 'more'} size={19} />
            <span>{center.profile.expanded ? 'Essentials' : 'All'}</span>
          </button>
        </div>
      </section>
    </div>
  );
}

function orderTabs(tabs: ProjectedRibbonTab[]): ProjectedRibbonTab[] {
  return [...tabs].sort((a, b) => PHONE_TAB_ORDER.indexOf(a.id) - PHONE_TAB_ORDER.indexOf(b.id));
}

function phoneTabLabel(tab: ProjectedRibbonTab | undefined): string {
  if (!tab) return 'Commands';
  return tab.id === 'file' ? 'More' : tab.label;
}

function tabGlyph(tab: RibbonTabId) {
  if (tab === 'home') return 'pencil' as const;
  if (tab === 'insert') return 'plus' as const;
  if (tab === 'review') return 'gauge' as const;
  if (tab === 'view') return 'eye' as const;
  if (tab === 'file') return 'more' as const;
  if (tab === 'picture') return 'image' as const;
  if (tab === 'table') return 'table' as const;
  if (tab === 'shape') return 'rect' as const;
  if (tab === 'draw') return 'painter' as const;
  return 'sparkles' as const;
}

function PhoneCommand({ command, onInvoke }: { command: ProjectedCommand; onInvoke: (command: ProjectedCommand) => void }) {
  return (
    <button type="button" className={`${command.pressed ? 'active ' : ''}${command.contextual ? 'contextual ' : ''}${command.agentRaised ? 'agent-raised' : ''}`.trim()} data-command-id={command.id} disabled={!command.enabled} aria-pressed={command.pressed} title={command.unavailableReason ?? command.description} onMouseDown={(event) => event.preventDefault()} onClick={() => onInvoke(command)}>
      <Glyph name={command.glyph} size={22} />
      <span>{command.label}</span>
    </button>
  );
}
