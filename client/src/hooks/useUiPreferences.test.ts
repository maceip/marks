import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_UI_PREFERENCES, parseUiPreferences } from '../lib/ui-preferences.ts';

test('phone ghost defaults on when the device has no stored preference', () => {
  assert.equal(parseUiPreferences(null).phoneGhost, true);
  assert.equal(parseUiPreferences('{}').phoneGhost, true);
  assert.equal(DEFAULT_UI_PREFERENCES.phoneGhost, true);
});

test('an explicit device-local phone ghost choice survives preference parsing', () => {
  assert.equal(parseUiPreferences('{"phoneGhost":false}').phoneGhost, false);
  assert.equal(parseUiPreferences('{"phoneGhost":true}').phoneGhost, true);
});

test('invalid stored values fall back without discarding valid preferences', () => {
  assert.deepEqual(parseUiPreferences('not json'), DEFAULT_UI_PREFERENCES);
  assert.deepEqual(parseUiPreferences('{"density":"compact","glass":false,"documentPresence":"section"}'), {
    density: 'compact',
    glass: false,
    motion: true,
    phoneGhost: true,
    documentPresence: 'section',
  });
});
