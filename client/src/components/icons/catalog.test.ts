import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { ICON_MARKS, ICON_NAMES, iconLabel, isIconName } from './catalog.ts';

test('every named icon has a mark and is addressable without a third-party pack', () => {
  assert.equal(ICON_NAMES.length, Object.keys(ICON_MARKS).length);
  for (const name of ICON_NAMES) {
    assert.equal(isIconName(name), true);
    assert.match(ICON_MARKS[name], /[ML]/);
  }
  assert.equal(isIconName('feather'), false);
  assert.equal(isIconName('toc'), false);
});

test('contents is labeled as a table of contents, not an acronym', () => {
  assert.equal(iconLabel('contents'), 'Table of contents');
  assert.equal(ICON_NAMES.includes('contents'), true);
});

test('icon renderer is isometric, pointer-tilted, and pressable without an animation loop', () => {
  const source = readFileSync(new URL('../ui/Icon.tsx', import.meta.url), 'utf8');
  assert.match(source, /marks-icon-side/);
  assert.match(source, /marks-icon-top/);
  assert.match(source, /marks-icon-face/);
  assert.match(source, /--icon-tilt-x/);
  assert.match(source, /--icon-press/);
  assert.doesNotMatch(source, /requestAnimationFrame/);
});
