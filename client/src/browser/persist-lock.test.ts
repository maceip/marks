import assert from 'node:assert/strict';
import { test } from 'node:test';
import { persistLockName } from './persist-lock.ts';

test('persist lock names isolate engine and document', () => {
  assert.equal(persistLockName('esbt', 'abc'), 'marks:persist:esbt:abc');
  assert.notEqual(persistLockName('esbt', 'a'), persistLockName('esbt', 'b'));
  assert.notEqual(persistLockName('esbt', 'a'), persistLockName('loro', 'a'));
});
