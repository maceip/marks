import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  EsbtRuntime,
  loadSharedEsbtRuntime,
  type EsbtComponentManifest,
} from './esbt-document.ts';

const CORE_BYTES = Uint8Array.of(0);
const CORE_SHA256 = createHash('sha256').update(CORE_BYTES).digest('hex');

function manifest(): EsbtComponentManifest {
  const descriptor = (path: string) => ({
    path,
    bytes: CORE_BYTES.byteLength,
    sha256: CORE_SHA256,
  });
  return {
    schema: 'esbt.component-artifact',
    format: 1,
    engine_revision: '0'.repeat(40),
    source_dirty: false,
    source_sha256: '0'.repeat(64),
    profile_sha256: '1'.repeat(64),
    wit_package: 'esbt:document@1.0.0',
    wit_sha256: '2'.repeat(64),
    wire_version: 1,
    transpiler_package: '@bytecodealliance/jco-transpile',
    transpiler_version: '0.12.1',
    component: descriptor('/esbt.component.wasm'),
    wrapper: {
      path: 'client:collab/wasm/generated/esbt.js',
      bytes: 1,
      sha256: '3'.repeat(64),
    },
    core_modules: [
      descriptor('/esbt.core.wasm'),
      descriptor('/esbt.core2.wasm'),
      descriptor('/esbt.core3.wasm'),
    ],
    compiler: 'rustc 1.95.0 (test)',
    target: 'wasm32-unknown-unknown',
  };
}

function isTimeout(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'TimeoutError';
}

test('runtime bootstrap times out while the manifest response body is stalled', async () => {
  let bodyRead = false;
  const fetchImpl: typeof fetch = async () => ({
    ok: true,
    status: 200,
    json: () => {
      bodyRead = true;
      return new Promise(() => undefined);
    },
  }) as Response;

  await assert.rejects(
    EsbtRuntime.load('/stalled-manifest', { fetch: fetchImpl, timeoutMs: 5 }),
    isTimeout,
  );
  assert.equal(bodyRead, true);
});

test('runtime bootstrap times out when core compilation never settles', async () => {
  const value = manifest();
  let compileCalls = 0;
  const fetchImpl: typeof fetch = async (input) => String(input) === '/manifest'
    ? Response.json(value)
    : new Response(CORE_BYTES);

  await assert.rejects(
    EsbtRuntime.load('/manifest', {
      fetch: fetchImpl,
      compile: () => {
        compileCalls += 1;
        return new Promise(() => undefined);
      },
      timeoutMs: 100,
    }),
    isTimeout,
  );
  assert.ok(compileCalls > 0);
});

test('shared runtime cache coalesces work and retries after a failed bootstrap', async () => {
  const expected = {} as EsbtRuntime;
  let attempts = 0;
  const load = (): Promise<EsbtRuntime> => {
    attempts += 1;
    return attempts === 1
      ? Promise.reject(new Error('first bootstrap failed'))
      : Promise.resolve(expected);
  };

  const first = loadSharedEsbtRuntime(load);
  assert.equal(loadSharedEsbtRuntime(load), first);
  await assert.rejects(first, /first bootstrap failed/);

  assert.equal(await loadSharedEsbtRuntime(load), expected);
  assert.equal(attempts, 2);
});
