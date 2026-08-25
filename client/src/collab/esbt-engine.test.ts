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

test('a silent WebSocket is detached and retried at its progress deadline', { timeout: 1_000 }, async () => {
  const engine = new EsbtEngine({
    docId: 'silent-socket',
    user,
    access: {
      fetchSnapshot: async () => new Response(null, { status: 204 }),
      admit: async () => { throw new Error('not used'); },
    },
  });
  let closes = 0;
  let reconnects = 0;
  const socket = {
    close: () => { closes += 1; },
  } as unknown as WebSocket;
  const state = engine as unknown as {
    socket: WebSocket | null;
    armSocketDeadline(socket: WebSocket, timeoutMs: number): void;
    scheduleReconnect(): void;
  };
  state.socket = socket;
  state.scheduleReconnect = () => { reconnects += 1; };
  state.armSocketDeadline(socket, 5);

  await delay(20);
  assert.equal(state.socket, null);
  assert.equal(closes, 1);
  assert.equal(reconnects, 1);
  assert.equal(engine.status(), 'offline');
  engine.destroy();
});

test('protocol progress clears the exact socket watchdog', { timeout: 1_000 }, async () => {
  const engine = new EsbtEngine({
    docId: 'healthy-socket',
    user,
    access: {
      fetchSnapshot: async () => new Response(null, { status: 204 }),
      admit: async () => { throw new Error('not used'); },
    },
  });
  let closes = 0;
  const socket = { close: () => { closes += 1; } } as unknown as WebSocket;
  const state = engine as unknown as {
    socket: WebSocket | null;
    armSocketDeadline(socket: WebSocket, timeoutMs: number): void;
    clearSocketDeadline(socket?: WebSocket): void;
  };
  state.socket = socket;
  state.armSocketDeadline(socket, 5);
  state.clearSocketDeadline(socket);
  await delay(20);
  assert.equal(state.socket, socket);
  assert.equal(closes, 0);
  engine.destroy();
});

for (const [code, expected] of [
  [4400, /rejected a pending edit as invalid/u],
  [4403, /edit permission changed/u],
  [4404, /deleted in another session/u],
] as const) {
  test(`definitive collaboration close ${code} freezes recovery text without reconnecting`, async () => {
    const engine = new EsbtEngine({
      docId: `terminal-close-${code}`,
      user,
      access: {
        fetchSnapshot: async () => new Response(null, { status: 204 }),
        admit: async () => { throw new Error('not used'); },
      },
    });
    const socket = { close: () => undefined } as unknown as WebSocket;
    const state = engine as unknown as {
      socket: WebSocket | null;
      socketAuthority: 'session' | 'scratch' | null;
      permissionRole: 'editor' | null;
      serverSynced: boolean;
      pendingMutations: Map<string, {
        id: string;
        kind: 'update';
        bytes: Uint8Array;
        createdAt: number;
      }>;
      doc: { destroy(): void } | null;
      onDisconnect(socket: WebSocket, code?: number): void;
      scheduleReconnect(): void;
      sendPendingMutations(): void;
      sendMutation(): void;
      persistAndSendMutation(
        bytes: Uint8Array,
        kind: 'update' | 'snapshot',
        broadcastTab: boolean,
      ): Promise<void>;
    };
    let reconnects = 0;
    let sends = 0;
    let notice = '';
    state.socket = socket;
    state.socketAuthority = 'session';
    state.permissionRole = 'editor';
    state.serverSynced = true;
    state.scheduleReconnect = () => { reconnects += 1; };
    state.sendMutation = () => { sends += 1; };
    engine.onError?.((error) => { notice = error.message; });
    const waiting = engine.whenDurable(1_000);

    state.onDisconnect(socket, code);

    assert.equal(engine.status(), 'offline');
    assert.equal(engine.capabilities().role, null);
    assert.equal(engine.capabilities().edit, false);
    assert.equal(engine.capabilities().comment, false);
    assert.equal(engine.capabilities().saveVersion, false);
    assert.equal(engine.capabilities().manageShares, false);
    assert.equal(reconnects, 0);
    assert.match(notice, expected);
    assert.match(notice, /File → Markdown/u);
    await assert.rejects(waiting, /File → Markdown/u);
    await assert.rejects(engine.whenDurable(), /File → Markdown/u);

    state.pendingMutations.set('pending', {
      id: 'pending',
      kind: 'update',
      bytes: new Uint8Array([1]),
      createdAt: Date.now(),
    });
    state.serverSynced = true;
    state.sendPendingMutations();
    assert.equal(sends, 0, 'terminal recovery never resends a rejected tail');
    state.pendingMutations.clear();

    state.doc = { destroy: () => undefined };
    await state.persistAndSendMutation(new Uint8Array([2]), 'update', true);
    assert.equal(state.pendingMutations.size, 0, 'terminal recovery accepts no later mutation');
    state.doc = null;
    engine.destroy();
  });
}

