import assert from 'node:assert/strict';
import { test } from 'node:test';
import { documentIsOpenable } from './document-support.ts';

test('unknown documents are openable so first connect can create an ESBT row', () => {
  assert.equal(documentIsOpenable(null), true);
  assert.equal(documentIsOpenable(undefined), true);
});

test('esbt documents are openable', () => {
  assert.equal(documentIsOpenable({ engine: 'esbt' }), true);
});

test('retired engine rows are not openable', () => {
  assert.equal(documentIsOpenable({ engine: 'loro' }), false);
  assert.equal(documentIsOpenable({ engine: 'yjs' }), false);
  assert.equal(documentIsOpenable({ engine: '' }), false);
});
