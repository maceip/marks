export type PairingPollResult<T> = T | 'pending' | 'gone';

export interface PairingPollOptions<T> {
  expiresAtMs: number;
  finalize: (signal: AbortSignal) => Promise<PairingPollResult<T>>;
  signal: AbortSignal;
  intervalMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

function sleepWithSignal(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(done, Math.max(1, milliseconds));
    function done() {
      signal.removeEventListener('abort', aborted);
      resolve();
    }
    function aborted() {
      globalThis.clearTimeout(timer);
      reject(abortError(signal));
    }
    signal.addEventListener('abort', aborted, { once: true });
  });
}

/**
 * Poll one pairing request at a time and stop at the server-issued expiry.
 * Network failures remain retryable until that hard boundary; cancellation
 * from an unmounted dialog rejects immediately.
 */
export async function pollPairingUntilSettled<T>(
  options: PairingPollOptions<T>,
): Promise<T | 'gone'> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? sleepWithSignal;
  const intervalMs = options.intervalMs ?? 1_500;

  while (true) {
    if (options.signal.aborted) throw abortError(options.signal);
    const remaining = options.expiresAtMs - now();
    if (remaining <= 0) return 'gone';

    const request = new AbortController();
    let expired = false;
    const cancel = () => request.abort(options.signal.reason);
    options.signal.addEventListener('abort', cancel, { once: true });
    const expiryTimer = globalThis.setTimeout(() => {
      expired = true;
      request.abort(new DOMException('The pairing expired.', 'TimeoutError'));
    }, Math.max(1, remaining));

    let result: PairingPollResult<T> = 'pending';
    try {
      result = await options.finalize(request.signal);
    } catch {
      if (options.signal.aborted) throw abortError(options.signal);
      if (expired || now() >= options.expiresAtMs) return 'gone';
      // A transient request timeout/offline edge gets one later retry. There
      // is never another request in flight until this one has settled.
    } finally {
      globalThis.clearTimeout(expiryTimer);
      options.signal.removeEventListener('abort', cancel);
    }

    if (result !== 'pending') return result;
    const wait = Math.min(intervalMs, options.expiresAtMs - now());
    if (wait <= 0) return 'gone';
    await sleep(wait, options.signal);
  }
}
