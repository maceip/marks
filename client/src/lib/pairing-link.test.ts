import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pairingFragment } from '../auth/protocol.ts';
import { pairingLandingPath, readPairingHash } from './pairing-link.ts';

describe('pairing link helpers', () => {
  it('keeps the phone confirmation path at /link', () => {
    assert.equal(pairingLandingPath('https://marks.example'), 'https://marks.example/link');
  });

  it('reads a valid fragment and rejects a guessed one the same way the phone would', () => {
    const secret = new Uint8Array(32).map((_, index) => index + 1);
    const hash = pairingFragment('pairing_ab12cd34', secret);
    const parsed = readPairingHash(hash);
    assert.ok(parsed && parsed !== 'invalid');
    if (parsed !== 'invalid' && parsed) assert.equal(parsed.pairingId, 'pairing_ab12cd34');
    assert.equal(readPairingHash('#v1.pairing_ab12cd34.short'), 'invalid');
    assert.equal(readPairingHash(''), null);
  });
});
