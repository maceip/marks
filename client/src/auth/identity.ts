import { applyServiceCallerHeaders, ensureServiceCaller, setActiveCaller } from './caller.ts';
import { fetchWithTimeout, SERVICE_REQUEST_TIMEOUT_MS } from '../browser/network.ts';
import {
  generateDeviceKey,
  loadDeviceKey,
  publicKeyHash,
  saveDeviceKey,
  signControllerBootstrap,
  signDeviceGrant,
  signSelfBootstrap,
} from './device-key.ts';
import { markController, markDeviceEnrolled } from './active-device.ts';
import { requestDurableStorage } from './durable-storage.ts';
import { bindPendingDevice } from './pending-device.ts';
import {
  DEVICE_CAPABILITIES_MEMBER,
  decodeBase64Url,
  encodeBase64Url,
  pairingFragment,
} from './protocol.ts';
import { clearScratchCredential, createOpaqueId } from './scratch.ts';
import { cacheSession, clearCachedSession, getCachedSession, sessionFromUnknown, type SessionInfo } from './session-cache.ts';
import { normalizePairingWords } from './words.ts';

export type { SessionInfo } from './session-cache.ts';
export { getCachedSession } from './session-cache.ts';

export interface PairingTicket {
  pairingId: string;
  secret: string;
  words: string;
  expiresAtMs: number;
  url: string;
}

export interface PairingDetails {
  origin: string;
  pairingId: string;
  scratchId: string;
  pendingDeviceId: string;
  pendingDevicePublicKeyHash: string;
  expiresAtMs: number;
}

export interface DeviceInventory {
  devices: Array<{
    deviceId: string;
    capabilities: number;
    keyEpoch: number;
    createdAtMs: number;
    lastUsedAtMs: number | null;
    revokedAtMs: number | null;
  }>;
  controllers: Array<{
    controllerId: string;
    deviceId: string;
    createdAtMs: number;
    revokedAtMs: number | null;
  }>;
  sessions: Array<{
    sessionId: string;
    deviceId: string;
    createdAtMs: number;
    expiresAtMs: number;
    revokedAtMs: number | null;
    deviceBound: boolean;
  }>;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function identityFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  return fetchWithTimeout(input, init, SERVICE_REQUEST_TIMEOUT_MS);
}

export async function mintPairing(signal?: AbortSignal): Promise<PairingTicket> {
  const caller = await ensureServiceCaller();
  if (caller.kind !== 'scratch') throw new Error('pairing requires an anonymous workspace');
  const headers = new Headers({ Accept: 'application/json' });
  applyServiceCallerHeaders(headers, caller);
  const response = await identityFetch('/v1/auth/pairings', {
    method: 'POST',
    credentials: 'same-origin',
    headers,
    signal,
  });
  if (!response.ok) throw new Error(`pairing mint failed: ${response.status}`);
  const body = (await response.json()) as Record<string, unknown>;
  if (
    typeof body.pairingId !== 'string' ||
    typeof body.secret !== 'string' ||
    typeof body.words !== 'string' ||
    typeof body.expiresAtMs !== 'number' ||
    typeof body.url !== 'string'
  ) {
    throw new Error('pairing mint returned an incomplete ticket');
  }
  return {
    pairingId: body.pairingId,
    secret: body.secret,
    words: body.words,
    expiresAtMs: body.expiresAtMs,
    url: body.url,
  };
}

export async function lookupPairingWords(words: string): Promise<PairingDetails> {
  const canonical = normalizePairingWords(words);
  if (!canonical) throw new Error('pairing words must be four English words');
  const response = await identityFetch('/v1/auth/pairings/lookup', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ words: canonical }),
  });
  if (!response.ok) throw new Error(`pairing lookup failed: ${response.status}`);
  return parsePairingDetails(await response.json());
}

export async function inspectPairing(pairingId: string, secret: string): Promise<PairingDetails> {
  const response = await identityFetch(`/v1/auth/pairings/${pairingId}/inspect`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ secret }),
  });
  if (!response.ok) throw new Error(`pairing inspect failed: ${response.status}`);
  return parsePairingDetails(await response.json());
}

function parsePairingDetails(body: unknown): PairingDetails {
  const record = body as Record<string, unknown> | null;
  if (
    !record ||
    typeof record.origin !== 'string' ||
    typeof record.pairingId !== 'string' ||
    typeof record.scratchId !== 'string' ||
    typeof record.pendingDeviceId !== 'string' ||
    typeof record.pendingDevicePublicKeyHash !== 'string' ||
    typeof record.expiresAtMs !== 'number'
  ) {
    throw new Error('pairing inspect returned incomplete details');
  }
  return {
    origin: record.origin,
    pairingId: record.pairingId,
    scratchId: record.scratchId,
    pendingDeviceId: record.pendingDeviceId,
    pendingDevicePublicKeyHash: record.pendingDevicePublicKeyHash,
    expiresAtMs: record.expiresAtMs,
  };
}

