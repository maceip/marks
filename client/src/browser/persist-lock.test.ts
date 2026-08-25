import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PersistLockPoisonedError,
  PersistLockTimeoutError,
  persistLockName,
  withPersistLock,
  writeSnapshotUnderLock,
} from './persist-lock.ts';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function textBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function fromBytes(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

test('persist lock names isolate engine and document', () => {
  assert.equal(persistLockName('esbt', 'abc'), 'marks:persist:esbt:abc');
  assert.notEqual(persistLockName('esbt', 'a'), persistLockName('esbt', 'b'));
  assert.notEqual(persistLockName('esbt', 'a'), persistLockName('other', 'a'));
});

test('same-name persist locks run one at a time', async () => {
  const order: string[] = [];
  const first = withPersistLock('marks:persist:esbt:serial', async () => {
    order.push('a-start');
    await delay(30);
    order.push('a-end');
  });
  const second = withPersistLock('marks:persist:esbt:serial', async () => {
    order.push('b-start');
    order.push('b-end');
  });
  await Promise.all([first, second]);
  assert.deepEqual(order, ['a-start', 'a-end', 'b-start', 'b-end']);
});

test('a failed lock holder still releases the name', async () => {
  await assert.rejects(
    () =>
      withPersistLock('marks:persist:esbt:throw', async () => {
        throw new Error('boom');
      }),
    /boom/,
  );
  let ran = false;
  await withPersistLock('marks:persist:esbt:throw', async () => {
    ran = true;
  });
  assert.equal(ran, true);
});

test('export runs after the previous holder releases, not before the lock', async () => {
  const order: string[] = [];
  const first = withPersistLock('marks:persist:esbt:order', async () => {
    order.push('first-hold');
    await delay(30);
    order.push('first-release');
  });
  const second = writeSnapshotUnderLock(
    'marks:persist:esbt:order',
    () => {
      order.push('export');
      return textBytes('x');
    },
    async () => {
      order.push('write');
    },
  );
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first-hold', 'first-release', 'export', 'write']);
});

test('a later exporter sees replica state that changed while the first writer held the lock', async () => {
  let memory = 'A';
  let disk = '';
  const first = writeSnapshotUnderLock(
    'marks:persist:esbt:union',
    () => textBytes(memory),
    async (bytes) => {
      await delay(30);
      disk = fromBytes(bytes);
      memory = 'AB';
    },
  );
  const second = writeSnapshotUnderLock(
    'marks:persist:esbt:union',
    () => textBytes(memory),
    async (bytes) => {
      disk = fromBytes(bytes);
    },
  );
  await Promise.all([first, second]);
  assert.equal(disk, 'AB');
});

test('a non-cooperative write times out and permanently poisons its document lane', async () => {
  const name = 'marks:persist:esbt:hung-write';
  const startedAt = Date.now();
  await assert.rejects(
    withPersistLock(name, () => new Promise(() => undefined), { timeoutMs: 5 }),
    PersistLockTimeoutError,
  );
  assert(Date.now() - startedAt < 250, 'hung persistence exceeded its absolute deadline');

  let laterWorkRan = false;
  await assert.rejects(
    withPersistLock(name, async () => {
      laterWorkRan = true;
    }),
    PersistLockPoisonedError,
  );
  assert.equal(laterWorkRan, false);
});

test('a caller stuck behind a non-cooperative process holder is bounded and never overlaps it', async () => {
  const name = 'marks:persist:esbt:hung-queue';
  let firstStarted = false;
  const first = withPersistLock(
    name,
    () => {
      firstStarted = true;
      return new Promise(() => undefined);
    },
    { timeoutMs: 30 },
  );
  await delay(1);

  let secondStarted = false;
  const second = withPersistLock(
    name,
    async () => {
      secondStarted = true;
    },
    { timeoutMs: 5 },
  );
  await assert.rejects(second, PersistLockTimeoutError);
  await assert.rejects(first, PersistLockTimeoutError);
  assert.equal(firstStarted, true);
  assert.equal(secondStarted, false);
});

test('a non-cooperative Web Lock request is bounded before write work starts', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const request = () => new Promise<never>(() => undefined);
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { locks: { request } },
  });
  try {
    let workRan = false;
    await assert.rejects(
      withPersistLock(
        'marks:persist:esbt:hung-web-lock',
        async () => {
          workRan = true;
        },
        { timeoutMs: 5 },
      ),
      PersistLockTimeoutError,
    );
    assert.equal(workRan, false);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor);
    else Reflect.deleteProperty(globalThis, 'navigator');
  }
});

test('one poisoned document lane does not block another document', async () => {
  const poisoned = 'marks:persist:esbt:isolated-poison';
  await assert.rejects(
    withPersistLock(poisoned, () => new Promise(() => undefined), { timeoutMs: 5 }),
    PersistLockTimeoutError,
  );

  let ran = false;
  await withPersistLock('marks:persist:esbt:healthy-neighbor', async () => {
    ran = true;
  });
  assert.equal(ran, true);
});
