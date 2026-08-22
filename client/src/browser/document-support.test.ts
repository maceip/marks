import assert from 'node:assert/strict';
import { test } from 'node:test';
import { documentIsOpenable } from './document-support.ts';

test('unknown documents stay closed until an explicit create succeeds', () => {
  assert.equal(documentIsOpenable(null), false);
  assert.equal(documentIsOpenable(undefined), false);
});

test('esbt documents are openable', () => {
  assert.equal(documentIsOpenable({ engine: 'esbt' }), true);
});

test('retired engine rows are not openable', () => {
  assert.equal(documentIsOpenable({ engine: 'loro' }), false);
  assert.equal(documentIsOpenable({ engine: 'yjs' }), false);
  assert.equal(documentIsOpenable({ engine: '' }), false);
});
