import { applyServiceCallerHeaders, ensureServiceCaller } from './caller.ts';
import { fetchWithTimeout, SERVICE_REQUEST_TIMEOUT_MS } from '../browser/network.ts';
import {
  loadActiveDevice,
  markController,
  markDeviceEnrolled,
  saveActiveDevice,
} from './active-device.ts';
import { generateDeviceKey, loadDeviceKey, saveDeviceKey, type StoredDeviceKey } from './device-key.ts';
import { encodeBase64Url } from './protocol.ts';
import { createOpaqueId } from './scratch.ts';

export type { ActiveDevice } from './active-device.ts';
export { loadActiveDevice, markController, markDeviceEnrolled };

/** Generate the pending browser key without waiting on the network. */
export async function getOrCreatePendingDevice(): Promise<StoredDeviceKey> {
  const active = await loadActiveDevice();
  if (active) {
    const existing = await loadDeviceKey(active.deviceId);
    if (existing) return existing;
  }
  const key = await generateDeviceKey(createOpaqueId('device'));
  await saveDeviceKey(key);
  await saveActiveDevice({ version: 1, deviceId: key.deviceId, enrolled: false });
  return key;
}

export async function bindPendingDevice(): Promise<StoredDeviceKey> {
  const caller = await ensureServiceCaller();
  if (caller.kind !== 'scratch') {
    throw new Error('pending device bind requires scratch authority');
  }
  const key = await getOrCreatePendingDevice();
  const headers = new Headers({ 'Content-Type': 'application/json' });
  applyServiceCallerHeaders(headers, caller);
  const response = await fetchWithTimeout(
    `/v1/auth/scratch/${caller.credential.scratchId}/device`,
    {
      method: 'PUT',
      credentials: 'same-origin',
      headers,
      body: JSON.stringify({
        deviceId: key.deviceId,
        publicKey: encodeBase64Url(key.publicKeyRaw),
      }),
    },
    SERVICE_REQUEST_TIMEOUT_MS,
  );
  if (!response.ok) {
    throw new Error(`pending device bind failed: ${response.status}`);
  }
  return key;
}
