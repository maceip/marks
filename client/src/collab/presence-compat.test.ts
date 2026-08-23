import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { decodePresenceFrame, PresenceStore } from './presence-store.ts';

const fixture = JSON.parse(readFileSync(new URL('../../../fixtures/presence-protocol-v1.json', import.meta.url), 'utf8'));

test('TypeScript decodes the shared production presence fixtures', () => {
  for (const frame of fixture.valid) {
    const decoded = decodePresenceFrame(Uint8Array.from(frame.bytes));
    assert.deepEqual(decoded.map((entry) => entry.deleted
      ? { key: entry.key, age_ms: entry.age, value: null, deleted: true }
      : { key: entry.key, age_ms: entry.age, value: entry.value }), frame.entries, frame.name);
  }
});

test('shared malformed fixtures fail without partially changing state', () => {
  const store = new PresenceStore(30_000);
  store.set('sentinel', { retained: true });
  for (const frame of fixture.malformed) {
    const before = store.getAllStates();
    assert.throws(() => store.apply(Uint8Array.from(frame.bytes)), undefined, frame.name);
    assert.deepEqual(store.getAllStates(), before, `${frame.name} was atomic`);
  }
  store.destroy();
});
