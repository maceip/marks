export interface SessionInfo {
  principalId: string;
  deviceId: string;
  sessionId: string;
  csrf: string;
  /** DBSC: the session is bound to a browser-managed hardware key. */
  deviceBound: boolean;
}

let cached: SessionInfo | null = null;

export function cacheSession(info: SessionInfo): void {
  cached = info;
}

export function getCachedSession(): SessionInfo | null {
  return cached;
}

export function clearCachedSession(): void {
  cached = null;
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
    deviceBound: record.deviceBound === true,
  };
}
