import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  EsbtEngine,
  releaseReplicaAfterCheckpoint,
} from './esbt-engine.ts';
import { persistLockName, withPersistLock } from '../browser/persist-lock.ts';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function installBrowserGlobals(): void {
  const windowTarget = Object.assign(new EventTarget(), {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
  });
  const documentTarget = Object.assign(new EventTarget(), {
    visibilityState: 'visible',
  });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: windowTarget });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: documentTarget });
  // Node supplies BroadcastChannel, but these unit tests do not need a live
  // cross-tab handle and should leave no background resource behind.
  Object.defineProperty(globalThis, 'BroadcastChannel', { configurable: true, value: undefined });
}

installBrowserGlobals();

const user = { id: 'user-1', name: 'Test User', colorIndex: 1 };

test('a fatal storage state is surfaced, rejects durability, and makes the replica read-only', async () => {
  const engine = new EsbtEngine({ docId: 'fatal-storage-state', user });
  assert.equal(engine.capabilities().edit, true);
  const waiting = engine.whenDurable(1_000);
  let notice = '';
  engine.onError?.((error) => {
    notice = error.message;
  });

  const originalError = console.error;
  console.error = () => undefined;
  try {
    (engine as unknown as {
      recordStorageError(message: string, cause: unknown): void;
    }).recordStorageError('The journal failed.', new Error('disk unavailable'));
  } finally {
    console.error = originalError;
  }

  await assert.rejects(waiting, /Editing has been disabled/);
  await assert.rejects(engine.whenDurable(), /Editing has been disabled/);
  assert.equal(engine.capabilities().edit, false);
  assert.equal(engine.status(), 'offline');
  assert.match(notice, /Reload before making more changes/);
  engine.destroy();
});

test('an edit is neither broadcast nor sent when its durable append lane is poisoned', async () => {
  const documentId = 'fatal-before-transport';
  await assert.rejects(
    withPersistLock(
      persistLockName('esbt', documentId),
      () => new Promise(() => undefined),
      { timeoutMs: 5 },
    ),
  );

  const engine = new EsbtEngine({
    docId: documentId,
    user,
    access: {
      fetchSnapshot: async () => new Response(null, { status: 204 }),
      admit: async () => {
        throw new Error('not used');
      },
    },
  });
  const state = engine as unknown as {
    doc: { destroy(): void } | null;
    permissionRole: 'editor';
    serverSynced: boolean;
    tabs: { sendUpdate(bytes: Uint8Array): void };
    persistAndSendMutation(
      bytes: Uint8Array,
      kind: 'update' | 'snapshot',
      broadcastTab: boolean,
    ): Promise<void>;
    sendMutation(): void;
  };
  let destroyed = 0;
  let broadcasts = 0;
  let sends = 0;
  state.doc = { destroy: () => { destroyed += 1; } };
  state.permissionRole = 'editor';
  state.serverSynced = true;
  state.tabs.sendUpdate = () => { broadcasts += 1; };
  state.sendMutation = () => { sends += 1; };

  const originalError = console.error;
  console.error = () => undefined;
  try {
    await state.persistAndSendMutation(new Uint8Array([1, 2, 3]), 'update', true);
  } finally {
    console.error = originalError;
  }

  assert.equal(broadcasts, 0);
  assert.equal(sends, 0);
  assert.equal(engine.capabilities().edit, false);
  engine.destroy();
  await delay(0);
  assert.equal(destroyed, 1);
});

test('teardown releases a replica when the final checkpoint never cooperates', async () => {
  let destroyed = 0;
  let finishCheckpoint: (() => void) | undefined;
  const checkpoint = new Promise<void>((resolve) => {
    finishCheckpoint = resolve;
  });
  releaseReplicaAfterCheckpoint(
    { destroy: () => { destroyed += 1; } },
    checkpoint,
    5,
  );

  await delay(20);
  assert.equal(destroyed, 1);
  finishCheckpoint?.();
  await delay(0);
  assert.equal(destroyed, 1);
});
