import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  applyServiceCallerHeaders,
  ensureServiceCaller,
  resetServiceCallerForTests,
  resolveServiceCaller,
} from './caller.ts';
import { encodeBase64Url } from './protocol.ts';
import { loadScratchCredential, saveScratchCredential } from './scratch.ts';

class MemoryStorage implements Storage {
  readonly #values = new Map<string, string>();

  get length(): number {
    return this.#values.size;
  }

  clear(): void {
    this.#values.clear();
  }

  getItem(key: string): string | null {
    return this.#values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.#values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.#values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.#values.set(key, value);
  }
}

const leftoverScratch = {
  version: 1 as const,
  scratchId: 'scratch_leftover1',
  capability: encodeBase64Url(new Uint8Array(32).fill(7)),
  expiresAtMs: 50_000,
};

afterEach(() => {
  resetServiceCallerForTests();
});

test('a live session wins over leftover scratch', () => {
  assert.deepEqual(
    resolveServiceCaller({ sessionLive: true, scratch: leftoverScratch }),
    { kind: 'session' },
  );
  assert.deepEqual(resolveServiceCaller({ sessionLive: false, scratch: leftoverScratch }), {
    kind: 'scratch',
    credential: leftoverScratch,
  });
  assert.deepEqual(resolveServiceCaller({ sessionLive: false }), { kind: 'none' });
});

test('session authority never writes a MarksScratch or MarksSession header', () => {
  const headers = new Headers({ Authorization: `MarksScratch leftover.${leftoverScratch.capability}` });
  applyServiceCallerHeaders(headers, { kind: 'session' });
  assert.equal(headers.get('Authorization'), null);
});

test('scratch authority writes the MarksScratch capability header', () => {
  const headers = new Headers();
  applyServiceCallerHeaders(headers, { kind: 'scratch', credential: leftoverScratch });
  assert.equal(
    headers.get('Authorization'),
    `MarksScratch ${leftoverScratch.scratchId}.${leftoverScratch.capability}`,
  );
});

test('ensureServiceCaller clears leftover scratch when a session cookie is live', async () => {
  const storage = new MemoryStorage();
  saveScratchCredential(storage, leftoverScratch);
  const calls: string[] = [];

  const caller = await ensureServiceCaller({
    storage,
    fetch: async (input) => {
      calls.push(`${String(input)}`);
      return Response.json({
        principalId: 'principal_1234',
        deviceId: 'device_1234567',
        sessionId: 'session_12345',
        csrf: 'csrf',
      });
    },
  });

  assert.deepEqual(caller, { kind: 'session' });
  assert.equal(loadScratchCredential(storage, 1), undefined);
  assert.deepEqual(calls, ['/v1/auth/session']);
});

test('ensureServiceCaller mints scratch only after session probe fails', async () => {
  const storage = new MemoryStorage();
  const calls: string[] = [];
  const minted = {
    scratchId: 'scratch_minted123',
    capability: encodeBase64Url(new Uint8Array(32).fill(3)),
    expiresAtMs: 80_000,
  };

  const caller = await ensureServiceCaller({
    storage,
    fetch: async (input, init) => {
      calls.push(`${init?.method ?? 'GET'} ${String(input)}`);
      if (String(input).endsWith('/v1/auth/session')) {
        return new Response(null, { status: 401 });
      }
      return new Response(JSON.stringify(minted), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });

  assert.deepEqual(caller, {
    kind: 'scratch',
    credential: { version: 1, ...minted },
  });
  assert.deepEqual(loadScratchCredential(storage, 1), { version: 1, ...minted });
  assert.deepEqual(calls, ['GET /v1/auth/session', 'POST /v1/auth/scratch']);
});

test('ensureServiceCaller reuses leftover scratch when no session exists', async () => {
  const storage = new MemoryStorage();
  saveScratchCredential(storage, leftoverScratch);
  const calls: string[] = [];

  const caller = await ensureServiceCaller({
    storage,
    fetch: async (input) => {
      calls.push(String(input));
      return new Response(null, { status: 401 });
    },
  });

  assert.deepEqual(caller, { kind: 'scratch', credential: leftoverScratch });
  assert.deepEqual(calls, ['/v1/auth/session']);
});
