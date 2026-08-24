import assert from 'node:assert/strict';
import test from 'node:test';
import { decodePresenceFrame, PresenceStore } from './presence-store.ts';

test('TypeScript decodes the production ordered presence frame', () => {
  const store = new PresenceStore(30_000);
  store.set('user:2', { name: 'Ada' });
  const decoded = decodePresenceFrame(store.encodeAll());
  assert.deepEqual(decoded.map(({ key, value, deleted }) => ({ key, value, deleted })), [
    { key: 'user:2', value: { name: 'Ada' }, deleted: false },
  ]);
  store.destroy();
});

test('malformed frames fail without partially changing state', () => {
  const store = new PresenceStore(30_000);
  store.set('sentinel', { retained: true });
  const before = store.getAllStates();
  assert.throws(() => store.apply(Uint8Array.of(5, 2)));
  assert.deepEqual(store.getAllStates(), before);
  store.destroy();
});
