import { decodeBase64Url, encodeBase64Url } from './protocol.ts';

const STORAGE_KEY = 'marks.auth.scratch.v1';
const ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

export interface ScratchCredential {
  version: 1;
  scratchId: string;
  capability: string;
  expiresAtMs: number;
}

export function saveScratchCredential(storage: Storage, credential: ScratchCredential): void {
  validateScratchCredential(credential);
  storage.setItem(STORAGE_KEY, JSON.stringify(credential));
}

export function loadScratchCredential(storage: Storage, nowMs = Date.now()): ScratchCredential | undefined {
  const raw = storage.getItem(STORAGE_KEY);
  if (!raw) return undefined;
  try {
    const credential = JSON.parse(raw) as ScratchCredential;
    validateScratchCredential(credential);
    if (nowMs >= credential.expiresAtMs) {
      storage.removeItem(STORAGE_KEY);
      return undefined;
    }
    return credential;
  } catch {
    storage.removeItem(STORAGE_KEY);
    return undefined;
  }
}

export function clearScratchCredential(storage: Storage): void {
  storage.removeItem(STORAGE_KEY);
}

export function createRandomSecret(): Uint8Array {
  const secret = new Uint8Array(32);
  crypto.getRandomValues(secret);
  return secret;
}

export function createOpaqueId(prefix: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_]{0,23}$/u.test(prefix)) {
    throw new TypeError('invalid opaque identifier prefix');
  }
  return `${prefix}_${encodeBase64Url(createRandomSecret().subarray(0, 16))}`;
}

function validateScratchCredential(credential: ScratchCredential): void {
  if (
    credential.version !== 1 ||
    !ID_PATTERN.test(credential.scratchId) ||
    !Number.isSafeInteger(credential.expiresAtMs) ||
    credential.expiresAtMs <= 0 ||
    decodeBase64Url(credential.capability).byteLength !== 32
  ) {
    throw new TypeError('invalid scratch credential');
  }
}
