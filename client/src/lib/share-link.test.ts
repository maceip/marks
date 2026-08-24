import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeBase64Url } from '../auth/protocol.ts';
import { documentShareUrl, readDocumentShareHash } from './share-link.ts';

test('share capabilities stay in a validated fragment', () => {
  const token = encodeBase64Url(new Uint8Array(32).fill(17));
  const url = new URL(documentShareUrl('document_1234', token, 'https://marks.example'));
  assert.equal(url.pathname, '/d/document_1234');
  assert.equal(url.search, '');
  assert.equal(url.hash, `#share.v1.${token}`);
  assert.equal(readDocumentShareHash(url.hash), token);
});

test('malformed or wrong-sized share fragments fail before redemption', () => {
  assert.equal(readDocumentShareHash('#unrelated'), null);
  assert.equal(readDocumentShareHash('#share.v1.short'), 'invalid');
  assert.equal(readDocumentShareHash('#share.v1.bad+alphabet'), 'invalid');
});
