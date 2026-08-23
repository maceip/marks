import assert from 'node:assert/strict';
import test from 'node:test';
import 'fake-indexeddb/auto';
import type { ContextSignal, CounterfactualPatch, StoredIntent } from './types.ts';

class WildCustomEvent<T = unknown> extends Event {
  readonly detail: T;
  constructor(type: string, init?: CustomEventInit<T>) {
    super(type, init);
    this.detail = init?.detail as T;
  }
}

const browserEvents = new EventTarget();
Object.assign(globalThis, {
  window: browserEvents,
  CustomEvent: WildCustomEvent,
  BroadcastChannel: undefined,
});

const {
  listContextSignals,
  listCounterfactuals,
  listIntents,
  putContextSignal,
  putCounterfactual,
  putIntent,
  reconcileContextSignals,
} = await import('./store.ts');

test('wild local stores isolate document records and preserve explicit state during reconciliation', async () => {
  const documentId = `wild-${crypto.randomUUID()}`;
  const now = 10_000;
  const intent: StoredIntent = {
    id: `intent:${documentId}:declared`,
    documentId,
    label: 'Prepare review',
    detail: 'Declared locally',
    commandIds: ['review.document-health'],
    basis: 'declared',
    confidence: 1,
    urgency: 'now',
    state: 'pinned',
    createdAt: now,
    updatedAt: now,
  };
  await putIntent(intent);
  assert.deepEqual(await listIntents(documentId), [intent]);
  assert.deepEqual(await listIntents(`${documentId}-other`), []);

  const discovered: ContextSignal = {
    id: `context:${documentId}:current`,
    documentId,
    kind: 'relative-time',
    label: 'Current claim',
    detail: 'Changes with reading date',
    expected: 'currently',
    range: { from: 0, to: 9, line: 1, column: 1 },
    firstSeenAt: now,
    lastSeenAt: now,
    reviewedAt: null,
    ttlMs: 1_000,
    active: true,
    dismissed: false,
  };
  await reconcileContextSignals(documentId, [discovered]);
  await putContextSignal({ ...discovered, reviewedAt: now + 1, ttlMs: 5_000, dismissed: true });
  await reconcileContextSignals(documentId, [{ ...discovered, firstSeenAt: now + 10, lastSeenAt: now + 10 }]);
  const [restored] = await listContextSignals(documentId);
  assert.equal(restored.firstSeenAt, now);
  assert.equal(restored.reviewedAt, now + 1);
  assert.equal(restored.ttlMs, 5_000);
  assert.equal(restored.dismissed, true);
});

test('counterfactual shelf persists bounded patch content by document', async () => {
  const documentId = `shelf-${crypto.randomUUID()}`;
  const patch: CounterfactualPatch = {
    id: `counterfactual:${crypto.randomUUID()}`,
    documentId,
    label: 'Alternate opening',
    note: 'Keep beside the live draft',
    createdAt: 1,
    updatedAt: 1,
    source: 'human',
    commandId: null,
    baseDigest: 'a'.repeat(64),
    from: 0,
    expected: 'Old',
    replacement: 'New',
    prefix: '',
    suffix: ' body',
    archived: false,
    appliedAt: null,
  };
  await putCounterfactual(patch);
  assert.deepEqual(await listCounterfactuals(documentId), [patch]);
  assert.deepEqual(await listCounterfactuals(`${documentId}-other`), []);
});
