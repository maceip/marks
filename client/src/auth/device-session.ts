import { loadActiveDevice, markDeviceEnrolled } from './active-device.ts';
import { loadDeviceKey, signDeviceSessionProof } from './device-key.ts';
import { requestDurableStorage } from './durable-storage.ts';
import { decodeBase64Url, encodeBase64Url } from './protocol.ts';
import { cacheSession, sessionFromUnknown, type SessionInfo } from './session-cache.ts';

/**
 * Silent return-visit recovery. Only runs when this origin already enrolled
 * the stored device key. A pending-only key does not pay this round trip.
 */
export async function redeemEnrolledDevice(
  fetchImpl: typeof fetch = fetch,
): Promise<SessionInfo | null> {
  const active = await loadActiveDevice();
  if (!active?.enrolled) return null;
  const key = await loadDeviceKey(active.deviceId);
  if (!key) return null;

  const challengeResponse = await fetchImpl('/v1/auth/device/challenges', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ deviceId: key.deviceId }),
  });
  if (!challengeResponse.ok) return null;
  const challengeBody = (await challengeResponse.json()) as {
    challengeId?: unknown;
    challenge?: unknown;
    audience?: unknown;
    expiresAtMs?: unknown;
  };
  if (
    typeof challengeBody.challengeId !== 'string' ||
    typeof challengeBody.challenge !== 'string' ||
    typeof challengeBody.audience !== 'string' ||
    typeof challengeBody.expiresAtMs !== 'number'
  ) {
    return null;
  }

  const now = Date.now();
  const proof = {
    version: 1 as const,
    challengeId: challengeBody.challengeId,
    deviceId: key.deviceId,
    deviceKeyEpoch: 1n,
    audience: challengeBody.audience,
    challenge: decodeBase64Url(challengeBody.challenge),
    issuedAtMs: BigInt(now),
    expiresAtMs: BigInt(Math.max(now + 1_000, challengeBody.expiresAtMs - 1_000)),
  };
  const signature = await signDeviceSessionProof(key.privateKey, proof);
  const redeem = await fetchImpl('/v1/auth/device/redeem', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      proof: {
        version: 1,
        challengeId: proof.challengeId,
        deviceId: proof.deviceId,
        deviceKeyEpoch: Number(proof.deviceKeyEpoch),
        audience: proof.audience,
        challenge: challengeBody.challenge,
        issuedAtMs: now,
        expiresAtMs: Number(proof.expiresAtMs),
      },
      signature: encodeBase64Url(signature),
    }),
  });
  if (!redeem.ok) return null;
  const session = sessionFromUnknown(await redeem.json());
  if (!session) return null;
  cacheSession(session);
  void markDeviceEnrolled(session.deviceId).catch(() => undefined);
  void requestDurableStorage();
  return session;
}
