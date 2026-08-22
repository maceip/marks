/**
 * Wire protocol for the ESBT sync rooms.
 * The production Rust server must implement these Marks-owned room frames.
 */
export const MSG_UPDATE = 0x01;
export const MSG_EPHEMERAL = 0x02;
export const MSG_SERVER_VV = 0x03;
export const MSG_SNAPSHOT = 0x04;
export const MSG_SYNCED = 0x05;

export function frame(tag: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(payload.length + 1);
  out[0] = tag;
  out.set(payload, 1);
  return out;
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
