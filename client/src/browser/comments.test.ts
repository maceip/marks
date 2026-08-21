import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createCommentId,
  decodeBytes,
  encodeBytes,
  parseComment,
  readCommentMap,
  resolveCommentRange,
  serializeComment,
} from './comments.ts';

test('comment ids are unique enough for a session', () => {
  const ids = new Set(Array.from({ length: 50 }, () => createCommentId()));
  assert.equal(ids.size, 50);
});

test('round-trips a comment through JSON', () => {
  const raw = serializeComment({
    id: 'c_1',
    body: 'look here',
    author: 'Swift Otter',
    colorIndex: 2,
    createdAt: 10,
    resolved: false,
    from: 4,
    to: 9,
    quote: 'hello',
  });
  const parsed = parseComment(raw);
  assert.equal(parsed?.body, 'look here');
  assert.equal(parsed?.quote, 'hello');
});

test('rejects malformed map values', () => {
  assert.equal(parseComment(null), null);
  assert.equal(parseComment('{'), null);
  assert.equal(parseComment({ body: 'x' }), null);
});

test('reads a comment map, skipping junk', () => {
  const comments = readCommentMap([
    ['a', serializeComment({
      id: 'a',
      body: 'one',
      author: 'A',
      colorIndex: 1,
      createdAt: 2,
      resolved: false,
      from: 0,
      to: 1,
      quote: 'x',
    })],
    ['b', 'not-json'],
    ['c', { id: 'c', body: 'two', author: 'B', createdAt: 1, from: 0, to: 1, quote: 'y' }],
  ]);
  assert.equal(comments.length, 2);
  assert.equal(comments[0].id, 'c');
  assert.equal(comments[1].id, 'a');
});

test('keeps a range when the quote is still at those offsets', () => {
  const text = 'aaa hello bbb';
  const range = resolveCommentRange({ from: 4, to: 9, quote: 'hello' }, text);
  assert.deepEqual(range, { from: 4, to: 9 });
});

test('re-finds a quote after an insertion in front of it', () => {
  const text = 'zzz aaa hello bbb';
  const range = resolveCommentRange({ from: 4, to: 9, quote: 'hello' }, text);
  assert.deepEqual(range, { from: 8, to: 13 });
});

test('clamps when the quote is gone', () => {
  const text = 'short';
  const range = resolveCommentRange({ from: 40, to: 50, quote: 'missing' }, text);
  assert.ok(range);
  assert.ok(range.from >= 0 && range.to <= text.length);
});

test('encodes bytes as url-safe base64', () => {
  const bytes = new Uint8Array([0, 255, 16, 32]);
  const encoded = encodeBytes(bytes);
  assert.equal(encoded.includes('+'), false);
  assert.equal(encoded.includes('/'), false);
  assert.deepEqual(decodeBytes(encoded), bytes);
});
