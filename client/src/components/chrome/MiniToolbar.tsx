import type { EditorView } from '@codemirror/view';
import type { StateCommand } from '@codemirror/state';
import {
  insertLink,
  toggleBold,
  toggleHighlight,
  toggleInlineCode,
  toggleItalic,
} from '../../editor/commands';
import { Glyph, type GlyphName } from '../glyphs/Glyph';

interface MiniToolbarProps {
  selected: number;
  disabled?: boolean;
  getView: () => EditorView | null;
}

const ACTIONS: Array<{ glyph: GlyphName; label: string; command: StateCommand }> = [
  { glyph: 'bold', label: 'Bold', command: toggleBold },
  { glyph: 'italic', label: 'Italic', command: toggleItalic },
  { glyph: 'highlight', label: 'Highlight', command: toggleHighlight },
  { glyph: 'code', label: 'Inline code', command: toggleInlineCode },
  { glyph: 'link', label: 'Link', command: insertLink },
];

export function MiniToolbar({ selected, disabled, getView }: MiniToolbarProps) {
  if (selected <= 0) return null;

  const run = (command: StateCommand) => {
    const view = getView();
    if (!view || disabled) return;
    command(view);
    view.focus();
  };

  return (
    <div className="mini-toolbar" role="toolbar" aria-label="Selection formatting">
      {ACTIONS.map((action) => (
        <button
          key={action.label}
          type="button"
          title={action.label}
          aria-label={action.label}
          disabled={disabled}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => run(action.command)}
        >
          <Glyph name={action.glyph} size={18} />
        </button>
      ))}
      <span>{selected} selected</span>
    </div>
  );
}
