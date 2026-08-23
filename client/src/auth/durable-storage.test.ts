import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requestDurableStorage, storagePersisted } from './durable-storage.ts';

test('durable storage requests never throw where the Storage API is absent', async () => {
  // Node exposes a minimal `navigator` without `storage`; both helpers must
  // degrade to false rather than blocking or throwing in any environment.
  assert.equal(await requestDurableStorage(), false);
  assert.equal(await storagePersisted(), false);
});
