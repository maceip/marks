import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { resetServiceCallerForTests } from './caller.ts';
import { pairingUrlFromTicket } from './identity.ts';
import { encodeBase64Url } from './protocol.ts';

afterEach(() => {
  resetServiceCallerForTests();
});

test('pairing URL keeps the fragment secret off the query string', () => {
  const secret = encodeBase64Url(new Uint8Array(32).fill(3));
  const url = pairingUrlFromTicket({
    pairingId: 'pairing_ab12cd34',
    secret,
    words: 'correct horse battery staple',
    expiresAtMs: 1,
    url: `https://marks.example/link#v1.pairing_ab12cd34.${secret}`,
  });
  assert.match(url, /#v1\.pairing_ab12cd34\./);
  assert.doesNotMatch(url, /[?&]secret=/);
});
