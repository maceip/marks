/**
 * Connection quality as the editor should treat it.
 *
 * `slow` is not a third CRDT state — the replica still accepts keystrokes.
 * It changes *what we wait on*: skip the HTTP snapshot if a local copy is
 * already on screen, defer mermaid, and tell the status bar the truth.
 */

export type NetworkQuality = 'online' | 'slow' | 'offline';

/** Ordinary metadata/auth calls should never leave the shell unresolved. */
export const SERVICE_REQUEST_TIMEOUT_MS = 15_000;
/** Import conversion includes a bounded server-side worker/network budget. */
export const IMPORT_REQUEST_TIMEOUT_MS = 35_000;

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

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

/**
 * Enforce one absolute deadline even when an underlying browser API ignores
 * cancellation. The operation still receives a signal so cooperative work is
 * stopped instead of merely detached from the caller.
 */
export async function runWithTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal | null,
): Promise<T> {
  if (signal?.aborted) throw abortReason(signal);
  if (timeoutMs <= 0) throw new DOMException('The operation timed out.', 'TimeoutError');

  const controller = new AbortController();
  const propagateAbort = () => controller.abort(signal ? abortReason(signal) : undefined);
  signal?.addEventListener('abort', propagateAbort, { once: true });
  let rejectAbort: ((reason: unknown) => void) | null = null;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const rejectFromSignal = () => rejectAbort?.(abortReason(controller.signal));
  controller.signal.addEventListener('abort', rejectFromSignal, { once: true });
  const timer = globalThis.setTimeout(
    () => controller.abort(new DOMException('The operation timed out.', 'TimeoutError')),
    timeoutMs,
  );

  try {
    const completed = Promise.resolve().then(() => operation(controller.signal));
    return await Promise.race([completed, aborted]);
  } finally {
    globalThis.clearTimeout(timer);
    signal?.removeEventListener('abort', propagateAbort);
    controller.signal.removeEventListener('abort', rejectFromSignal);
    rejectAbort = null;
  }
}

export async function fetchWithTimeout(
  url: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<Response> {
  return runWithTimeout(
    async (signal) => {
      const response = await fetchImpl(url, { ...init, signal });
      if (response.body === null) return response;

      // `fetch()` resolves as soon as response headers arrive. Read the body
      // inside the same deadline so a peer that sends headers and then stalls
      // cannot leave JSON, snapshot, or download parsing pending forever.
      const body = await response.arrayBuffer();
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    },
    timeoutMs,
    init.signal,
  );
}
