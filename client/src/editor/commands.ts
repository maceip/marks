import { EditorSelection, type ChangeSpec, type StateCommand } from '@codemirror/state';
import type { EditorView, KeyBinding } from '@codemirror/view';
import { isPlainUrl, markdownFromClipboard, writeClipboardEvent } from '../browser/clipboard.ts';

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

export const toggleUnderline = toggleWrap('++', 'underlined');
export const toggleSuperscript = toggleWrap('^', 'sup');
export const toggleSubscript = toggleWrap('~', 'sub');

export const insertHorizontalRule = insertSnippet('\n---\n\n', 5, 5);
export const insertCodeBlock = insertSnippet('```\n\n```\n', 3, 3);
export const insertMath = insertSnippet('$$\n\n$$\n', 3, 3);
export const insertMermaid = insertSnippet('```mermaid\nflowchart LR\n  A[Start] --> B[Next]\n```\n', 21, 26);
export const insertFootnote = insertSnippet('[^1]: footnote\n', 6, 14);
export const insertToc = insertSnippet('<!-- toc -->\n\n', 13, 13);
export const insertTable = insertSnippet(
  '| Column | Column |\n| --- | --- |\n| Cell | Cell |\n',
  2,
  8,
);

export function insertCallout(kind: 'info' | 'success' | 'warning' | 'danger' | 'note' = 'info'): StateCommand {
  return insertSnippet(`:::${kind}\nNote\n:::\n`, kind.length + 5, kind.length + 9);
}

export type ShapeKind = 'rect' | 'ellipse' | 'diamond' | 'arrow' | 'bubble';

const SHAPE_PATH: Record<ShapeKind, string> = {
  rect: '<rect x="12" y="18" width="136" height="60" rx="10"/>',
  ellipse: '<ellipse cx="80" cy="48" rx="62" ry="28"/>',
  diamond: '<polygon points="80,14 138,48 80,82 22,48"/>',
  arrow: '<path d="M18 48h92l-12-16M110 48l-12 16"/>',
  bubble: '<path d="M24 18h96a16 16 0 0 1 16 16v28a16 16 0 0 1-16 16H70l-18 14v-14H24A16 16 0 0 1 8 62V34A16 16 0 0 1 24 18z"/>',
};

export function shapePath(kind: ShapeKind): string {
  return SHAPE_PATH[kind];
}

export function insertShape(kind: ShapeKind = 'rect', label = 'Label'): StateCommand {
  const svg = `<figure class="marks-shape" data-shape="${kind}" data-fill="accent">
<svg viewBox="0 0 160 96" role="img" aria-label="${label}">${SHAPE_PATH[kind]}</svg>
<figcaption>${label}</figcaption>
</figure>
`;
  return insertSnippet(svg, svg.indexOf(label), svg.indexOf(label) + label.length);
}

export function insertHtmlImage(url: string, alt = 'image', width = 480, align: 'left' | 'center' | 'right' = 'center'): StateCommand {
  const insert = `<img src="${url}" alt="${alt}" class="marks-figure" width="${width}" data-align="${align}" />\n`;
  return insertSnippet(insert, insert.indexOf(alt), insert.indexOf(alt) + alt.length);
}

export const setParagraph = toggleLinePrefix('', /^\s{0,3}#{1,6}\s+/);

export function indentLines(): StateCommand {
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
        if (line.text.length === 0) continue;
        changes.push({ from: line.from, insert: '  ' });
      }
    }
    if (changes.length === 0) return false;
    dispatch(state.update({ changes, userEvent: 'input.indent' }));
    return true;
  };
}

export function outdentLines(): StateCommand {
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
        const match = /^( {1,2}|\t)/.exec(line.text);
        if (!match) continue;
        changes.push({ from: line.from, to: line.from + match[0].length });
      }
    }
    if (changes.length === 0) return false;
    dispatch(state.update({ changes, userEvent: 'input.indent' }));
    return true;
  };
}

