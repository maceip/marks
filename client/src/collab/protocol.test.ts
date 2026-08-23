import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeCommitted, encodeMutation } from './protocol.ts';

test('mutation envelope matches the Rust binary contract', () => {
  const encoded = encodeMutation('07070707070707070707070707070707', 'snapshot', new Uint8Array([1, 2]));
  assert.equal(new TextDecoder().decode(encoded.subarray(0, 4)), 'MKMT');
  assert.equal(encoded[4], 1);
  assert.equal(encoded[5], 2);
  assert.deepEqual([...encoded.subarray(6, 22)], new Array(16).fill(7));
  assert.equal(new DataView(encoded.buffer).getUint32(22, true), 2);
  assert.deepEqual([...encoded.subarray(26)], [1, 2]);
});

test('committed receipt decoder rejects truncation and returns exact revision', () => {
  const receipt = new Uint8Array(35);
  receipt.set(new TextEncoder().encode('MKCM'));
  receipt[4] = 1;
  receipt.fill(9, 5, 21);
  const view = new DataView(receipt.buffer);
  view.setBigUint64(21, 42n, true);
  view.setUint32(29, 2, true);
  receipt.set([3, 4], 33);
  assert.deepEqual(decodeCommitted(receipt), {
    id: '09090909090909090909090909090909',
    revision: 42n,
    version: new Uint8Array([3, 4]),
  });
  assert.throws(() => decodeCommitted(receipt.subarray(0, 34)), /length mismatch/);
});
