const ANONYMOUS_STARTER_REQUEST_KEY = 'marks:anonymous-starter-request:v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type RequestStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
let volatilePendingRequest: string | null = null;

/**
 * Keep one retry identity across a reload until the server confirms the
 * anonymous starter. A committed POST whose response was lost can therefore
 * replay to the same public slug instead of creating a second page.
 */
export function anonymousStarterRequestId(
  storage: RequestStorage = sessionStorage,
  makeId: () => string = () => crypto.randomUUID(),
): string {
  let stored: string | null;
  try {
    stored = storage.getItem(ANONYMOUS_STARTER_REQUEST_KEY);
  } catch {
    stored = null;
  }
  stored ??= volatilePendingRequest;
  if (stored && UUID.test(stored)) return stored;
  const created = makeId();
  if (!UUID.test(created)) throw new TypeError('anonymous starter request id must be a UUID');
  volatilePendingRequest = created;
  try {
    storage.setItem(ANONYMOUS_STARTER_REQUEST_KEY, created);
  } catch {
    // Storage-denied browsers retain the key for the current page lifetime.
  }
  return created;
}

export function confirmAnonymousStarterRequest(
  requestId: string,
  storage: RequestStorage = sessionStorage,
): void {
  if (volatilePendingRequest === requestId) volatilePendingRequest = null;
  try {
    if (storage.getItem(ANONYMOUS_STARTER_REQUEST_KEY) === requestId) {
      storage.removeItem(ANONYMOUS_STARTER_REQUEST_KEY);
    }
  } catch {
    // The volatile identity above still prevents duplicate work on this page.
  }
}
