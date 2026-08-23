import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEVICE_CAPABILITIES_MEMBER,
  bytesToHex,
  encodeDeviceGrant,
  encodeSelfBootstrap,
  pairingFragment,
  parsePairingFragment,
} from './protocol.ts';

const grant = {
  version: 1 as const,
  principalId: 'principal_1234',
  controllerId: 'controller_123',
  controllerEpoch: 8n,
  pairingId: 'pairing_123456',
  scratchId: 'scratch_123456',
  pendingDeviceId: 'device_1234567',
  pendingDevicePublicKeyHash: Uint8Array.from({ length: 32 }, (_, index) => index),
  capabilities: DEVICE_CAPABILITIES_MEMBER,
  issuedAtMs: 10_000n,
  expiresAtMs: 19_000n,
};

test('device grant encoder is deterministic and length-prefixed', () => {
  const first = encodeDeviceGrant(grant);
  const second = encodeDeviceGrant({ ...grant });
  assert.deepEqual(first, second);
  assert.equal(
    bytesToHex(first),
    '6d61726b732d6465766963652d6772616e742d763100010000000e7072696e636970616c5f313233340000000e636f6e74726f6c6c65725f31323300000000000000080000000e70616972696e675f3132333435360000000e736372617463685f3132333435360000000e6465766963655f3132333435363700000020000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f0000000100000000000027100000000000004a38',
  );
});

test('changing a signed field changes canonical bytes', () => {
  assert.notDeepEqual(
    encodeDeviceGrant(grant),
    encodeDeviceGrant({ ...grant, expiresAtMs: grant.expiresAtMs - 1n }),
  );
});

test('self-bootstrap encoder matches the Rust golden fixture', () => {
  const bootstrap = {
    version: 1 as const,
    controllerId: 'controller_123',
    scratchId: 'scratch_123456',
    deviceId: 'device_1234567',
    devicePublicKeyHash: Uint8Array.from({ length: 32 }, (_, index) => index),
    issuedAtMs: 10_000n,
    expiresAtMs: 19_000n,
  };
  assert.equal(
    bytesToHex(encodeSelfBootstrap(bootstrap)),
    '6d61726b732d73656c662d626f6f7473747261702d763100010000000e636f6e74726f6c6c65725f3132330000000e736372617463685f3132333435360000000e6465766963655f3132333435363700000020000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f00000000000027100000000000004a38',
  );
  assert.notDeepEqual(
    encodeSelfBootstrap(bootstrap),
    encodeSelfBootstrap({ ...bootstrap, expiresAtMs: bootstrap.expiresAtMs - 1n }),
  );
});

test('pairing secret round-trips only through a fragment', () => {
  const secret = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);
  const fragment = pairingFragment('pairing_123456', secret);
  assert.ok(fragment.startsWith('#v1.'));
  assert.doesNotMatch(fragment, /[?&]secret=/u);
  assert.deepEqual(parsePairingFragment(fragment), {
    pairingId: 'pairing_123456',
    secret,
  });
  assert.throws(() => pairingFragment('pairing_123456', secret.subarray(0, 31)));
  assert.throws(() => parsePairingFragment('#v1.pairing_123456.short'));
});
