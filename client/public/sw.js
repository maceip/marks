/* marks app-shell worker
 *
 * Cache the hashed assets and a copy of the navigation shell so a reload
 * still paints when the network is gone. Do not cache /api or /collab —
 * those are live document state, and a stale snapshot in this cache would
 * fight the CRDT replica already sitting in IndexedDB.
 *
 * Updates install in the background and take over on the next navigation.
 * We never prompt the user to refresh.
 */
const SHELL = 'marks-shell-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL).then((cache) => cache.addAll(['/']).catch(() => undefined)),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== SHELL).map((key) => caches.delete(key))),
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
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/collab')) return;

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirst(request));
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request));
  }
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(SHELL);
    void cache.put(request, response.clone());
  }
  return response;
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(SHELL);
      void cache.put('/', response.clone());
    }
    return response;
  } catch {
    return (await caches.match(request)) || (await caches.match('/')) || Response.error();
  }
}
