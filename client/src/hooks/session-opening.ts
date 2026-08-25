import { runWithTimeout } from '../browser/network.ts';

export const SESSION_OPEN_TIMEOUT_MS = 30_000;

export interface DestroyableSession {
  destroy(): void;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

/**
 * Bound both the lazy module load and session construction. A constructor may
 * ignore cancellation (for example while a browser compiles Wasm), so the
 * continuation also destroys any session that arrives after the deadline.
 */
export function openSessionWithTimeout<T extends DestroyableSession>(
  loadFactory: () => Promise<() => Promise<T>>,
  options: { timeoutMs?: number; signal?: AbortSignal | null } = {},
): Promise<T> {
  return runWithTimeout(
    async (signal) => {
      const create = await loadFactory();
      if (signal.aborted) throw abortReason(signal);

      const session = await create();
      if (signal.aborted) {
        session.destroy();
        throw abortReason(signal);
      }
      return session;
    },
    options.timeoutMs ?? SESSION_OPEN_TIMEOUT_MS,
    options.signal,
    new DOMException(
      'The document session took too long to open. Check the connection and try again.',
      'TimeoutError',
    ),
  );
}
