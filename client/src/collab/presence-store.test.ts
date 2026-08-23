import assert from 'node:assert/strict';
import test from 'node:test';
import { PresenceStore } from './presence-store.ts';

test('presence roundtrips, deletes, and never re-emits remote state', () => {
  const first = new PresenceStore(30_000);
  const second = new PresenceStore(30_000);
  const frames: Uint8Array[] = [];
  first.subscribeLocalUpdates((bytes) => frames.push(bytes));

  first.set('site-a-cm-user', { name: 'Swift Otter', colorClassName: 'marks-user3' });
  first.set('site-a-cm-sel', { from: 2, to: 7 });
  assert.equal(frames.length, 2);
  for (const frame of frames) second.apply(frame);
  assert.deepEqual(second.get('site-a-cm-sel'), { from: 2, to: 7 });

  const emitted = frames.length;
  first.apply(second.encodeAll());
  assert.equal(frames.length, emitted);

  first.delete('site-a-cm-sel');
  second.apply(frames.at(-1)!);
  assert.equal(second.get('site-a-cm-sel'), undefined);

  first.destroy();
  second.destroy();
});

test('presence decoding is atomic and rejects trailing or non-canonical input', () => {
  const source = new PresenceStore(30_000);
  const target = new PresenceStore(30_000);
  source.set('peer-cm-user', { name: 'Peer', colorClassName: 'marks-user1' });
  const valid = source.encodeAll();

  const trailing = new Uint8Array(valid.byteLength + 1);
  trailing.set(valid);
  assert.throws(() => target.apply(trailing), /trailing/);
  assert.deepEqual(target.getAllStates(), {});

  assert.throws(() => target.apply(new Uint8Array([0x4d, 99])), /unsupported|truncated/);
  assert.deepEqual(target.getAllStates(), {});

  source.destroy();
  target.destroy();
});

test('presence validates values before changing local state', () => {
  const store = new PresenceStore(30_000);
  assert.throws(() => store.set('bad', { from: 1, to: 2 }), /section/);
  assert.deepEqual(store.getAllStates(), {});
  assert.throws(() => store.set('peer-cm-user', { name: 'x'.repeat(129), colorClassName: 'marks-user1' }), /limit/);
  assert.deepEqual(store.getAllStates(), {});
  store.destroy();
});

test('presence expiry removes stale peers and notifies subscribers', async () => {
  const store = new PresenceStore(20);
  let notifications = 0;
  store.subscribe(() => {
    notifications += 1;
  });
  store.set('peer-cm-user', { name: 'Peer', colorClassName: 'marks-user1' });
  const afterSet = notifications;
  await new Promise((resolve) => setTimeout(resolve, 560));
  assert.equal(store.get('peer-cm-user'), undefined);
  assert.ok(notifications > afterSet);
  store.destroy();
});
