import assert from 'node:assert/strict';
import { EditorState, type StateCommand } from '@codemirror/state';
import { describe, it } from 'node:test';
import {
  addTableColumn,
  addTableRow,
  clearFormatting,
  indentLines,
  insertCallout,
  insertShape,
  outdentLines,
  setHeading,
  toggleBold,
} from './commands.ts';

function run(doc: string, command: StateCommand, from = 0, to = from) {
  const state = EditorState.create({ doc, selection: { anchor: from, head: to } });
  let next = state;
  const ok = command({
    state,
    dispatch: (transaction) => {
      next = transaction.state;
    },
  });
  return { ok, doc: next.doc.toString() };
}

describe('markdown ribbon commands', () => {
  it('wraps a selection in bold markers', () => {
    const result = run('hello', toggleBold, 0, 5);
    assert.equal(result.ok, true);
    assert.equal(result.doc, '**hello**');
  });

  it('sets a heading level', () => {
    const result = run('Title', setHeading(2), 0);
    assert.equal(result.doc, '## Title');
  });

  it('clears wrap markers from a selection', () => {
    const result = run('**hello**', clearFormatting, 0, 9);
    assert.equal(result.doc, 'hello');
  });

  it('indents and outdents selected lines', () => {
    const indented = run('- item', indentLines(), 0);
    assert.equal(indented.doc, '  - item');
    const outdented = run(indented.doc, outdentLines(), 0);
    assert.equal(outdented.doc, '- item');
  });

  it('inserts a callout fence', () => {
    const result = run('', insertCallout('warning'), 0);
    assert.match(result.doc, /:::warning/);
  });

  it('inserts an on-brand shape figure', () => {
    const result = run('', insertShape('arrow', 'Next'), 0);
    assert.match(result.doc, /data-shape="arrow"/);
    assert.match(result.doc, /<figcaption>Next<\/figcaption>/);
  });

  it('adds a table row and column', () => {
    const start = '| A | B |\n| --- | --- |\n| 1 | 2 |';
    const row = run(start, addTableRow(), 0);
    assert.match(row.doc, /\| Cell \| Cell \|/);
    const column = run(start, addTableColumn(), 0);
    assert.match(column.doc, /\| Cell \|/);
    assert.match(column.doc, /\| --- \|/);
  });
});
