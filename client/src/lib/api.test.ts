import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ServiceCaller } from '../auth/caller.ts';
import { authenticatedResponse, csrfRequest } from './api.ts';

const scratch: ServiceCaller = {
  kind: 'scratch',
  credential: {
    version: 1,
    scratchId: 'scratch_1234567890123456',
    capability: 'capability_1234567890123456',
    expiresAtMs: Date.now() + 60_000,
  },
};

test('expired scratch reprobe cannot extend the advertised request deadline', { timeout: 1_000 }, async () => {
  const started = Date.now();
  let forceProbes = 0;
  await assert.rejects(
    authenticatedResponse('/v1/documents', undefined, 10, {
      ensureCaller: async (options) => {
        if (options?.forceProbe) {
          forceProbes += 1;
          return new Promise(() => undefined);
        }
        return scratch;
      },
      fetch: async () => new Response(null, { status: 401 }),
    }),
    (error: unknown) => error instanceof DOMException && error.name === 'TimeoutError',
  );
  assert.equal(forceProbes, 1);
  assert.ok(Date.now() - started < 500);
});

test('CSRF authority resolution is part of the same absolute deadline', { timeout: 1_000 }, async () => {
  let fetches = 0;
  await assert.rejects(
    csrfRequest('/v1/import/url', { url: 'https://example.com' }, 10, {
      ensureCaller: () => new Promise(() => undefined),
      fetch: async () => {
        fetches += 1;
        return new Response('{}');
      },
    }),
    (error: unknown) => error instanceof DOMException && error.name === 'TimeoutError',
  );
  assert.equal(fetches, 0);
});
