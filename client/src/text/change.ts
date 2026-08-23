/** A UTF-16 replacement in the coordinate space produced by preceding edits. */
export interface TextEdit {
  from: number;
  to: number;
  insert: string;
}

/** Apply a sequential engine receipt without interpreting CRDT internals. */
export function applyTextEdits(text: string, edits: readonly TextEdit[]): string {
  let next = text;
  for (const edit of edits) {
    if (
      !Number.isSafeInteger(edit.from) ||
      !Number.isSafeInteger(edit.to) ||
      edit.from < 0 ||
      edit.to < edit.from ||
      edit.to > next.length
    ) {
      throw new RangeError(`invalid text edit ${edit.from}..${edit.to} for ${next.length}`);
    }
    next = next.slice(0, edit.from) + edit.insert + next.slice(edit.to);
  }
  return next;
}
