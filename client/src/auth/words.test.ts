import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizePairingWords } from './words.ts';

test('four words canonicalize and reject other counts', () => {
  assert.equal(normalizePairingWords('Correct HORSE, battery   staple'), 'correct horse battery staple');
  assert.equal(normalizePairingWords('correct horse battery'), null);
  assert.equal(normalizePairingWords('correct horse battery staple extra'), null);
  assert.equal(normalizePairingWords(''), null);
});
