import { parsePairingFragment, type PairingLink } from '../auth/protocol.ts';

export function pairingLandingPath(origin = ''): string {
  return `${origin}/link`;
}

export function readPairingHash(hash: string): PairingLink | 'invalid' | null {
  if (!hash || hash === '#' || !hash.startsWith('#v1.')) return null;
  try {
    return parsePairingFragment(hash);
  } catch {
    return 'invalid';
  }
}
