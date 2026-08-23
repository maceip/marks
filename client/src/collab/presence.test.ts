import assert from 'node:assert/strict';
import test from 'node:test';
import { LABEL_VISIBLE_MS, labelGeometry, updateCaretPresentation } from './presence.ts';

test('labels flip at the top viewport edge and remain inside the right editor edge', () => {
  assert.deepEqual(labelGeometry(180, 105, 70, { left: 100, right: 200, top: 100 }), {
    placement: 'below', shiftX: -52,
  });
  assert.deepEqual(labelGeometry(110, 160, 40, { left: 100, right: 200, top: 100 }), {
    placement: 'above', shiftX: 0,
  });
});

test('rapid cursor movement extends one presentation deadline', () => {
  const arrived = updateCaretPresentation(undefined, 10, 1_000);
  const moved = updateCaretPresentation(arrived, 11, 1_100);
  assert.equal(moved.visibleUntil, 1_100 + LABEL_VISIBLE_MS);
  assert.equal(moved.lastMovedAt, 1_100);
});

test('an unchanged caret settles after label expiry', () => {
  const arrived = updateCaretPresentation(undefined, 10, 1_000);
  const unchanged = updateCaretPresentation(arrived, 10, 1_000 + LABEL_VISIBLE_MS + 1);
  assert.equal(unchanged.visibleUntil, arrived.visibleUntil);
  assert.ok(unchanged.visibleUntil < 1_000 + LABEL_VISIBLE_MS + 1);
});

test('identical positions retain independent peer state for stacking', () => {
  const peers = new Map([
    ['one', updateCaretPresentation(undefined, 4, 100)],
    ['two', updateCaretPresentation(undefined, 4, 100)],
  ]);
  assert.equal(peers.size, 2);
  assert.equal(peers.get('one')?.position, peers.get('two')?.position);
});
