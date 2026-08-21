import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { tags } from '@lezer/highlight';

/**
 * Editor chrome. Every colour is a CSS variable, so switching the theme is a
 * single attribute flip on <html> with no editor rebuild.
 */
export const editorTheme = EditorView.theme({
  '&': {
    color: 'var(--text)',
    backgroundColor: 'var(--surface)',
    height: '100%',
    fontSize: 'var(--editor-font-size)',
  },
  '.cm-scroller': {
    fontFamily: 'var(--font-mono)',
    lineHeight: '1.7',
    padding: '1.25rem 0 45vh',
    overflowY: 'auto',
  },
  '.cm-content': {
    caretColor: 'var(--accent)',
    padding: '0 1.25rem',
    maxWidth: '100%',
  },
  '.cm-line': { padding: '0 2px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--selection)',
  },
  '.cm-activeLine': { backgroundColor: 'var(--active-line)' },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--text-faint)',
    border: 'none',
  },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text-muted)' },
  '.cm-selectionMatch': { backgroundColor: 'var(--selection-match)' },
  '.cm-searchMatch': {
    backgroundColor: 'var(--search-match)',
    outline: '1px solid var(--border-strong)',
  },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--search-match-active)' },
  '.cm-panels': {
    backgroundColor: 'var(--surface-raised)',
    color: 'var(--text)',
    borderTop: '1px solid var(--border)',
  },
  '.cm-panel input, .cm-panel button': {
    fontFamily: 'inherit',
    background: 'var(--surface)',
    color: 'var(--text)',
    border: '1px solid var(--border)',
    borderRadius: '4px',
    padding: '2px 6px',
  },
  '.cm-tooltip': {
    backgroundColor: 'var(--surface-raised)',
    border: '1px solid var(--border)',
    borderRadius: '8px',
  },
});

/**
 * Markdown source styling: enough visual structure that the source pane is
 * readable on its own, without pretending to be the rendered output.
 */
export const markdownHighlighting = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.heading1, color: 'var(--text)', fontWeight: '700', fontSize: '1.5em' },
    { tag: tags.heading2, color: 'var(--text)', fontWeight: '700', fontSize: '1.3em' },
    { tag: tags.heading3, color: 'var(--text)', fontWeight: '700', fontSize: '1.15em' },
    { tag: tags.heading4, color: 'var(--text)', fontWeight: '700' },
    { tag: [tags.heading5, tags.heading6], color: 'var(--text)', fontWeight: '600' },
    { tag: tags.strong, fontWeight: '700', color: 'var(--text)' },
    { tag: tags.emphasis, fontStyle: 'italic', color: 'var(--text)' },
    { tag: tags.strikethrough, textDecoration: 'line-through', color: 'var(--text-muted)' },
    { tag: tags.link, color: 'var(--accent)', textDecoration: 'underline' },
    { tag: tags.url, color: 'var(--accent-muted)' },
    { tag: tags.monospace, color: 'var(--code)', background: 'var(--code-bg)', borderRadius: '3px' },
    { tag: tags.quote, color: 'var(--text-muted)', fontStyle: 'italic' },
    { tag: tags.list, color: 'var(--accent)' },
    { tag: tags.contentSeparator, color: 'var(--text-faint)', fontWeight: '700' },
    { tag: tags.processingInstruction, color: 'var(--text-faint)' },
    { tag: tags.comment, color: 'var(--text-faint)', fontStyle: 'italic' },
    { tag: tags.keyword, color: 'var(--syntax-keyword)' },
    { tag: [tags.string, tags.special(tags.string)], color: 'var(--syntax-string)' },
    { tag: tags.number, color: 'var(--syntax-number)' },
    { tag: [tags.function(tags.variableName), tags.definition(tags.variableName)], color: 'var(--syntax-fn)' },
    { tag: tags.typeName, color: 'var(--syntax-type)' },
  ]),
);