test('an unauthorized scratch close is terminal instead of accumulating offline edits', async () => {
  const engine = new EsbtEngine({
    docId: 'scratch-authority-revoked',
    user,
    access: {
      fetchSnapshot: async () => new Response(null, { status: 204 }),
      admit: async () => { throw new Error('not used'); },
    },
  });
  const socket = { close: () => undefined } as unknown as WebSocket;
  const state = engine as unknown as {
    socket: WebSocket | null;
    socketAuthority: 'session' | 'scratch' | null;
    permissionRole: 'scratch' | null;
    onDisconnect(socket: WebSocket, code?: number): void;
    scheduleReconnect(): void;
  };
  let reconnects = 0;
  let notice = '';
  state.socket = socket;
  state.socketAuthority = 'scratch';
  state.permissionRole = 'scratch';
  state.scheduleReconnect = () => { reconnects += 1; };
  engine.onError?.((error) => { notice = error.message; });

  state.onDisconnect(socket, 4401);

  assert.equal(engine.capabilities().edit, false);
  assert.equal(reconnects, 0);
  assert.match(notice, /anonymous page credential is no longer authorized/u);
  assert.match(notice, /File → Markdown/u);
  engine.destroy();
});

test('a non-retryable readmission denial revokes a cached editable role', async () => {
  const denial = Object.assign(new Error('room admission was denied (403)'), { retryable: false });
  const engine = new EsbtEngine({
    docId: 'cached-role-readmission-denied',
    user,
    access: {
      fetchSnapshot: async () => new Response(null, { status: 204 }),
      admit: async () => { throw denial; },
    },
  });
  const controller = new AbortController();
  const state = engine as unknown as {
    permissionRole: 'editor' | null;
    admissionAbort: AbortController | null;
    admitAndConnect(controller: AbortController): Promise<void>;
    scheduleReconnect(): void;
  };
  let reconnects = 0;
  let notice = '';
  state.permissionRole = 'editor';
  state.admissionAbort = controller;
  state.scheduleReconnect = () => { reconnects += 1; };
  engine.onError?.((error) => { notice = error.message; });
  assert.equal(engine.capabilities().edit, true);

  await state.admitAndConnect(controller);

  assert.equal(engine.status(), 'offline');
  assert.equal(engine.capabilities().role, null);
  assert.equal(engine.capabilities().edit, false);
  assert.equal(reconnects, 0);
  assert.match(notice, /could not reauthorize/u);
  assert.match(notice, /File → Markdown/u);
  await assert.rejects(engine.whenDurable(), /File → Markdown/u);
  engine.destroy();
});

test('a session authority epoch close stays read-only while a fresh ticket is retried', () => {
  const engine = new EsbtEngine({
    docId: 'session-authority-refresh',
    user,
    access: {
      fetchSnapshot: async () => new Response(null, { status: 204 }),
      admit: async () => { throw new Error('not used'); },
    },
  });
  const socket = { close: () => undefined } as unknown as WebSocket;
  const state = engine as unknown as {
    socket: WebSocket | null;
    socketAuthority: 'session' | 'scratch' | null;
    permissionRole: 'owner' | null;
    onDisconnect(socket: WebSocket, code?: number): void;
    scheduleReconnect(): void;
  };
  let reconnects = 0;
  state.socket = socket;
  state.socketAuthority = 'session';
  state.permissionRole = 'owner';
  state.scheduleReconnect = () => { reconnects += 1; };

  state.onDisconnect(socket, 4401);

  assert.equal(engine.capabilities().role, null);
  assert.equal(engine.capabilities().edit, false);
  assert.equal(reconnects, 1);
  engine.destroy();
});
