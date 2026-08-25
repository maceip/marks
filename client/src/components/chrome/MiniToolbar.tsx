import type { EditorView } from '@codemirror/view';
import { useCommandCenter } from '../../commands/context';
import { ribbonTask } from '../../commands/projection.ts';
import { Glyph } from '../glyphs/Glyph';

interface MiniToolbarProps {
  selected: number;
  disabled?: boolean;
  getView: () => EditorView | null;
}

export function MiniToolbar({ selected, disabled: _disabled, getView: _getView }: MiniToolbarProps) {
  const center = useCommandCenter();
  if (selected <= 0 || ribbonTask(center.environment) === 'inspect') return null;
  const commands = center.commands('mini');

  return (
    <div className="mini-toolbar" role="toolbar" aria-label="Selection formatting">
      {commands.map((command) => (
        <button
          key={command.id}
          type="button"
          className={`${command.pressed ? 'active ' : ''}${__MARKS_FEATURES__.agentChat && command.agentRaised ? 'agent-raised' : ''}`.trim() || undefined}
          data-command-id={command.id}
          title={command.unavailableReason ?? command.description}
          aria-label={command.label}
          aria-pressed={command.pressed}
          disabled={!command.enabled}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => void center.invoke(command.id)}
        >
          <Glyph name={command.glyph} size={18} />
        </button>
      ))}
      <span>{selected} selected</span>
    </div>
  );
}
