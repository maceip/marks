import { useEffect, useMemo, useState } from 'react';
import type { EditorView } from '@codemirror/view';
import {
  getPresenceDisplay,
  PRESENCE_DISPLAY_EVENT,
  setPresenceDisplay,
  type DocumentPresenceDisplay,
} from '../../collab/presence-display';
import type { CollabSession } from '../../collab/types';
import { useCommandCenter } from '../../commands/context';
import type { ProjectedCommand } from '../../commands/types.ts';
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

type PhoneSheet = 'insert' | 'review' | 'more' | null;

const FORMAT_IDS = [
  'format.bold',
  'format.italic',
  'format.heading-2',
  'paragraph.bullets',
  'paragraph.tasks',
  'format.inline-code',
] as const;

const INSERT_IDS = [
  'insert.picture-file',
  'insert.picture-url',
  'insert.link',
  'insert.table',
  'insert.shape-rect',
  'insert.callout-info',
  'insert.math',
  'insert.mermaid',
  'insert.code-block',
  'review.comments',
] as const;

const REVIEW_IDS = [
  'review.document-health',
  'review.render-diagnostics',
  'review.accessibility',
  'review.privacy-exposure',
  'review.quality-contract',
  'view.reader-simulation',
  'review.link-intelligence',
  'review.citation-ledger',
  'review.task-decision-ledger',
  'review.collaboration-console',
  'document.recovery',
  'review.version-compare',
  'tools.front-matter',
  'document.publish-profile',
  'tools.structure',
  'tools.asset-inspector',
  'tools.paste-intent',
  'insert.cross-document-block',
] as const;

const MORE_IDS = [
  'document.new',
  'identity.keep',
  'identity.account',
  'identity.pairing',
  'identity.sign-out',
  'document.templates',
  'document.import',
  'document.rename',
  'document.export-markdown',
  'document.export-bundle',
  'document.share',
  'edit.find',
  'view.outline',
  'review.history',
  'workspace.trash',
  'view.preferences',
  'document.delete',
] as const;

