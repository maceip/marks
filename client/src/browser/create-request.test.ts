import assert from 'node:assert/strict';
import test from 'node:test';
import {
  confirmDocumentCreateRequest,
  documentCreateRequestScope,
  documentDuplicateRequestScope,
  pendingDocumentCreateRequest,
  pendingDocumentCreateRequestId,
} from './create-request.ts';

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

test('every create action retries one request id until a confirmed response', () => {
  const storage = new MemoryStorage();
  const scope = documentCreateRequestScope({ templateId: 'notes' });
  const first = '11111111-1111-4111-8111-111111111111';
  const second = '22222222-2222-4222-8222-222222222222';
  let generated = 0;
  const makeId = () => (++generated === 1 ? first : second);

  assert.equal(pendingDocumentCreateRequestId(scope, storage, makeId), first);
  assert.equal(pendingDocumentCreateRequestId(scope, storage, makeId), first);
  assert.equal(generated, 1);
  confirmDocumentCreateRequest(scope, first, storage);
  assert.equal(pendingDocumentCreateRequestId(scope, storage, makeId), second);
  confirmDocumentCreateRequest(scope, second, storage);
});

test('different templates, imports, and duplicates have independent retry identities', () => {
  const storage = new MemoryStorage();
  const scopes = [
    documentCreateRequestScope({ templateId: 'notes' }),
    documentCreateRequestScope({ templateId: 'meeting' }),
    documentCreateRequestScope({ title: 'Import', content: '# Imported\n' }),
    documentDuplicateRequestScope('document_source'),
  ];
  const ids = [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333',
    '44444444-4444-4444-8444-444444444444',
  ];
  assert.deepEqual(
    scopes.map((scope, index) => pendingDocumentCreateRequestId(scope, storage, () => ids[index])),
    ids,
  );
  scopes.forEach((scope, index) => confirmDocumentCreateRequest(scope, ids[index], storage));
});

test('a deployment cannot change the payload underneath a pending semantic create', () => {
  const storage = new MemoryStorage();
  const scope = documentCreateRequestScope({ requestScope: 'automatic-starter:v1' });
  const requestId = '55555555-5555-4555-8555-555555555555';
  const original = pendingDocumentCreateRequest(
    scope,
    { title: 'Marks', content: '# Original marketing copy\n' },
    storage,
    () => requestId,
  );
  const afterDeployment = pendingDocumentCreateRequest(
    scope,
    { title: 'Marks', content: '# Revised marketing copy\n' },
    storage,
    () => assert.fail('must replay the pending request'),
  );

  assert.deepEqual(afterDeployment, original);
  confirmDocumentCreateRequest(scope, requestId, storage);
});

test('content action scopes length-prefix fields containing NUL units', () => {
  const titleNul = documentCreateRequestScope({ title: 'a\0b', content: 'c' });
  const contentNul = documentCreateRequestScope({ title: 'a', content: 'b\0c' });
  assert.notEqual(titleNul, contentNul);
});

test('a stale response cannot clear a newer pending create request', () => {
  const storage = new MemoryStorage();
  const scope = documentCreateRequestScope();
  const first = '11111111-1111-4111-8111-111111111111';
  const second = '22222222-2222-4222-8222-222222222222';
  assert.equal(pendingDocumentCreateRequestId(scope, storage, () => first), first);
  confirmDocumentCreateRequest(scope, first, storage);
  assert.equal(pendingDocumentCreateRequestId(scope, storage, () => second), second);
  confirmDocumentCreateRequest(scope, first, storage);
  assert.equal(pendingDocumentCreateRequestId(scope, storage, () => first), second);
  confirmDocumentCreateRequest(scope, second, storage);
});

test('storage denial does not crash or change a current-page retry identity', () => {
  const denied = {
    getItem(): string | null { throw new DOMException('blocked', 'SecurityError'); },
    setItem(): void { throw new DOMException('blocked', 'SecurityError'); },
    removeItem(): void { throw new DOMException('blocked', 'SecurityError'); },
  };
  const scope = documentCreateRequestScope({ templateId: 'github-readme' });
  const id = '33333333-3333-4333-8333-333333333333';
  assert.equal(pendingDocumentCreateRequestId(scope, denied, () => id), id);
  assert.equal(
    pendingDocumentCreateRequestId(scope, denied, () => assert.fail('must reuse volatile id')),
    id,
  );
  assert.doesNotThrow(() => confirmDocumentCreateRequest(scope, id, denied));
});

test('a failed storage write still reuses the volatile request on this page', () => {
  const writeDenied = {
    getItem(): string | null { return null; },
    setItem(): void { throw new DOMException('full', 'QuotaExceededError'); },
    removeItem(): void {},
  };
  const scope = documentCreateRequestScope({ title: 'Dropped PDF', content: '# Extracted\n' });
  const id = '44444444-4444-4444-8444-444444444444';
  assert.equal(pendingDocumentCreateRequestId(scope, writeDenied, () => id), id);
  assert.equal(
    pendingDocumentCreateRequestId(scope, writeDenied, () => assert.fail('must reuse volatile id')),
    id,
  );
  confirmDocumentCreateRequest(scope, id, writeDenied);
});

test('malformed stored data cannot hide a valid volatile retry request', () => {
  const malformedAndWriteDenied = {
    getItem(): string { return '{not-json'; },
    setItem(): void { throw new DOMException('full', 'QuotaExceededError'); },
    removeItem(): void {},
  };
  const scope = documentCreateRequestScope({ title: 'Import', content: '# Imported\n' });
  const id = '66666666-6666-4666-8666-666666666666';
  assert.equal(pendingDocumentCreateRequestId(scope, malformedAndWriteDenied, () => id), id);
  assert.equal(
    pendingDocumentCreateRequestId(
      scope,
      malformedAndWriteDenied,
      () => assert.fail('must reuse volatile request after malformed storage'),
    ),
    id,
  );
  confirmDocumentCreateRequest(scope, id, malformedAndWriteDenied);
});
