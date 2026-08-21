import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clampMenuPosition, shouldOfferCustomMenu } from './context-menu.ts';

test('preview always gets a custom menu', () => {
  assert.equal(
    shouldOfferCustomMenu({
      clientX: 10,
      clientY: 10,
      surface: 'preview',
      hasSelection: true,
      pointerType: 'touch',
    }),
    true,
  );
});

test('chrome never gets a custom menu', () => {
  assert.equal(
    shouldOfferCustomMenu({
      clientX: 0,
      clientY: 0,
      surface: 'other',
      hasSelection: false,
      pointerType: 'mouse',
    }),
    false,
  );
});

test('desktop editor gets a custom menu so paste works without a selection', () => {
  assert.equal(
    shouldOfferCustomMenu({
      clientX: 20,
      clientY: 20,
      surface: 'editor',
      hasSelection: false,
      pointerType: 'mouse',
    }),
    true,
  );
});

test('clamps a menu into the viewport', () => {
  const pos = clampMenuPosition(900, 700, 200, 240, { width: 800, height: 600 });
  assert.ok(pos.x + 200 <= 800);
  assert.ok(pos.y + 240 <= 600);
  assert.ok(pos.x >= 8);
  assert.ok(pos.y >= 8);
});
