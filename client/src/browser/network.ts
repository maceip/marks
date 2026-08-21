/**
 * Connection quality as the editor should treat it.
 *
 * `slow` is not a third CRDT state — the replica still accepts keystrokes.
 * It changes *what we wait on*: skip the HTTP snapshot if a local copy is
 * already on screen, defer mermaid, and tell the status bar the truth.
 */

export type NetworkQuality = 'online' | 'slow' | 'offline';

interface NavigatorConnection {
  effectiveType?: string;
  saveData?: boolean;
  downlink?: number;
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
}

function connection(): NavigatorConnection | undefined {
  if (typeof navigator === 'undefined') return undefined;
  return (navigator as Navigator & { connection?: NavigatorConnection }).connection;
}

export function readNetworkQuality(): NetworkQuality {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'offline';

  const info = connection();
  if (!info) return 'online';
  if (info.saveData) return 'slow';
  if (info.effectiveType === 'slow-2g' || info.effectiveType === '2g') return 'slow';
  if (typeof info.downlink === 'number' && info.downlink > 0 && info.downlink < 0.4) return 'slow';
  return 'online';
}

export function snapshotFetchTimeoutMs(quality: NetworkQuality, hasLocalCopy: boolean): number {
  if (quality === 'offline') return 0;
  if (quality === 'slow') return hasLocalCopy ? 2_500 : 6_000;
  return hasLocalCopy ? 5_000 : 10_000;
}

export function subscribeNetwork(listener: (quality: NetworkQuality) => void): () => void {
  if (typeof window === 'undefined') return () => undefined;

  const emit = () => listener(readNetworkQuality());
  window.addEventListener('online', emit);
  window.addEventListener('offline', emit);

  const info = connection();
  info?.addEventListener?.('change', emit);

  return () => {
    window.removeEventListener('online', emit);
    window.removeEventListener('offline', emit);
    info?.removeEventListener?.('change', emit);
  };
}

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  if (timeoutMs <= 0) throw new DOMException('The user aborted a request.', 'AbortError');

  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    window.clearTimeout(timer);
  }
}
