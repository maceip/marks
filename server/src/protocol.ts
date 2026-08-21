/**
 * Wire protocol for the ESBT sync rooms.
 *
 * Every frame is binary: one tag byte followed by an opaque payload. Keep this
 * file in sync with `client/src/collab/protocol.ts`.
 */
export const MSG_UPDATE = 0x01; //  both ways: ESBT update or snapshot bytes
export const MSG_EPHEMERAL = 0x02; //  both ways: presence, relayed but never persisted
export const MSG_SERVER_VV = 0x03; //  server -> client: oplog version vector
export const MSG_SNAPSHOT = 0x04; //  server -> client: document snapshot
export const MSG_SYNCED = 0x05; //  server -> client: initial sync complete

export function frame(tag: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(payload.length + 1);
  out[0] = tag;
  out.set(payload, 1);
  return out;
}

export function unframe(data: Uint8Array): { tag: number; payload: Uint8Array } {
  return { tag: data[0], payload: data.subarray(1) };
}
