import { EditorSelection, type ChangeSpec, type StateCommand } from '@codemirror/state';
import type { EditorView, KeyBinding } from '@codemirror/view';

/** Wrap or unwrap each selection range with a marker, e.g. `**bold**`. */
export function toggleWrap(marker: string, placeholder = ''): StateCommand {
  return ({ state, dispatch }) => {
    const changes = state.changeByRange((range) => {
      const width = marker.length;
      const before = state.sliceDoc(Math.max(0, range.from - width), range.from);
      const after = state.sliceDoc(range.to, Math.min(state.doc.length, range.to + width));

      // Already wrapped: strip the markers instead of nesting them.
      if (before === marker && after === marker) {
        return {
          changes: [
            { from: range.from - width, to: range.from },
            { from: range.to, to: range.to + width },
          ],
          range: EditorSelection.range(range.from - width, range.to - width),
        };
      }

      const selected = state.sliceDoc(range.from, range.to) || placeholder;
      return {
        changes: { from: range.from, to: range.to, insert: `${marker}${selected}${marker}` },
        range: range.empty
          ? EditorSelection.range(range.from + width, range.from + width + placeholder.length)
          : EditorSelection.range(range.from + width, range.from + width + selected.length),
      };
    });

    dispatch(state.update(changes, { scrollIntoView: true, userEvent: 'input.format' }));
    return true;
  };
}

/** Add, swap or remove a line prefix across every selected line. */
export function toggleLinePrefix(prefix: string, pattern: RegExp): StateCommand {
  return ({ state, dispatch }) => {
    const changes: ChangeSpec[] = [];
    const seen = new Set<number>();

    for (const range of state.selection.ranges) {
      const first = state.doc.lineAt(range.from).number;
      const last = state.doc.lineAt(range.to).number;

      for (let number = first; number <= last; number++) {
        if (seen.has(number)) continue;
        seen.add(number);

        const line = state.doc.line(number);
        const existing = pattern.exec(line.text);

        if (existing && existing[0] === prefix) {
          changes.push({ from: line.from, to: line.from + existing[0].length });
        } else if (existing) {
          changes.push({ from: line.from, to: line.from + existing[0].length, insert: prefix });
        } else {
          changes.push({ from: line.from, insert: prefix });
        }
      }
    }

    if (changes.length === 0) return false;
    dispatch(state.update({ changes, userEvent: 'input.format' }));
    return true;
  };
}

export const toggleBold = toggleWrap('**', 'bold text');
export const toggleItalic = toggleWrap('*', 'italic text');
export const toggleStrikethrough = toggleWrap('~~', 'struck out');
export const toggleInlineCode = toggleWrap('`', 'code');
export const toggleHighlight = toggleWrap('==', 'highlight');

export const toggleQuote = toggleLinePrefix('> ', /^\s{0,3}>\s?/);
export const toggleBullet = toggleLinePrefix('- ', /^\s*(?:[-*+]|\d+\.)\s+/);
export const toggleNumbered = toggleLinePrefix('1. ', /^\s*(?:[-*+]|\d+\.)\s+/);
export const toggleTask = toggleLinePrefix('- [ ] ', /^\s*(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+\.\s+)/);

