/**
 * Wire protocol for the ESBT sync rooms.
 * The production Rust server must implement these Marks-owned room frames.
 */
export const MSG_UPDATE = 0x01;
export const MSG_EPHEMERAL = 0x02;
export const MSG_SERVER_VV = 0x03;
export const MSG_SNAPSHOT = 0x04;
export const MSG_SYNCED = 0x05;
export const MSG_MUTATION = 0x06;
export const MSG_COMMITTED = 0x07;
export const MSG_PRESENCE_DELTA = 0x08;
export const MSG_PRESENCE_SNAPSHOT = 0x09;
export const MSG_PRESENCE_REMOVAL = 0x0a;

const MUTATION_MAGIC = new Uint8Array([0x4d, 0x4b, 0x4d, 0x54]); // MKMT
const COMMITTED_MAGIC = new Uint8Array([0x4d, 0x4b, 0x43, 0x4d]); // MKCM
const PROTOCOL_VERSION = 1;
const MUTATION_HEADER_BYTES = 26;
const COMMITTED_HEADER_BYTES = 33;

export type MutationKind = 'update' | 'snapshot';

export interface CommittedReceipt {
  id: string;
  revision: bigint;
  version: Uint8Array;
}

export function frame(tag: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(payload.length + 1);
  out[0] = tag;
  out.set(payload, 1);
  return out;
}

export function randomMutationId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  if (bytes.every((byte) => byte === 0)) bytes[0] = 1;
  return bytesToHex(bytes);
}

export function encodeMutation(
  id: string,
  kind: MutationKind,
  payload: Uint8Array,
): Uint8Array {
  const idBytes = hexToBytes(id);
  if (payload.byteLength === 0 || payload.byteLength > 0xffff_ffff) {
    throw new RangeError('marks: mutation payload length is invalid');
  }
  const out = new Uint8Array(MUTATION_HEADER_BYTES + payload.byteLength);
  out.set(MUTATION_MAGIC, 0);
  out[4] = PROTOCOL_VERSION;
  out[5] = kind === 'update' ? 1 : 2;
  out.set(idBytes, 6);
  new DataView(out.buffer).setUint32(22, payload.byteLength, true);
  out.set(payload, MUTATION_HEADER_BYTES);
  return out;
}

export function decodeCommitted(payload: Uint8Array): CommittedReceipt {
  if (
    payload.byteLength < COMMITTED_HEADER_BYTES ||
    !equalPrefix(payload, COMMITTED_MAGIC) ||
    payload[4] !== PROTOCOL_VERSION
  ) {
    throw new TypeError('marks: invalid committed receipt');
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const versionLength = view.getUint32(29, true);
  if (payload.byteLength !== COMMITTED_HEADER_BYTES + versionLength) {
    throw new TypeError('marks: committed receipt length mismatch');
  }
  return {
    id: bytesToHex(payload.subarray(5, 21)),
    revision: view.getBigUint64(21, true),
    version: payload.slice(COMMITTED_HEADER_BYTES),
  };
}

function equalPrefix(bytes: Uint8Array, prefix: Uint8Array): boolean {
  return prefix.every((byte, index) => bytes[index] === byte);
}

function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-f]{32}$/.test(hex) || /^0+$/.test(hex)) {
    throw new TypeError('marks: mutation id must be nonzero 128-bit lowercase hex');
  }
  return Uint8Array.from(hex.match(/../g) ?? [], (part) => Number.parseInt(part, 16));
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
