import { useEffect, useMemo, useState } from 'react';
import { useCommandCenter } from '../../commands/context';
import type { ProjectedCommand } from '../../commands/types.ts';
import type { Posture } from '../../lib/posture';
import { Glyph } from '../glyphs/Glyph';
import { SurfaceMaterial } from '../ui/SurfaceMaterial';

interface FoldableRibbonProps {
  posture: Posture;
}

type FoldTask = 'compose' | 'inspect';

const COMPOSE_IDS = [
  'format.bold',
  'format.italic',
  'format.heading-2',
  'paragraph.bullets',
  'paragraph.tasks',
  'format.inline-code',
  'insert.link',
  'insert.picture-file',
  'insert.table',
  'tools.draft',
  'tools.front-matter',
  'tools.structure',
  'tools.paste-intent',
  'insert.cross-document-block',
] as const;

const INSPECT_IDS = [
  'view.editor',
  'view.split',
  'view.preview',
  'view.outline',
  'review.comments',
  'review.history',
  'review.document-health',
  'review.accessibility',
  'review.privacy-exposure',
  'review.quality-contract',
  'view.reader-simulation',
  'review.link-intelligence',
  'review.task-decision-ledger',
  'document.share',
  'document.export-markdown',
  'document.print',
  'view.theme',
] as const;

const MAX_PRIMARY = 7;
const MAX_COMPANION = 6;

/**
 * A foldable is not a wide phone or a narrow desktop. This projection keeps
 * every hit target on one physical segment and uses the companion segment for
 * reading/review actions instead of stretching controls across the hinge.
 */
export function FoldableRibbon({ posture }: FoldableRibbonProps) {
  const center = useCommandCenter();
  const [task, setTask] = useState<FoldTask>(() =>
    center.environment.mode === 'preview' ? 'inspect' : 'compose');
  const [moreOpen, setMoreOpen] = useState(false);
  const available = useMemo(
    () => new Map(center.commands('foldable').map((command) => [command.id, command])),
    [center],
  );
  const raised = [...available.values()].filter((command) => command.agentRaised);
  const raisedTask = raised.length
    ? raised.some((command) => command.modes?.includes('preview')) ? 'inspect' : 'compose'
    : null;
  const contextual = [...available.values()].filter((command) => command.contextual);
  const compose = uniqueCommands([
    ...raised,
    ...contextual,
    ...COMPOSE_IDS.flatMap((id) => available.get(id) ?? []),
  ]);
  const inspect = uniqueCommands([
    ...raised,
    ...INSPECT_IDS.flatMap((id) => available.get(id) ?? []),
  ]);
  const current = task === 'compose' ? compose : inspect;
  const primary = current.slice(0, MAX_PRIMARY);
  const companion = task === 'compose'
    ? inspect.slice(0, MAX_COMPANION)
    : compose.slice(0, MAX_COMPANION);
  const contextualLabel = contextual.length
    ? `${capitalize(center.environment.context)} selected`
    : center.environment.mode === 'preview' ? 'Rendered document' : 'Markdown source';

  useEffect(() => {
    if (center.environment.mode === 'preview') setTask('inspect');
  }, [center.environment.mode]);

  useEffect(() => {
    if (raisedTask) setTask(raisedTask);
  }, [raisedTask]);

  const invoke = (command: ProjectedCommand) => {
    if (!command.enabled) return;
    void center.invoke(command.id).then(() => setMoreOpen(false));
  };

  return (
    <div
      className={`fold-ribbon fold-ribbon-${posture.hinge}`}
      data-command-context={center.environment.context}
      data-agent-active={raised.length ? 'true' : undefined}
    >
      <section className="fold-ribbon-segment fold-ribbon-primary" aria-label="Foldable primary commands">
        <SurfaceMaterial variant="chrome" intensity={0.92} />
        <header className="fold-ribbon-head">
          <div role="tablist" aria-label="Foldable ribbon tasks">
            <button type="button" role="tab" aria-selected={task === 'compose'} onClick={() => setTask('compose')}>Compose</button>
            <button type="button" role="tab" aria-selected={task === 'inspect'} onClick={() => setTask('inspect')}>Read & review</button>
          </div>
          <span>{contextualLabel}</span>
        </header>
        <div className="fold-command-rail" role="toolbar" aria-label={`${task === 'compose' ? 'Compose' : 'Read and review'} commands`}>
          {primary.map((command) => <FoldCommand key={command.id} command={command} onInvoke={invoke} />)}
          <button
            type="button"
            className="fold-command fold-more"
            aria-haspopup="dialog"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen((open) => !open)}
          >
            <Glyph name="more" size={21} />
            <span>More</span>
          </button>
        </div>
      </section>

      {posture.hinge === 'vertical' && <div className="fold-ribbon-hinge" aria-hidden="true" />}

      <section className="fold-ribbon-segment fold-ribbon-companion" aria-label="Foldable companion commands">
        <SurfaceMaterial variant="chrome" intensity={0.86} />
        <header className="fold-ribbon-head">
          <strong>{task === 'compose' ? 'Companion' : 'Quick compose'}</strong>
          <span>{raised.length ? 'Agent-directed' : posture.hinge === 'vertical' ? 'Second screen' : 'Lower touch shelf'}</span>
        </header>
        <div className="fold-command-rail" role="toolbar" aria-label="Companion commands">
          {companion.map((command) => <FoldCommand key={command.id} command={command} onInvoke={invoke} />)}
        </div>
      </section>

      {moreOpen && (
        <div className="fold-command-library surface-material-host" role="dialog" aria-modal="false" aria-label="All foldable commands">
          <SurfaceMaterial variant="floating" intensity={1.08} />
          <header>
            <div>
              <strong>Command library</strong>
              <span>Available for this role and view</span>
            </div>
            <button type="button" className="icon-button" aria-label="Close command library" onClick={() => setMoreOpen(false)}>
              <Glyph name="clear" size={16} />
            </button>
          </header>
          <div>
            {[...available.values()].map((command) => (
              <FoldCommand key={command.id} command={command} onInvoke={invoke} detailed />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function FoldCommand({ command, onInvoke, detailed = false }: {
  command: ProjectedCommand;
  onInvoke: (command: ProjectedCommand) => void;
  detailed?: boolean;
}) {
  const center = useCommandCenter();
  const run = center.runs.findLast((candidate) => candidate.commandId === command.id &&
    (candidate.status === 'proposed' || candidate.status === 'awaiting-approval' || candidate.status === 'running'));
  return (
    <button
      type="button"
      className={`fold-command${command.pressed ? ' active' : ''}${command.contextual ? ' contextual' : ''}${command.agentRaised ? ' agent-raised' : ''}${run ? ` agent-${run.status}` : ''}${detailed ? ' detailed' : ''}`}
      data-command-id={command.id}
      data-agent-state={run?.status}
      disabled={!command.enabled}
      aria-pressed={command.pressed}
      aria-busy={run?.status === 'running' || undefined}
      title={command.unavailableReason ?? command.description}
      onPointerDown={(event) => event.preventDefault()}
      onClick={() => onInvoke(command)}
    >
      <Glyph name={command.glyph} size={detailed ? 20 : 22} />
      <span>{command.label}</span>
      {detailed && <small>{command.unavailableReason ?? command.description}</small>}
    </button>
  );
}

function uniqueCommands(commands: ProjectedCommand[]): ProjectedCommand[] {
  const seen = new Set<string>();
  return commands.filter((command) => {
    if (seen.has(command.id)) return false;
    seen.add(command.id);
    return true;
  });
}

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}
