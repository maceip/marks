import assert from 'node:assert/strict';
import test from 'node:test';
import { applyTextEdits } from './change.ts';

test('sequential UTF-16 edits preserve engine coordinate semantics', () => {
  assert.equal(
    applyTextEdits('one 😀 three', [
      { from: 4, to: 6, insert: 'two' },
      { from: 7, to: 7, insert: '!' },
    ]),
    'one two! three',
  );
});

test('invalid edit coordinates fail instead of guessing', () => {
  assert.throws(
    () => applyTextEdits('short', [{ from: 2, to: 20, insert: '' }]),
    /invalid text edit/,
  );
});
