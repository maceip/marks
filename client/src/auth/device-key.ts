import { del, get, set } from 'idb-keyval';
import {
  type ControllerBootstrap,
  type DeviceGrant,
  type DeviceSessionProof,
  encodeControllerBootstrap,
  encodeDeviceGrant,
  encodeDeviceSessionProof,
} from './protocol.ts';

const KEY_PREFIX = 'marks.auth.device-key.v1.';
const PUBLIC_KEY_HASH_DOMAIN = new TextEncoder().encode('marks-public-key-v1\0');

export interface StoredDeviceKey {
  version: 1;
  deviceId: string;
  privateKey: CryptoKey;
  publicKeyRaw: Uint8Array;
  createdAtMs: number;
}

export async function generateDeviceKey(deviceId: string): Promise<StoredDeviceKey> {
  const pair = (await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const publicKeyRaw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  if (publicKeyRaw.byteLength !== 65 || publicKeyRaw[0] !== 0x04) {
    throw new Error('browser returned a non-canonical P-256 public key');
  }
  return {
    version: 1,
    deviceId,
    privateKey: pair.privateKey,
    publicKeyRaw,
    createdAtMs: Date.now(),
  };
}

export async function saveDeviceKey(record: StoredDeviceKey): Promise<void> {
  await set(`${KEY_PREFIX}${record.deviceId}`, record);
}

export async function loadDeviceKey(deviceId: string): Promise<StoredDeviceKey | undefined> {
  const record = await get<StoredDeviceKey>(`${KEY_PREFIX}${deviceId}`);
  if (!record || record.version !== 1 || record.deviceId !== deviceId) return undefined;
  return record;
}

export async function deleteDeviceKey(deviceId: string): Promise<void> {
  await del(`${KEY_PREFIX}${deviceId}`);
}

export async function publicKeyHash(publicKeyRaw: Uint8Array): Promise<Uint8Array> {
  if (publicKeyRaw.byteLength !== 65 || publicKeyRaw[0] !== 0x04) {
    throw new TypeError('public key must be a 65-byte uncompressed P-256 point');
  }
  const length = new Uint8Array(8);
  new DataView(length.buffer).setBigUint64(0, BigInt(publicKeyRaw.byteLength), false);
  const input = new Uint8Array(PUBLIC_KEY_HASH_DOMAIN.byteLength + 8 + publicKeyRaw.byteLength);
  input.set(PUBLIC_KEY_HASH_DOMAIN, 0);
  input.set(length, PUBLIC_KEY_HASH_DOMAIN.byteLength);
  input.set(publicKeyRaw, PUBLIC_KEY_HASH_DOMAIN.byteLength + 8);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', input));
}

async function sign(privateKey: CryptoKey, bytes: Uint8Array): Promise<Uint8Array> {
  const input = Uint8Array.from(bytes).buffer;
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, input),
  );
  if (signature.byteLength !== 64) {
    throw new Error('browser returned a non-P1363 P-256 signature');
  }
  return signature;
}

export function signDeviceGrant(privateKey: CryptoKey, grant: DeviceGrant): Promise<Uint8Array> {
  return sign(privateKey, encodeDeviceGrant(grant));
}

export function signControllerBootstrap(
  privateKey: CryptoKey,
  bootstrap: ControllerBootstrap,
): Promise<Uint8Array> {
  return sign(privateKey, encodeControllerBootstrap(bootstrap));
}

export function signDeviceSessionProof(
  privateKey: CryptoKey,
  proof: DeviceSessionProof,
): Promise<Uint8Array> {
  return sign(privateKey, encodeDeviceSessionProof(proof));
}
