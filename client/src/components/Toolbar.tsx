import type { EditorView } from '@codemirror/view';
import type { StateCommand } from '@codemirror/state';
import {
  insertCodeBlock,
  insertHorizontalRule,
  insertImage,
  insertLink,
  insertTable,
  setHeading,
  toggleBold,
  toggleBullet,
  toggleHighlight,
  toggleInlineCode,
  toggleItalic,
  toggleNumbered,
  toggleQuote,
  toggleStrikethrough,
  toggleTask,
} from '../editor/commands';
import { Icon, icons } from './Icon';

interface ToolbarProps {
  getView: () => EditorView | null;
}

interface Action {
  icon: keyof typeof icons;
  label: string;
  shortcut?: string;
  command: StateCommand;
}

const GROUPS: Action[][] = [
  [
    { icon: 'heading', label: 'Heading', shortcut: 'Mod+1', command: setHeading(2) },
    { icon: 'bold', label: 'Bold', shortcut: 'Mod+B', command: toggleBold },
    { icon: 'italic', label: 'Italic', shortcut: 'Mod+I', command: toggleItalic },
    { icon: 'strikethrough', label: 'Strikethrough', shortcut: 'Mod+Shift+X', command: toggleStrikethrough },
    { icon: 'highlight', label: 'Highlight', shortcut: 'Mod+Shift+H', command: toggleHighlight },
  ],
  [
    { icon: 'link', label: 'Link', shortcut: 'Mod+K', command: insertLink },
    { icon: 'image', label: 'Image', command: insertImage },
    { icon: 'code', label: 'Inline code', shortcut: 'Mod+E', command: toggleInlineCode },
    { icon: 'table', label: 'Table', command: insertTable },
  ],
  [
    { icon: 'list', label: 'Bullet list', shortcut: 'Mod+Shift+8', command: toggleBullet },
    { icon: 'numbered', label: 'Numbered list', shortcut: 'Mod+Shift+7', command: toggleNumbered },
    { icon: 'task', label: 'Task list', shortcut: 'Mod+Shift+9', command: toggleTask },
    { icon: 'quote', label: 'Quote', shortcut: 'Mod+Shift+.', command: toggleQuote },
  ],
  [
    { icon: 'code', label: 'Code block', command: insertCodeBlock },
    { icon: 'hr', label: 'Divider', command: insertHorizontalRule },
  ],
];

const isMac = typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/.test(navigator.platform);

function shortcutLabel(shortcut?: string): string {
  if (!shortcut) return '';
  return ` (${shortcut.replace('Mod', isMac ? '⌘' : 'Ctrl')})`;
}

export function Toolbar({ getView }: ToolbarProps) {
  const run = (command: StateCommand) => {
    const view = getView();
    if (!view) return;
    command(view);
    view.focus();
  };

  return (
    <div className="toolbar" role="toolbar" aria-label="Formatting">
      {GROUPS.map((group, index) => (
        <div className="toolbar-group" key={index}>
          {group.map((action) => (
            <button
              key={action.label}
              type="button"
              className="toolbar-button"
              title={`${action.label}${shortcutLabel(action.shortcut)}`}
              aria-label={action.label}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => run(action.command)}
            >
              <Icon path={icons[action.icon]} />
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
