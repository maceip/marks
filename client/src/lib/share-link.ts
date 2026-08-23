import { decodeBase64Url } from '../auth/protocol.ts';

const SHARE_PREFIX = '#share.v1.';

/**
 * Share capabilities stay in the fragment, so reverse proxies, access logs,
 * referrers, and the static document route never receive the bearer token.
 */
export function documentShareUrl(documentId: string, token: string, origin = location.origin): string {
  assertShareToken(token);
  return `${origin}/d/${encodeURIComponent(documentId)}${SHARE_PREFIX}${token}`;
}

export function readDocumentShareHash(hash: string): string | 'invalid' | null {
  if (!hash.startsWith(SHARE_PREFIX)) return null;
  const token = hash.slice(SHARE_PREFIX.length);
  try {
    assertShareToken(token);
    return token;
  } catch {
    return 'invalid';
  }
}

function assertShareToken(token: string): void {
  if (!/^[A-Za-z0-9_-]+$/u.test(token) || decodeBase64Url(token).byteLength !== 32) {
    throw new TypeError('invalid Marks share token');
  }
}
