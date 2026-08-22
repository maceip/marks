/* marks app-shell worker
 *
 * Cache the hashed assets and a copy of the navigation shell so a reload
 * still paints when the network is gone. Do not cache /v1 or /collab —
 * those are live document state, and a stale snapshot in this cache would
 * fight the CRDT replica already sitting in IndexedDB.
 *
 * Updates install in the background and take over on the next navigation.
 * We never prompt the user to refresh.
 */
const VERSION = 'v2';
const SHELL = `marks-shell-${VERSION}`;
const ASSETS = `marks-assets-${VERSION}`;
const CURRENT_CACHES = new Set([SHELL, ASSETS]);
const APP_SHELL = '/';
const MARKETING_SHELL = '/welcome/';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL).then((cache) =>
      Promise.all(
        [APP_SHELL, MARKETING_SHELL].map((path) =>
          cache.add(path).catch(() => undefined),
        ),
      ),
    ),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key.startsWith('marks-') && !CURRENT_CACHES.has(key))
          .map((key) => caches.delete(key)),
      ),
    ),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/v1') || url.pathname.startsWith('/collab')) return;

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirst(request));
    return;
  }

  if (request.mode === 'navigate') {
    const fallback = url.pathname.startsWith('/welcome') ? MARKETING_SHELL : APP_SHELL;
    event.respondWith(networkFirst(request, fallback));
  }
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(ASSETS);
    void cache.put(request, response.clone());
  }
  return response;
}

async function networkFirst(request, fallback) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(SHELL);
      void cache.put(fallback, response.clone());
    }
    return response;
  } catch {
    return (await caches.match(request)) || (await caches.match(fallback)) || Response.error();
  }
}
