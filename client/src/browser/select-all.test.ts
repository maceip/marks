import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shouldHandleSelectAll, type SelectAllKey } from './select-all.ts';

function key(init: Partial<SelectAllKey> = {}): SelectAllKey {
  return { key: 'a', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, target: null, ...init };
}

test('select-all in the preview is ours', () => {
  assert.equal(shouldHandleSelectAll(key(), 'preview'), true);
});

test('select-all in the editor is left to CodeMirror', () => {
  // Without a DOM target the helper treats the event as chrome, so lastSurface
  // decides. Editor as last surface must not steal the binding.
  assert.equal(shouldHandleSelectAll(key(), 'editor'), false);
});

test('ignores unmodified or shifted A', () => {
  assert.equal(shouldHandleSelectAll(key({ ctrlKey: false }), 'preview'), false);
  assert.equal(shouldHandleSelectAll(key({ shiftKey: true }), 'preview'), false);
});
