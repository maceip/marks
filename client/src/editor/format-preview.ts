import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';

export type FormatPreviewKind = 'body' | 'heading-1' | 'heading-2' | 'heading-3' | 'heading-4';

const setFormatPreview = StateEffect.define<{ from: number; to: number; kind: FormatPreviewKind } | null>();

export const formatPreviewExtension = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (decorations, transaction) => {
    decorations = decorations.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (!effect.is(setFormatPreview)) continue;
      if (!effect.value) return Decoration.none;
      const { from, to, kind } = effect.value;
      const decoration = Decoration.mark({ class: `cm-format-preview cm-format-preview-${kind}` });
      return Decoration.set([decoration.range(from, Math.max(from + 1, to))], true);
    }
    return decorations;
  },
  provide: (field) => EditorView.decorations.from(field),
});

export function showFormatPreview(view: EditorView, kind: FormatPreviewKind): void {
  const range = view.state.selection.main;
  const from = range.empty ? view.state.doc.lineAt(range.head).from : range.from;
  const to = range.empty ? view.state.doc.lineAt(range.head).to : range.to;
  if (from === to) return;
  view.dispatch({ effects: setFormatPreview.of({ from, to, kind }) });
}

export function clearFormatPreview(view: EditorView): void {
  view.dispatch({ effects: setFormatPreview.of(null) });
}
