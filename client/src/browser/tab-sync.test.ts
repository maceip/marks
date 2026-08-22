import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTabId, tabChannelName } from './tab-sync.ts';

test('channel names isolate engine and document', () => {
  assert.equal(tabChannelName('esbt', 'abc'), 'marks:tab:esbt:abc');
  assert.equal(tabChannelName('loro', 'abc'), 'marks:tab:loro:abc');
  assert.notEqual(tabChannelName('esbt', 'a'), tabChannelName('loro', 'a'));
  assert.notEqual(tabChannelName('loro', 'a'), tabChannelName('yjs', 'a'));
  assert.notEqual(tabChannelName('esbt', 'a'), tabChannelName('esbt', 'b'));
});

test('tab ids do not collide in a burst', () => {
  const ids = new Set(Array.from({ length: 40 }, () => createTabId()));
  assert.equal(ids.size, 40);
});