export function setHeading(level: number): StateCommand {
  return toggleLinePrefix(`${'#'.repeat(level)} `, /^\s{0,3}#{1,6}\s+/);
}

/** Insert a snippet at the cursor, selecting the part worth typing over. */
function insertSnippet(text: string, selectFrom: number, selectTo: number): StateCommand {
  return ({ state, dispatch }) => {
    const range = state.selection.main;
    const atLineStart = state.doc.lineAt(range.from).from === range.from;
    const prefix = atLineStart || range.from === 0 ? '' : '\n';
    const insert = `${prefix}${text}`;

    dispatch(
      state.update({
        changes: { from: range.from, to: range.to, insert },
        selection: {
          anchor: range.from + prefix.length + selectFrom,
          head: range.from + prefix.length + selectTo,
        },
        scrollIntoView: true,
        userEvent: 'input.format',
      }),
    );
    return true;
  };
}

export const insertHorizontalRule = insertSnippet('\n---\n\n', 5, 5);
export const insertCodeBlock = insertSnippet('```\n\n```\n', 3, 3);
export const insertTable = insertSnippet(
  '| Column | Column |\n| --- | --- |\n| Cell | Cell |\n',
  2,
  8,
);

export const insertLink: StateCommand = ({ state, dispatch }) => {
  const changes = state.changeByRange((range) => {
    const selected = state.sliceDoc(range.from, range.to);
    const label = selected || 'link text';
    const insert = `[${label}](url)`;
    const urlStart = range.from + label.length + 3;
    return {
      changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.range(urlStart, urlStart + 3),
    };
  });
  dispatch(state.update(changes, { scrollIntoView: true, userEvent: 'input.format' }));
  return true;
};

export const insertImage: StateCommand = ({ state, dispatch }) => {
  const range = state.selection.main;
  const alt = state.sliceDoc(range.from, range.to) || 'alt text';
  const insert = `![${alt}](url)`;
  const urlStart = range.from + alt.length + 4;
  dispatch(
    state.update({
      changes: { from: range.from, to: range.to, insert },
      selection: { anchor: urlStart, head: urlStart + 3 },
      scrollIntoView: true,
      userEvent: 'input.format',
    }),
  );
  return true;
};

const LIST_ITEM = /^(\s*)(?:([-*+])|(\d+)\.)(\s+)(\[[ xX]\]\s+)?(.*)$/;

/**
 * Enter inside a list continues it, and Enter on an empty item ends it —
 * the behaviour people expect from every other markdown editor.
 */
export const continueList: StateCommand = ({ state, dispatch }) => {
  const range = state.selection.main;
  if (!range.empty) return false;

  const line = state.doc.lineAt(range.from);
  const match = LIST_ITEM.exec(line.text);
  if (!match) return false;

  const [, indent, bullet, ordinal, space, task, content] = match;

  // Empty item: outdent it away rather than adding another empty bullet.
  if (!content.trim()) {
    dispatch(
      state.update({
        changes: { from: line.from, to: line.to, insert: '' },
        selection: { anchor: line.from },
        userEvent: 'input',
      }),
    );
    return true;
  }

  const marker = bullet ?? `${Number(ordinal) + 1}.`;
  const insert = `\n${indent}${marker}${space}${task ? '[ ] ' : ''}`;
  dispatch(
    state.update({
      changes: { from: range.from, insert },
      selection: { anchor: range.from + insert.length },
      scrollIntoView: true,
      userEvent: 'input',
    }),
  );
  return true;
};

/** Pasting a URL over a selection turns it into a link instead of replacing it. */
export function pasteLinkHandler(event: ClipboardEvent, view: EditorView): boolean {
  const pasted = event.clipboardData?.getData('text/plain')?.trim();
  if (!pasted || !/^https?:\/\/\S+$/i.test(pasted) || pasted.includes('\n')) return false;

  const range = view.state.selection.main;
  if (range.empty) return false;

  const selected = view.state.sliceDoc(range.from, range.to);
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: `[${selected}](${pasted})` },
    userEvent: 'input.paste',
  });
  return true;
}

export const markdownKeymap: KeyBinding[] = [
  { key: 'Mod-b', run: toggleBold, preventDefault: true },
  { key: 'Mod-i', run: toggleItalic, preventDefault: true },
  { key: 'Mod-e', run: toggleInlineCode, preventDefault: true },
  { key: 'Mod-Shift-x', run: toggleStrikethrough, preventDefault: true },
  { key: 'Mod-Shift-h', run: toggleHighlight, preventDefault: true },
  { key: 'Mod-k', run: insertLink, preventDefault: true },
  { key: 'Mod-Shift-.', run: toggleQuote, preventDefault: true },
  { key: 'Mod-Shift-8', run: toggleBullet, preventDefault: true },
  { key: 'Mod-Shift-7', run: toggleNumbered, preventDefault: true },
  { key: 'Mod-Shift-9', run: toggleTask, preventDefault: true },
  { key: 'Mod-1', run: setHeading(1), preventDefault: true },
  { key: 'Mod-2', run: setHeading(2), preventDefault: true },
  { key: 'Mod-3', run: setHeading(3), preventDefault: true },
  { key: 'Enter', run: continueList },
];
