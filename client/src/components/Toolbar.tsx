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

export type RibbonSection = 'home' | 'insert';

interface ToolbarProps {
  getView: () => EditorView | null;
  section: RibbonSection;
  disabled?: boolean;
  onVoice?: () => void;
  voiceActive?: boolean;
  voiceSupported?: boolean;
}

interface Action {
  icon: keyof typeof icons;
  label: string;
  shortcut?: string;
  command: StateCommand;
}

interface ActionGroup {
  label: string;
  actions: Action[];
}

const HOME_GROUPS: ActionGroup[] = [
  {
    label: 'Text style',
    actions: [
      { icon: 'heading', label: 'Heading', shortcut: 'Mod+1', command: setHeading(2) },
      { icon: 'bold', label: 'Bold', shortcut: 'Mod+B', command: toggleBold },
      { icon: 'italic', label: 'Italic', shortcut: 'Mod+I', command: toggleItalic },
      {
        icon: 'strikethrough',
        label: 'Strike',
        shortcut: 'Mod+Shift+X',
        command: toggleStrikethrough,
      },
      {
        icon: 'highlight',
        label: 'Highlight',
        shortcut: 'Mod+Shift+H',
        command: toggleHighlight,
      },
      { icon: 'code', label: 'Inline code', shortcut: 'Mod+E', command: toggleInlineCode },
    ],
  },
  {
    label: 'Structure',
    actions: [
      { icon: 'list', label: 'Bullets', shortcut: 'Mod+Shift+8', command: toggleBullet },
      {
        icon: 'numbered',
        label: 'Numbered',
        shortcut: 'Mod+Shift+7',
        command: toggleNumbered,
      },
      { icon: 'task', label: 'Tasks', shortcut: 'Mod+Shift+9', command: toggleTask },
      { icon: 'quote', label: 'Quote', shortcut: 'Mod+Shift+.', command: toggleQuote },
    ],
  },
];

const INSERT_GROUPS: ActionGroup[] = [
  {
    label: 'References',
    actions: [
      { icon: 'link', label: 'Link', shortcut: 'Mod+K', command: insertLink },
      { icon: 'image', label: 'Image', command: insertImage },
    ],
  },
  {
    label: 'Blocks',
    actions: [
      { icon: 'table', label: 'Table', command: insertTable },
      { icon: 'code', label: 'Code block', command: insertCodeBlock },
      { icon: 'hr', label: 'Divider', command: insertHorizontalRule },
    ],
  },
];

const isMac = typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/.test(navigator.platform);

function shortcutLabel(shortcut?: string): string {
  if (!shortcut) return '';
  return ` (${shortcut.replace('Mod', isMac ? '⌘' : 'Ctrl')})`;
}

export function Toolbar({ getView, section, disabled, onVoice, voiceActive, voiceSupported }: ToolbarProps) {
  const groups = section === 'home' ? HOME_GROUPS : INSERT_GROUPS;

  const run = (command: StateCommand) => {
    const view = getView();
    if (!view) return;
    command(view);
    view.focus();
  };

  return (
    <div className="toolbar ribbon-toolbar ribbon-deck-enter" role="toolbar" aria-label={`${section} commands`}>
      {groups.map((group) => (
        <div className="ribbon-command-group" key={group.label}>
          <div className="ribbon-command-row">
            {group.actions.map((action) => (
              <button
                key={action.label}
                type="button"
                className="ribbon-command"
                title={`${action.label}${shortcutLabel(action.shortcut)}`}
                aria-label={action.label}
                disabled={disabled}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => run(action.command)}
              >
                <Icon path={icons[action.icon]} />
                <span className="ribbon-command-label">{action.label}</span>
              </button>
            ))}
          </div>
          <span className="ribbon-group-label">{group.label}</span>
        </div>
      ))}
      {section === 'home' && (
        <div className="ribbon-command-group">
          <div className="ribbon-command-row">
            <button
              type="button"
              className={`ribbon-command${voiceActive ? ' active' : ''}`}
              title={voiceSupported ? 'Voice input (Ctrl+Shift+S)' : 'Voice input is not supported by this browser'}
              aria-label="Voice input"
              aria-pressed={voiceActive}
              disabled={disabled || !voiceSupported || !onVoice}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onVoice?.()}
            >
              <Icon path={icons.mic} />
              <span className="ribbon-command-label">Dictate</span>
            </button>
          </div>
          <span className="ribbon-group-label">Input</span>
        </div>
      )}
    </div>
  );
}