export function PhoneComposer(props: PhoneComposerProps) {
  const center = useCommandCenter();
  const [sheet, setSheet] = useState<PhoneSheet>(null);
  const [presenceDisplay, setPresenceState] = useState<DocumentPresenceDisplay>(() =>
    getPresenceDisplay(props.mode === 'preview'));
  const available = useMemo(
    () => new Map(center.commands('phone').map((command) => [command.id, command])),
    [center],
  );
  const contextual = [...available.values()].filter((command) => command.contextual);
  const format = FORMAT_IDS.flatMap((id) => available.get(id) ?? []);
  const insert = INSERT_IDS.flatMap((id) => available.get(id) ?? []);
  const review = REVIEW_IDS.flatMap((id) => available.get(id) ?? []);
  const more = MORE_IDS.flatMap((id) => available.get(id) ?? []);
  const writing = center.environment.mode !== 'preview';
  const editMode = available.get('view.editor');
  const previewMode = available.get('view.preview');
  const tools = available.get('tools.draft');
  const sheetTitle = sheet === 'insert'
    ? 'Insert'
    : sheet === 'review'
      ? 'Document intelligence'
      : 'Page';

  useEffect(() => {
    const sync = () => setPresenceState(getPresenceDisplay(props.mode === 'preview'));
    sync();
    window.addEventListener(PRESENCE_DISPLAY_EVENT, sync);
    return () => window.removeEventListener(PRESENCE_DISPLAY_EVENT, sync);
  }, [props.mode]);

  const invoke = (command: ProjectedCommand) => {
    if (!command.enabled) return;
    void center.invoke(command.id).then(() => setSheet(null));
  };

  return (
    <div className={`phone-composer${props.posture.keyboardOpen ? ' keyboard-open' : ''}`} data-command-context={center.environment.context}>
      {props.temporary && (
        <button type="button" className="phone-identity" data-command-id="identity.keep" onClick={() => {
          const keep = available.get('identity.keep');
          if (keep) invoke(keep);
        }}>
          <span>Temporary</span>
          Closing this tab is unrecoverable until you keep it.
        </button>
      )}

      {writing && (
        <div className="phone-format-chips" role="toolbar" aria-label={contextual.length ? `${center.environment.context} tools and quick format` : 'Quick format'}>
          {contextual.map((command) => (
            <PhoneChip key={command.id} command={command} contextual onInvoke={invoke} />
          ))}
          {format.map((command) => (
            <PhoneChip key={command.id} command={command} onInvoke={invoke} />
          ))}
          {tools && <PhoneChip command={tools} onInvoke={invoke} />}
          {available.get('input.dictate') && <PhoneChip command={available.get('input.dictate')!} onInvoke={invoke} />}
        </div>
      )}

      {sheet && (
        <div className="phone-sheet-layer">
          <button type="button" className="phone-sheet-scrim" aria-label="Close sheet" onClick={() => setSheet(null)} />
          <div className="phone-sheet surface-material-host" role="dialog" aria-label={`${sheetTitle} commands`}>
            <SurfaceMaterial variant="floating" modifier="emphasized" />
            <header>
              <h2>{sheetTitle}</h2>
              <button type="button" className="icon-button" aria-label="Close" onClick={() => setSheet(null)}>
                <Glyph name="clear" size={16} interactive={false} />
              </button>
            </header>
            <div className="phone-sheet-grid">
              {sheet === 'more' && (['exact', 'section', 'off'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={presenceDisplay === value}
                  onClick={() => {
                    setPresenceDisplay(value);
                    setPresenceState(value);
                    setSheet(null);
                  }}
                >
                  <Glyph name={value === 'off' ? 'clear' : value === 'exact' ? 'find' : 'outline'} size={28} />
                  <span>Presence: {value}</span>
                </button>
              ))}
              {(sheet === 'insert' ? insert : sheet === 'review' ? review : more).map((command) => (
                <PhoneSheetCommand key={command.id} command={command} onInvoke={invoke} />
              ))}
            </div>
          </div>
        </div>
      )}

      <nav className="phone-nav surface-material-host" aria-label="Phone composer">
        <SurfaceMaterial variant="chrome" modifier="subtle" />
        {editMode && (
          <PhoneNavCommand command={editMode} label="Write" active={writing} onInvoke={invoke} />
        )}
        {previewMode && (
          <PhoneNavCommand command={previewMode} label="Preview" active={!writing} onInvoke={invoke} />
        )}
        <button type="button" className={sheet === 'insert' ? 'active' : undefined} onClick={() => setSheet((current) => current === 'insert' ? null : 'insert')}>
          <Glyph name="plus" size={22} />
          <span>Insert</span>
        </button>
        <button type="button" className={sheet === 'review' ? 'active' : undefined} onClick={() => setSheet((current) => current === 'review' ? null : 'review')}>
          <Glyph name="gauge" size={22} />
          <span>Review</span>
        </button>
        <button type="button" className={sheet === 'more' ? 'active' : undefined} onClick={() => setSheet((current) => current === 'more' ? null : 'more')}>
          <Glyph name="more" size={22} />
          <span>More</span>
        </button>
      </nav>
    </div>
  );
}

function PhoneChip({ command, contextual, onInvoke }: {
  command: ProjectedCommand;
  contextual?: boolean;
  onInvoke: (command: ProjectedCommand) => void;
}) {
  return (
    <button
      type="button"
      className={`${command.pressed ? 'active ' : ''}${contextual ? 'contextual ' : ''}${command.agentRaised ? 'agent-raised' : ''}`.trim() || undefined}
      data-command-id={command.id}
      disabled={!command.enabled}
      title={command.unavailableReason ?? command.description}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => onInvoke(command)}
    >
      <Glyph name={command.glyph} size={20} />
      <span>{command.label.replace('Heading 2', 'Heading').replace('Inline code', 'Code').replace('Draft tools', 'Tools')}</span>
    </button>
  );
}

function PhoneSheetCommand({ command, onInvoke }: { command: ProjectedCommand; onInvoke: (command: ProjectedCommand) => void }) {
  return (
    <button
      type="button"
      className={command.agentRaised ? 'agent-raised' : undefined}
      data-command-id={command.id}
      disabled={!command.enabled}
      title={command.unavailableReason ?? command.description}
      onClick={() => onInvoke(command)}
    >
      <Glyph name={command.glyph} size={28} />
      <span>{command.label}</span>
      {!command.enabled && command.unavailableReason && <small>{command.unavailableReason}</small>}
    </button>
  );
}

function PhoneNavCommand({ command, label, active, onInvoke }: {
  command: ProjectedCommand;
  label: string;
  active: boolean;
  onInvoke: (command: ProjectedCommand) => void;
}) {
  return (
    <button
      type="button"
      className={`${active ? 'active ' : ''}${command.agentRaised ? 'agent-raised' : ''}`.trim() || undefined}
      data-command-id={command.id}
      disabled={!command.enabled}
      onClick={() => onInvoke(command)}
    >
      <Glyph name={command.glyph} size={22} />
      <span>{label}</span>
    </button>
  );
}
