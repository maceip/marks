import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';
import type { CommentRecord } from '../browser/comments';

export const setCommentHighlights = StateEffect.define<CommentRecord[]>();

const mark = Decoration.mark({ class: 'cm-comment-range', inclusive: false });

function buildDecorations(comments: CommentRecord[], length: number): DecorationSet {
  const ranges = comments
    .filter((comment) => !comment.resolved && comment.to > comment.from)
    .map((comment) => ({
      from: Math.max(0, Math.min(comment.from, length)),
      to: Math.max(0, Math.min(comment.to, length)),
    }))
    .filter((range) => range.to > range.from)
    .sort((a, b) => a.from - b.from || a.to - b.to);

  return Decoration.set(ranges.map((range) => mark.range(range.from, range.to)));
}

export const commentHighlights = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(deco, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setCommentHighlights)) {
        return buildDecorations(effect.value, transaction.state.doc.length);
      }
    }
    if (transaction.docChanged) return deco.map(transaction.changes);
    return deco;
  },
  provide: (field) => EditorView.decorations.from(field),
});
