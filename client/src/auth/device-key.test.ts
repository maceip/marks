import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateDeviceKey, publicKeyHash, signDeviceSessionProof } from './device-key.ts';
import { bytesToHex, encodeDeviceSessionProof } from './protocol.ts';

test('public key digest matches the Rust golden fixture', async () => {
  const publicKey = Uint8Array.from({ length: 65 }, (_, index) => (index === 0 ? 4 : index));
  assert.equal(
    bytesToHex(await publicKeyHash(publicKey)),
    'df64b92cbb436c53cac8ce7cd5b6bfb86a3e63b4c60621a9d5968c9a4fb4731d',
  );
});

test('device key is non-extractable and produces a verifiable P1363 proof', async () => {
  const key = await generateDeviceKey('device_1234567');
  assert.equal(key.privateKey.extractable, false);
  assert.equal(key.publicKeyRaw.byteLength, 65);

  const proof = {
    version: 1 as const,
    challengeId: 'challenge_12345',
    deviceId: key.deviceId,
    deviceKeyEpoch: 1n,
    audience: 'https://marks.example',
    challenge: new Uint8Array(32).fill(6),
    issuedAtMs: 10_000n,
    expiresAtMs: 19_000n,
  };
  const signature = await signDeviceSessionProof(key.privateKey, proof);
  const publicKey = await crypto.subtle.importKey(
    'raw',
    key.publicKeyRaw,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
  assert.equal(signature.byteLength, 64);
  assert.equal(
    await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      publicKey,
      signature,
      encodeDeviceSessionProof(proof),
    ),
    true,
  );
});
