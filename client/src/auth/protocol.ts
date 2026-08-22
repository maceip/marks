const textEncoder = new TextEncoder();
const ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

const DEVICE_GRANT_DOMAIN = textEncoder.encode('marks-device-grant-v1\0');
const CONTROLLER_BOOTSTRAP_DOMAIN = textEncoder.encode('marks-controller-bootstrap-v1\0');
const DEVICE_SESSION_DOMAIN = textEncoder.encode('marks-device-session-v1\0');

export const DEVICE_CAPABILITY_DOCUMENTS = 1 << 0;
export const DEVICE_CAPABILITY_AUTHORIZE_DEVICES = 1 << 1;
export const DEVICE_CAPABILITY_REVOKE_DEVICES = 1 << 2;
export const DEVICE_CAPABILITIES_MEMBER = DEVICE_CAPABILITY_DOCUMENTS;
export const DEVICE_CAPABILITIES_CONTROLLER =
  DEVICE_CAPABILITY_DOCUMENTS |
  DEVICE_CAPABILITY_AUTHORIZE_DEVICES |
  DEVICE_CAPABILITY_REVOKE_DEVICES;

export interface DeviceGrant {
  version: 1;
  principalId: string;
  controllerId: string;
  controllerEpoch: bigint;
  pairingId: string;
  scratchId: string;
  pendingDeviceId: string;
  pendingDevicePublicKeyHash: Uint8Array;
  capabilities: number;
  issuedAtMs: bigint;
  expiresAtMs: bigint;
}

export interface ControllerBootstrap {
  version: 1;
  controllerId: string;
  controllerDeviceId: string;
  controllerPublicKeyHash: Uint8Array;
  pairingId: string;
  scratchId: string;
  pendingDeviceId: string;
  pendingDevicePublicKeyHash: Uint8Array;
  issuedAtMs: bigint;
  expiresAtMs: bigint;
}

export interface DeviceSessionProof {
  version: 1;
  challengeId: string;
  deviceId: string;
  deviceKeyEpoch: bigint;
  audience: string;
  challenge: Uint8Array;
  issuedAtMs: bigint;
  expiresAtMs: bigint;
}

class CanonicalWriter {
  readonly #parts: Uint8Array[] = [];

  bytesWithoutLength(value: Uint8Array): void {
    this.#parts.push(value);
  }

  u8(value: number): void {
    if (!Number.isInteger(value) || value < 0 || value > 0xff) {
      throw new RangeError('value is not an unsigned byte');
    }
    this.#parts.push(Uint8Array.of(value));
  }

  u32(value: number): void {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
      throw new RangeError('value is not an unsigned 32-bit integer');
    }
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value, false);
    this.#parts.push(bytes);
  }

  u64(value: bigint): void {
    if (value < 0n || value > 0xffff_ffff_ffff_ffffn) {
      throw new RangeError('value is not an unsigned 64-bit integer');
    }
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigUint64(0, value, false);
    this.#parts.push(bytes);
  }

  bytes(value: Uint8Array): void {
    this.u32(value.byteLength);
    this.#parts.push(value);
  }

  text(value: string): void {
    this.bytes(textEncoder.encode(value));
  }

  finish(): Uint8Array {
    const length = this.#parts.reduce((total, part) => total + part.byteLength, 0);
    const output = new Uint8Array(length);
    let offset = 0;
    for (const part of this.#parts) {
      output.set(part, offset);
      offset += part.byteLength;
    }
    return output;
  }
}

function assertId(value: string, name: string): void {
  if (!ID_PATTERN.test(value)) throw new TypeError(`${name} is not a bounded base64url identifier`);
}

function assertBytes(value: Uint8Array, length: number, name: string): void {
  if (!(value instanceof Uint8Array) || value.byteLength !== length) {
    throw new TypeError(`${name} must contain exactly ${length} bytes`);
  }
}

function assertCapabilities(value: number): void {
  if (!Number.isInteger(value) || value < 0 || (value & ~DEVICE_CAPABILITIES_CONTROLLER) !== 0) {
    throw new TypeError('device capabilities contain unknown bits');
  }
}

