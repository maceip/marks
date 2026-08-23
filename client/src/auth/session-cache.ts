export interface SessionInfo {
  principalId: string;
  deviceId: string;
  sessionId: string;
  csrf: string;
}

let cached: SessionInfo | null = null;
const SESSION_SEEN_KEY = 'marks.auth.session-seen.v1';

function defaultStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function cacheSession(info: SessionInfo, storage: Storage | null = defaultStorage()): void {
  cached = info;
  storage?.setItem(SESSION_SEEN_KEY, '1');
}

export function getCachedSession(): SessionInfo | null {
  return cached;
}

export function clearCachedSession(storage: Storage | null = defaultStorage()): void {
  cached = null;
  storage?.removeItem(SESSION_SEEN_KEY);
}

/** Non-secret offline hint. The HTTP-only cookie remains the actual authority
 * and every reconnect is revalidated by the server. */
export function hasSeenSession(storage: Storage | null = defaultStorage()): boolean {
  return storage?.getItem(SESSION_SEEN_KEY) === '1';
}

export function sessionFromUnknown(body: unknown): SessionInfo | null {
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  if (
    typeof record.principalId !== 'string' ||
    typeof record.deviceId !== 'string' ||
    typeof record.sessionId !== 'string' ||
    typeof record.csrf !== 'string'
  ) {
    return null;
  }
  return {
    principalId: record.principalId,
    deviceId: record.deviceId,
    sessionId: record.sessionId,
    csrf: record.csrf,
  };
}