export async function bootstrapPairing(
  details: PairingDetails,
  proof: { secret?: string; words?: string },
): Promise<SessionInfo> {
  const controllerId = createOpaqueId('controller');
  const deviceId = createOpaqueId('device');
  const key = await generateDeviceKey(deviceId);
  await saveDeviceKey(key);
  const now = Date.now();
  const bootstrap = {
    version: 1 as const,
    controllerId,
    controllerDeviceId: deviceId,
    controllerPublicKeyHash: await publicKeyHash(key.publicKeyRaw),
    pairingId: details.pairingId,
    scratchId: details.scratchId,
    pendingDeviceId: details.pendingDeviceId,
    pendingDevicePublicKeyHash: decodeBase64Url(details.pendingDevicePublicKeyHash),
    issuedAtMs: BigInt(now),
    expiresAtMs: BigInt(details.expiresAtMs),
  };
  const signature = await signControllerBootstrap(key.privateKey, bootstrap);
  const response = await identityFetch(`/v1/auth/pairings/${details.pairingId}/bootstrap`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      secret: proof.secret,
      words: proof.words,
      bootstrap: {
        version: 1,
        controllerId,
        controllerDeviceId: deviceId,
        controllerPublicKeyHash: encodeBase64Url(bootstrap.controllerPublicKeyHash),
        pairingId: details.pairingId,
        scratchId: details.scratchId,
        pendingDeviceId: details.pendingDeviceId,
        pendingDevicePublicKeyHash: details.pendingDevicePublicKeyHash,
        issuedAtMs: now,
        expiresAtMs: details.expiresAtMs,
      },
      controllerPublicKey: encodeBase64Url(key.publicKeyRaw),
      signature: encodeBase64Url(signature),
    }),
  });
  if (!response.ok) throw new Error(`pairing bootstrap failed: ${response.status}`);
  const session = sessionFromUnknown(await response.json());
  if (!session) throw new Error('pairing bootstrap returned no session');
  cacheSession(session);
  setActiveCaller({ kind: 'session' });
  void markController(controllerId, deviceId).catch(() => undefined);
  void requestDurableStorage();
  return session;
}

/**
 * Single-device promotion for a visitor with no second device to scan. The
 * pending key already bound to this live scratch signs
 * `marks-self-bootstrap-v1`; the server promotes it to controller, claims the
 * scratch documents, and sets this tab's session cookie directly. There is
 * no pairing and no finalize step.
 */
export async function selfBootstrap(signal?: AbortSignal): Promise<SessionInfo> {
  const caller = await ensureServiceCaller();
  if (caller.kind !== 'scratch') throw new Error('login requires an anonymous workspace');
  const key = await bindPendingDevice(signal);
  const controllerId = createOpaqueId('controller');
  const now = Date.now();
  const expiresAtMs = now + 90_000;
  const devicePublicKeyHash = await publicKeyHash(key.publicKeyRaw);
  const signature = await signSelfBootstrap(key.privateKey, {
    version: 1,
    controllerId,
    scratchId: caller.credential.scratchId,
    deviceId: key.deviceId,
    devicePublicKeyHash,
    issuedAtMs: BigInt(now),
    expiresAtMs: BigInt(expiresAtMs),
  });
  const headers = new Headers({ 'Content-Type': 'application/json', Accept: 'application/json' });
  applyServiceCallerHeaders(headers, caller);
  const response = await identityFetch(`/v1/auth/scratch/${caller.credential.scratchId}/bootstrap`, {
    method: 'POST',
    credentials: 'same-origin',
    headers,
    body: JSON.stringify({
      bootstrap: {
        version: 1,
        controllerId,
        scratchId: caller.credential.scratchId,
        deviceId: key.deviceId,
        devicePublicKeyHash: encodeBase64Url(devicePublicKeyHash),
        issuedAtMs: now,
        expiresAtMs,
      },
      signature: encodeBase64Url(signature),
    }),
    signal,
  });
  if (!response.ok) throw new Error(`self bootstrap failed: ${response.status}`);
  const session = sessionFromUnknown(await response.json());
  if (!session) throw new Error('self bootstrap returned no session');
  cacheSession(session);
  setActiveCaller({ kind: 'session' });
  clearScratchCredential(sessionStorage);
  void markController(controllerId, key.deviceId).catch(() => undefined);
  void requestDurableStorage();
  return session;
}