export function encodeDeviceGrant(grant: DeviceGrant): Uint8Array {
  assertId(grant.principalId, 'principalId');
  assertId(grant.controllerId, 'controllerId');
  assertId(grant.pairingId, 'pairingId');
  assertId(grant.scratchId, 'scratchId');
  assertId(grant.pendingDeviceId, 'pendingDeviceId');
  assertBytes(grant.pendingDevicePublicKeyHash, 32, 'pendingDevicePublicKeyHash');
  assertCapabilities(grant.capabilities);

  const writer = new CanonicalWriter();
  writer.bytesWithoutLength(DEVICE_GRANT_DOMAIN);
  writer.u8(grant.version);
  writer.text(grant.principalId);
  writer.text(grant.controllerId);
  writer.u64(grant.controllerEpoch);
  writer.text(grant.pairingId);
  writer.text(grant.scratchId);
  writer.text(grant.pendingDeviceId);
  writer.bytes(grant.pendingDevicePublicKeyHash);
  writer.u32(grant.capabilities);
  writer.u64(grant.issuedAtMs);
  writer.u64(grant.expiresAtMs);
  return writer.finish();
}

export function encodeControllerBootstrap(bootstrap: ControllerBootstrap): Uint8Array {
  assertId(bootstrap.controllerId, 'controllerId');
  assertId(bootstrap.controllerDeviceId, 'controllerDeviceId');
  assertId(bootstrap.pairingId, 'pairingId');
  assertId(bootstrap.scratchId, 'scratchId');
  assertId(bootstrap.pendingDeviceId, 'pendingDeviceId');
  assertBytes(bootstrap.controllerPublicKeyHash, 32, 'controllerPublicKeyHash');
  assertBytes(bootstrap.pendingDevicePublicKeyHash, 32, 'pendingDevicePublicKeyHash');

  const writer = new CanonicalWriter();
  writer.bytesWithoutLength(CONTROLLER_BOOTSTRAP_DOMAIN);
  writer.u8(bootstrap.version);
  writer.text(bootstrap.controllerId);
  writer.text(bootstrap.controllerDeviceId);
  writer.bytes(bootstrap.controllerPublicKeyHash);
  writer.text(bootstrap.pairingId);
  writer.text(bootstrap.scratchId);
  writer.text(bootstrap.pendingDeviceId);
  writer.bytes(bootstrap.pendingDevicePublicKeyHash);
  writer.u64(bootstrap.issuedAtMs);
  writer.u64(bootstrap.expiresAtMs);
  return writer.finish();
}

export function encodeDeviceSessionProof(proof: DeviceSessionProof): Uint8Array {
  assertId(proof.challengeId, 'challengeId');
  assertId(proof.deviceId, 'deviceId');
  assertBytes(proof.challenge, 32, 'challenge');
  if (!proof.audience.startsWith('https://')) {
    throw new TypeError('audience must be an HTTPS origin');
  }

  const writer = new CanonicalWriter();
  writer.bytesWithoutLength(DEVICE_SESSION_DOMAIN);
  writer.u8(proof.version);
  writer.text(proof.challengeId);
  writer.text(proof.deviceId);
  writer.u64(proof.deviceKeyEpoch);
  writer.text(proof.audience);
  writer.bytes(proof.challenge);
  writer.u64(proof.issuedAtMs);
  writer.u64(proof.expiresAtMs);
  return writer.finish();
}

export function encodeBase64Url(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

export function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/u.test(value)) throw new TypeError('invalid base64url text');
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/') + padding);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export interface PairingLink {
  pairingId: string;
  secret: Uint8Array;
}

export function pairingFragment(pairingId: string, secret: Uint8Array): string {
  assertId(pairingId, 'pairingId');
  assertBytes(secret, 32, 'pairingSecret');
  return `#v1.${pairingId}.${encodeBase64Url(secret)}`;
}

export function parsePairingFragment(fragment: string): PairingLink {
  const match = /^#v1\.([A-Za-z0-9_-]{8,128})\.([A-Za-z0-9_-]+)$/u.exec(fragment);
  if (!match) throw new TypeError('invalid Marks pairing fragment');
  const secret = decodeBase64Url(match[2]);
  assertBytes(secret, 32, 'pairingSecret');
  return { pairingId: match[1], secret };
}

export function bytesToHex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
