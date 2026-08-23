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

const MUTATION_MAGIC = new Uint8Array([0x4d, 0x4b, 0x4d, 0x54]); // MKMT
const COMMITTED_MAGIC = new Uint8Array([0x4d, 0x4b, 0x43, 0x4d]); // MKCM
const PROTOCOL_VERSION = 1;
const MUTATION_HEADER_BYTES = 26;
const COMMITTED_HEADER_BYTES = 33;

/**
 * Selection presence v1 offsets are accepted only during the rolling upgrade
 * from the August 2026 client. Remove this decoder after every supported
 * client has emitted v2 for one full presence TTL/deployment window.
 */
export const MAX_LEGACY_SELECTION_OFFSET = 2_000_000;
export const MAX_SELECTION_ANCHOR_BYTES = 4_096;

export type SelectionDirection = 'forward' | 'backward';

export interface SelectionPresenceV2 {
  version: 2;
  anchor: Uint8Array;
  head: Uint8Array;
  direction: SelectionDirection;
  sequence: number;
}

export interface LegacySelectionPresenceV1 {
  version: 1;
  anchorOffset: number;
  headOffset: number;
  direction: SelectionDirection;
}

interface SelectionPresenceV2Wire {
  v: 2;
  anchor: string;
  head: string;
  direction: SelectionDirection;
  sequence: number;
}

export function encodeSelectionPresence(value: SelectionPresenceV2): SelectionPresenceV2Wire {
  validateAnchor(value.anchor);
  validateAnchor(value.head);
  validateSequence(value.sequence);
  validateDirection(value.direction);
  return {
    v: 2,
    anchor: toBase64Url(value.anchor),
    head: toBase64Url(value.head),
    direction: value.direction,
    sequence: value.sequence,
  };
}

/** Decode untrusted ephemeral JSON, bounding anchor allocation before Wasm sees it. */
export function decodeSelectionPresence(
  value: unknown,
): SelectionPresenceV2 | LegacySelectionPresenceV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const wire = value as Record<string, unknown>;
  if (wire.v === 2) {
    if (typeof wire.anchor !== 'string' || typeof wire.head !== 'string') return null;
    if (!isDirection(wire.direction) || !isSequence(wire.sequence)) return null;
    const anchor = fromBase64Url(wire.anchor);
    const head = fromBase64Url(wire.head);
    if (!anchor || !head) return null;
    return { version: 2, anchor, head, direction: wire.direction, sequence: wire.sequence };
  }

  // Bounded compatibility with the former `{from,to}` selection value.
  if (isLegacyOffset(wire.from) && isLegacyOffset(wire.to)) {
    const direction = wire.from <= wire.to ? 'forward' : 'backward';
    return {
      version: 1,
      anchorOffset: wire.from,
      headOffset: wire.to,
      direction,
    };
  }
  return null;
}

function fromBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  // Check encoded size before decoding/allocating and reject non-canonical input.
  if (value.length > Math.ceil(MAX_SELECTION_ANCHOR_BYTES * 4 / 3)) return null;
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/')
      + '='.repeat((4 - value.length % 4) % 4);
    const binary = atob(padded);
    if (binary.length === 0 || binary.length > MAX_SELECTION_ANCHOR_BYTES) return null;
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function validateAnchor(value: Uint8Array): void {
  if (!(value instanceof Uint8Array) || value.byteLength === 0
      || value.byteLength > MAX_SELECTION_ANCHOR_BYTES) {
    throw new RangeError('marks: invalid selection anchor length');
  }
}

function isDirection(value: unknown): value is SelectionDirection {
  return value === 'forward' || value === 'backward';
}

function validateDirection(value: unknown): asserts value is SelectionDirection {
  if (!isDirection(value)) throw new TypeError('marks: invalid selection direction');
}

function isSequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validateSequence(value: unknown): asserts value is number {
  if (!isSequence(value)) throw new RangeError('marks: invalid selection sequence');
}

function isLegacyOffset(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0
    && (value as number) <= MAX_LEGACY_SELECTION_OFFSET;
}

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