export async function approvePairing(
  details: PairingDetails,
  proof: { secret?: string; words?: string },
): Promise<void> {
  const session = getCachedSession() ?? (await fetchSession());
  if (!session) throw new Error('approve requires a live controller session');
  const inventory = await listDevices();
  const controller = inventory.controllers.find(
    (entry) => entry.deviceId === session.deviceId && entry.revokedAtMs == null,
  );
  const device = inventory.devices.find((entry) => entry.deviceId === session.deviceId);
  if (!controller || !device) throw new Error('this phone is not a controller');
  const now = Date.now();
  const key = await loadDeviceKey(session.deviceId);
  if (!key) throw new Error('controller key is missing on this phone');
  const grant = {
    version: 1 as const,
    principalId: session.principalId,
    controllerId: controller.controllerId,
    controllerEpoch: BigInt(device.keyEpoch),
    pairingId: details.pairingId,
    scratchId: details.scratchId,
    pendingDeviceId: details.pendingDeviceId,
    pendingDevicePublicKeyHash: decodeBase64Url(details.pendingDevicePublicKeyHash),
    capabilities: DEVICE_CAPABILITIES_MEMBER,
    issuedAtMs: BigInt(now),
    expiresAtMs: BigInt(details.expiresAtMs),
  };
  const signature = await signDeviceGrant(key.privateKey, grant);
  const response = await identityFetch(`/v1/auth/pairings/${details.pairingId}/approve`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      secret: proof.secret,
      words: proof.words,
      grant: {
        version: 1,
        principalId: grant.principalId,
        controllerId: grant.controllerId,
        controllerEpoch: Number(grant.controllerEpoch),
        pairingId: grant.pairingId,
        scratchId: grant.scratchId,
        pendingDeviceId: grant.pendingDeviceId,
        pendingDevicePublicKeyHash: details.pendingDevicePublicKeyHash,
        capabilities: grant.capabilities,
        issuedAtMs: now,
        expiresAtMs: details.expiresAtMs,
      },
      signature: encodeBase64Url(signature),
    }),
  });
  if (!response.ok) throw new Error(`pairing approve failed: ${response.status}`);
}

export async function finalizePairing(
  pairingId: string,
  signal?: AbortSignal,
): Promise<SessionInfo | 'pending' | 'gone'> {
  const caller = await ensureServiceCaller({ forceProbe: false });
  if (caller.kind !== 'scratch') return 'gone';
  const headers = new Headers({ Accept: 'application/json' });
  applyServiceCallerHeaders(headers, caller);
  const response = await identityFetch(`/v1/auth/pairings/${pairingId}/finalize`, {
    method: 'POST',
    credentials: 'same-origin',
    headers,
    signal,
  });
  if (response.status === 201) {
    const session = sessionFromUnknown(await response.json());
    if (!session) return 'gone';
    cacheSession(session);
    setActiveCaller({ kind: 'session' });
    // The HTTP-only session and in-memory caller are authoritative now. A
    // blocked IndexedDB transaction must not delay that application-level
    // promotion; return-visit enrollment can be retried independently.
    void markDeviceEnrolled(session.deviceId).catch(() => undefined);
    void requestDurableStorage();
    return session;
  }
  if (response.status === 401 || response.status === 409) {
    await readJson(response);
    return 'pending';
  }
  return 'gone';
}

export async function fetchSession(): Promise<SessionInfo | null> {
  const response = await identityFetch('/v1/auth/session', { credentials: 'same-origin' });
  if (!response.ok) return null;
  const session = sessionFromUnknown(await response.json());
  if (session) cacheSession(session);
  return session;
}

export async function listDevices(): Promise<DeviceInventory> {
  const response = await identityFetch('/v1/auth/devices', { credentials: 'same-origin' });
  if (!response.ok) throw new Error(`device list failed: ${response.status}`);
  return (await response.json()) as DeviceInventory;
}

export async function logout(): Promise<void> {
  const session = getCachedSession() ?? (await fetchSession());
  if (!session) return;
  const response = await identityFetch('/v1/auth/session', {
    method: 'DELETE',
    credentials: 'same-origin',
    headers: { 'X-Marks-CSRF': session.csrf, Accept: 'application/json' },
  });
  if (!response.ok && response.status !== 401) {
    throw new Error(`logout failed: ${response.status}`);
  }
  clearCachedSession();
  setActiveCaller(null);
}

export async function revokeDevice(deviceId: string): Promise<void> {
  const session = getCachedSession() ?? (await fetchSession());
  if (!session) throw new Error('revoke requires a live session');
  const response = await identityFetch(`/v1/auth/devices/${deviceId}`, {
    method: 'DELETE',
    credentials: 'same-origin',
    headers: { 'X-Marks-CSRF': session.csrf, Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`revoke failed: ${response.status}`);
}

export function pairingUrlFromTicket(ticket: PairingTicket): string {
  return ticket.url.includes('#')
    ? ticket.url
    : `${ticket.url}${pairingFragment(ticket.pairingId, decodeBase64Url(ticket.secret))}`;
}
