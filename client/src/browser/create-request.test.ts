import assert from 'node:assert/strict';
import test from 'node:test';
import {
  anonymousStarterRequestId,
  confirmAnonymousStarterRequest,
} from './create-request.ts';

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

test('anonymous starter retries keep one request id until a confirmed response', () => {
  const storage = new MemoryStorage();
  const first = '11111111-1111-4111-8111-111111111111';
  const second = '22222222-2222-4222-8222-222222222222';
  let generated = 0;
  const makeId = () => {
    generated += 1;
    return generated === 1 ? first : second;
  };

  assert.equal(anonymousStarterRequestId(storage, makeId), first);
  assert.equal(anonymousStarterRequestId(storage, makeId), first);
  assert.equal(generated, 1);
  confirmAnonymousStarterRequest(first, storage);
  assert.equal(anonymousStarterRequestId(storage, makeId), second);
  confirmAnonymousStarterRequest(second, storage);
});

test('a stale response cannot clear a newer pending create request', () => {
  const storage = new MemoryStorage();
  const first = '11111111-1111-4111-8111-111111111111';
  const second = '22222222-2222-4222-8222-222222222222';
  assert.equal(anonymousStarterRequestId(storage, () => first), first);
  confirmAnonymousStarterRequest(first, storage);
  assert.equal(anonymousStarterRequestId(storage, () => second), second);
  confirmAnonymousStarterRequest(first, storage);
  assert.equal(anonymousStarterRequestId(storage, () => first), second);
  confirmAnonymousStarterRequest(second, storage);
});

test('storage denial does not crash anonymous starter creation', () => {
  const denied = {
    getItem(): string | null { throw new DOMException('blocked', 'SecurityError'); },
    setItem(): void { throw new DOMException('blocked', 'SecurityError'); },
    removeItem(): void { throw new DOMException('blocked', 'SecurityError'); },
  };
  const id = '33333333-3333-4333-8333-333333333333';
  assert.equal(anonymousStarterRequestId(denied, () => id), id);
  assert.equal(anonymousStarterRequestId(denied, () => assert.fail('must reuse volatile id')), id);
  assert.doesNotThrow(() => confirmAnonymousStarterRequest(id, denied));
});

test('a failed storage write still reuses the volatile request on this page', () => {
  const writeDenied = {
    getItem(): string | null { return null; },
    setItem(): void { throw new DOMException('full', 'QuotaExceededError'); },
    removeItem(): void {},
  };
  const id = '44444444-4444-4444-8444-444444444444';
  assert.equal(anonymousStarterRequestId(writeDenied, () => id), id);
  assert.equal(
    anonymousStarterRequestId(writeDenied, () => assert.fail('must reuse volatile id')),
    id,
  );
  confirmAnonymousStarterRequest(id, writeDenied);
});
