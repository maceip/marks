import assert from 'node:assert/strict';
import { test } from 'node:test';
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

test('scratch capability remains tab-scoped and expires locally', () => {
  const storage = new MemoryStorage();
  const credential = {
    version: 1 as const,
    scratchId: 'scratch_123456',
    capability: encodeBase64Url(new Uint8Array(32).fill(7)),
    expiresAtMs: 10_000,
  };

  saveScratchCredential(storage, credential);
  assert.deepEqual(loadScratchCredential(storage, 9_999), credential);
  assert.equal(loadScratchCredential(storage, 10_000), undefined);
  assert.equal(storage.length, 0);
});

test('malformed scratch credentials are discarded', () => {
  const storage = new MemoryStorage();
  storage.setItem('marks.auth.scratch.v1', '{"version":1,"scratchId":"short"}');
  assert.equal(loadScratchCredential(storage, 1), undefined);
  assert.equal(storage.length, 0);
});
