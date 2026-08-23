import assert from 'node:assert/strict';
import test from 'node:test';
import { sourcePresenceLocation } from './presence-location.ts';

test('presence fallback follows block bounds and nearest renamed heading', () => {
  const text = '# New name\n\nfirst\nline\n\nlast';
  const location = sourcePresenceLocation(text, text.indexOf('line'));
  assert.equal(location.heading, 'New name');
  assert.equal(location.headingLine, 0);
  assert.equal(text.slice(location.blockStart, location.blockEnd), 'first\nline');
});

test('presence location clamps deleted or stale selection coordinates', () => {
  const location = sourcePresenceLocation('only', 999);
  assert.deepEqual([location.blockStart, location.blockEnd], [0, 4]);
});