export const clearFormatting: StateCommand = ({ state, dispatch }) => {
  const range = state.selection.main;
  if (range.empty) return false;
  const selected = state.sliceDoc(range.from, range.to);
  const cleaned = selected
    .replace(/(\*\*|__|~~|==|`|\+\+)/g, '')
    .replace(/(^|\s)([*_])(?=\S)/g, '$1')
    .replace(/(?<=\S)([*_])(?=\s|$)/g, '');
  if (cleaned === selected) return false;
  dispatch(
    state.update({
      changes: { from: range.from, to: range.to, insert: cleaned },
      selection: { anchor: range.from, head: range.from + cleaned.length },
      userEvent: 'input.format',
    }),
  );
  return true;
};

export const growHeading: StateCommand = ({ state, dispatch }) => {
  const line = state.doc.lineAt(state.selection.main.from);
  const match = /^(#{1,6})\s/.exec(line.text);
  const level = match ? Math.max(1, match[1].length - 1) : 2;
  return setHeading(level)({ state, dispatch });
};

export const shrinkHeading: StateCommand = ({ state, dispatch }) => {
  const line = state.doc.lineAt(state.selection.main.from);
  const match = /^(#{1,6})\s/.exec(line.text);
  if (!match) return false;
  if (match[1].length >= 6) return setParagraph({ state, dispatch });
  return setHeading(match[1].length + 1)({ state, dispatch });
};

export function addTableRow(): StateCommand {
  return ({ state, dispatch }) => {
    const line = state.doc.lineAt(state.selection.main.from);
    if (!/^\s*\|/.test(line.text)) return false;
    const cells = line.text.split('|').length - 2;
    const row = `| ${Array.from({ length: Math.max(1, cells) }, () => 'Cell').join(' | ')} |`;
    let insertAt = line.to;
    let cursor = state.selection.main.from;
    while (cursor < state.doc.length) {
      const next = state.doc.lineAt(cursor);
      if (!/^\s*\|/.test(next.text)) break;
      insertAt = next.to;
      cursor = next.to + 1;
    }
    dispatch(
      state.update({
        changes: { from: insertAt, insert: `\n${row}` },
        selection: { anchor: insertAt + 3 },
        userEvent: 'input.format',
      }),
    );
    return true;
  };
}

export function addTableColumn(): StateCommand {
  return ({ state, dispatch }) => {
    const line = state.doc.lineAt(state.selection.main.from);
    if (!/^\s*\|/.test(line.text)) return false;
    let start = line.from;
    let end = line.to;
    while (start > 0) {
      const previous = state.doc.lineAt(start - 1);
      if (!/^\s*\|/.test(previous.text)) break;
      start = previous.from;
    }
    while (end < state.doc.length) {
      const next = state.doc.lineAt(end + 1);
      if (!/^\s*\|/.test(next.text)) break;
      end = next.to;
    }

    const changes: ChangeSpec[] = [];
    const block = state.sliceDoc(start, end).split('\n');
    let offset = start;
    for (const row of block) {
      const isSep = /^\s*\|[\s:|-]+\|/.test(row);
      const insert = isSep ? ' --- |' : ' Cell |';
      changes.push({ from: offset + row.length, insert });
      offset += row.length + 1;
    }
    dispatch(state.update({ changes, userEvent: 'input.format' }));
    return true;
  };
}

export function replaceRange(from: number, to: number, insert: string): StateCommand {
  return ({ state, dispatch }) => {
    dispatch(
      state.update({
        changes: { from, to, insert },
        selection: { anchor: from, head: from + insert.length },
        scrollIntoView: true,
        userEvent: 'input.format',
      }),
    );
    return true;
  };
}

export function insertGenerated(text: string, replaceSelection = false): StateCommand {
  return ({ state, dispatch }) => {
    const range = state.selection.main;
    const from = replaceSelection ? range.from : range.to;
    const to = replaceSelection ? range.to : range.to;
    const prefix = !replaceSelection && from > 0 && state.sliceDoc(from - 1, from) !== '\n' ? '\n' : '';
    const insert = `${prefix}${text}`;
    dispatch(
      state.update({
        changes: { from, to, insert },
        selection: { anchor: from + insert.length },
        scrollIntoView: true,
        userEvent: 'input',
      }),
    );
    return true;
  };
}

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
  if (!pasted || !isPlainUrl(pasted)) return false;

  const range = view.state.selection.main;
  if (range.empty) return false;

  const selected = view.state.sliceDoc(range.from, range.to);
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: `[${selected}](${pasted})` },
    userEvent: 'input.paste',
  });
  return true;
}

/**
 * Paste: URL-over-selection, then rich HTML → markdown, then native.
 *
 * Returning true consumes the event. Returning false lets CodeMirror insert
 * the plain text the way a contenteditable would.
 */
export function handleEditorPaste(event: ClipboardEvent, view: EditorView): boolean {
  if (!event.clipboardData) return false;
  if (pasteLinkHandler(event, view)) {
    event.preventDefault();
    return true;
  }

  const converted = markdownFromClipboard(event.clipboardData);
  const plain = event.clipboardData.getData('text/plain');
  if (!converted || converted === plain) return false;

  const range = view.state.selection.main;
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: converted },
    userEvent: 'input.paste',
  });
  event.preventDefault();
  return true;
}

export function handleEditorCopy(event: ClipboardEvent, view: EditorView): boolean {
  const range = view.state.selection.main;
  if (range.empty) return false;
  const text = view.state.sliceDoc(range.from, range.to);
  return writeClipboardEvent(event, { text, markdown: text });
}

export function handleEditorCut(event: ClipboardEvent, view: EditorView): boolean {
  const range = view.state.selection.main;
  if (range.empty) return false;
  const text = view.state.sliceDoc(range.from, range.to);
  if (!writeClipboardEvent(event, { text, markdown: text })) return false;
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: '' },
    userEvent: 'delete.cut',
  });
  return true;
}

export function insertAtSelection(view: EditorView, text: string, userEvent = 'input'): void {
  const range = view.state.selection.main;
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: text },
    selection: { anchor: range.from + text.length },
    scrollIntoView: true,
    userEvent,
  });
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
