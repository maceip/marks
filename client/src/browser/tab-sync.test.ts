import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TabChannel, createTabId, tabChannelName } from './tab-sync.ts';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(predicate: () => boolean, label: string, ms = 1000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > ms) throw new Error(`timeout waiting for ${label}`);
    await delay(5);
  }
}

function unusedHandlers() {
  return {
    onHello() {},
    onUpdate() {},
    onSnapshot() {},
    onRequestSnapshot() {},
  };
}

test('channel names isolate engine and document', () => {
  assert.equal(tabChannelName('esbt', 'abc'), 'marks:tab:esbt:abc');
  assert.notEqual(tabChannelName('esbt', 'a'), tabChannelName('esbt', 'b'));
  assert.notEqual(tabChannelName('esbt', 'a'), tabChannelName('other', 'a'));
});

test('tab ids do not collide in a burst', () => {
  const ids = new Set(Array.from({ length: 40 }, () => createTabId()));
  assert.equal(ids.size, 40);
});

test('two channels on the same name deliver hello, update, and snapshot', async () => {
  const name = tabChannelName('esbt', `live-${createTabId()}`);
  const hellos: string[] = [];
  const updates: string[] = [];
  const snapshots: string[] = [];
  const requests: string[] = [];

  const a = new TabChannel(name, unusedHandlers());
  const b = new TabChannel(name, {
    onHello: (tabId) => hellos.push(tabId),
    onUpdate: (bytes) => updates.push(new TextDecoder().decode(bytes)),
    onSnapshot: (bytes) => snapshots.push(new TextDecoder().decode(bytes)),
    onRequestSnapshot: (tabId) => requests.push(tabId),
  });

  try {
    assert.equal(a.enabled, true);
    assert.equal(b.enabled, true);
    a.hello();
    a.requestSnapshot();
    a.sendUpdate(new TextEncoder().encode('upd'));
    a.sendSnapshot(new TextEncoder().encode('snap'));
    await until(() => hellos.includes(a.tabId), 'hello');
    await until(() => requests.includes(a.tabId), 'request-snapshot');
    await until(() => updates.includes('upd'), 'update');
    await until(() => snapshots.includes('snap'), 'snapshot');
  } finally {
    a.destroy();
    b.destroy();
  }
});

test('a channel ignores its own posts', async () => {
  const name = tabChannelName('esbt', `self-${createTabId()}`);
  let hellos = 0;
  const a = new TabChannel(name, {
    onHello: () => {
      hellos += 1;
    },
    onUpdate() {},
    onSnapshot() {},
    onRequestSnapshot() {},
  });
  try {
    a.hello();
    await delay(40);
    assert.equal(hellos, 0);
  } finally {
    a.destroy();
  }
});

test('different document channels do not see each other', async () => {
  const seen: string[] = [];
  const a = new TabChannel(tabChannelName('esbt', `iso-a-${createTabId()}`), unusedHandlers());
  const b = new TabChannel(tabChannelName('esbt', `iso-b-${createTabId()}`), {
    onHello: (tabId) => seen.push(tabId),
    onUpdate() {},
    onSnapshot() {},
    onRequestSnapshot() {},
  });
  try {
    a.hello();
    await delay(40);
    assert.deepEqual(seen, []);
  } finally {
    a.destroy();
    b.destroy();
  }
});

test('destroy stops further delivery', async () => {
  const name = tabChannelName('esbt', `dead-${createTabId()}`);
  const updates: string[] = [];
  const a = new TabChannel(name, unusedHandlers());
  const b = new TabChannel(name, {
    onHello() {},
    onUpdate: (bytes) => updates.push(new TextDecoder().decode(bytes)),
    onSnapshot() {},
    onRequestSnapshot() {},
  });
  try {
    a.sendUpdate(new TextEncoder().encode('before'));
    await until(() => updates.includes('before'), 'first update');
    b.destroy();
    a.sendUpdate(new TextEncoder().encode('after'));
    await delay(40);
    assert.equal(updates.includes('after'), false);
  } finally {
    a.destroy();
    b.destroy();
  }
});
