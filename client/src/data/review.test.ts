import assert from 'node:assert/strict';
import test from 'node:test';
import 'fake-indexeddb/auto';

class MemoryStorage implements Storage {
  readonly #entries = new Map<string, string>();

  get length(): number {
    return this.#entries.size;
  }

  clear(): void {
    this.#entries.clear();
  }

  getItem(key: string): string | null {
    return this.#entries.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.#entries.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.#entries.delete(key);
  }

  setItem(key: string, value: string): void {
    this.#entries.set(key, value);
  }
}

class ReviewCustomEvent<T = unknown> extends Event {
  readonly detail: T;

  constructor(type: string, init?: CustomEventInit<T>) {
    super(type, init);
    this.detail = init?.detail as T;
  }
}

const browserEvents = new EventTarget();
Object.assign(globalThis, {
  window: browserEvents,
  localStorage: new MemoryStorage(),
  CustomEvent: ReviewCustomEvent,
  // Do not leave a Node BroadcastChannel handle alive after the test process.
  BroadcastChannel: undefined,
});

const { purgeLocalReviewMetadata, reviewRepository } = await import('./review.ts');

const documentId = `document-${crypto.randomUUID()}`;
const range = {
  start: new Uint8Array([1, 2, 3]),
  end: new Uint8Array([4, 5, 6]),
  quote: 'selection',
  startOffset: 1,
  endOffset: 10,
};

test('local review storage paginates, mutates, snapshots, and purges transactionally', async () => {
  assert.equal(reviewRepository.mode, 'local');

  for (let index = 0; index < 30; index += 1) {
    await reviewRepository.addComment(documentId, 'Local author', `Thread ${index}`, range);
  }

  const first = await reviewRepository.listComments(documentId);
  assert.equal(first.comments.length, 25);
  assert.ok(first.nextCursor);
  const second = await reviewRepository.listComments(documentId, first.nextCursor ?? undefined);
  assert.equal(second.comments.length, 5);
  assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.comments, ...second.comments].map(({ id }) => id)).size, 30);

  const target = second.comments[0];
  await reviewRepository.addReply(documentId, target.id, 'Local author', 'A reply');
  const refreshed = await reviewRepository.listComments(documentId, first.nextCursor ?? undefined);
  const withReply = refreshed.comments.find(({ id }) => id === target.id);
  assert.equal(withReply?.replies.length, 1);
  const replyId = withReply?.replies[0]?.id;
  assert.ok(replyId);
  await reviewRepository.updateReply(documentId, target.id, replyId, 'Edited reply');
  await assert.rejects(
    reviewRepository.deleteReply(documentId, target.id, 'reply-missing'),
    /not found/u,
  );

  const markdown = '# Durable local version\n\n' + 'body '.repeat(8_192);
  const version = await reviewRepository.createVersion(
    documentId,
    'Local author',
    'Checkpoint',
    markdown,
  );
  assert.equal((await reviewRepository.getVersion(documentId, version.id))?.markdown, markdown);
  const versions = await reviewRepository.listVersions(documentId, 'current');
  assert.equal(versions.length, 2);

  await purgeLocalReviewMetadata(documentId);
  assert.deepEqual(await reviewRepository.listComments(documentId), {
    comments: [],
    nextCursor: null,
  });
  assert.equal((await reviewRepository.listVersions(documentId, 'current')).length, 1);
  assert.equal(await reviewRepository.getVersion(documentId, version.id), null);
});
