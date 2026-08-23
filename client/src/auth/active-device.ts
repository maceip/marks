import { get, set } from 'idb-keyval';

const ACTIVE_KEY = 'marks.auth.active-device.v1';

export interface ActiveDevice {
  version: 1;
  deviceId: string;
  enrolled: boolean;
  controllerId?: string;
}

export async function loadActiveDevice(): Promise<ActiveDevice | undefined> {
  try {
    const record = await get<ActiveDevice>(ACTIVE_KEY);
    if (!record || record.version !== 1 || typeof record.deviceId !== 'string') return undefined;
    return record;
  } catch {
    return undefined;
  }
}

export async function saveActiveDevice(record: ActiveDevice): Promise<void> {
  await set(ACTIVE_KEY, record);
}

export async function markDeviceEnrolled(deviceId: string): Promise<void> {
  const current = await loadActiveDevice();
  await saveActiveDevice({
    version: 1,
    deviceId,
    enrolled: true,
    controllerId: current?.deviceId === deviceId ? current.controllerId : undefined,
  });
}

export async function markController(controllerId: string, deviceId: string): Promise<void> {
  await saveActiveDevice({ version: 1, deviceId, enrolled: true, controllerId });
}
