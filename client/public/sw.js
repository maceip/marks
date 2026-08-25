/* marks app-shell worker
 *
 * Cache the hashed assets and a copy of the navigation shell so a reload
 * still paints when the network is gone. Do not cache /v1 or /collab —
 * those are live document state, and a stale snapshot in this cache would
 * fight the CRDT replica already sitting in IndexedDB.
 *
 * Updates take over immediately: waiting for every tab to close is the
 * classic way production updates silently fail to roll out, and an old tab
 * stays coherent anyway because the server serves every retained release's
 * hashed assets from the shared pool. We never prompt the user to refresh.
 *
 * VERSION is stamped by the client build from a digest of the entry
 * documents and the ESBT component manifest. Any release that changes the
 * shell or the stable-path component artifacts changes this file
 * byte-for-byte, which is what makes the browser install the new worker;
 * activation then drops every cache from the previous namespace, so a
 * cache-first stable URL can never keep serving a prior release's
 * component. 'dev' appears only when the unstamped public/ copy is served
 * directly.
 */
const VERSION = 'dev';
const SHELL = `marks-shell-${VERSION}`;
const ASSETS = `marks-assets-${VERSION}`;
const CURRENT_CACHES = new Set([SHELL, ASSETS]);
const APP_SHELL = '/';
const MARKETING_SHELL = '/welcome/';
const ROOT_RUNTIME = new Set([
  '/esbt.component.manifest.json',
  '/esbt.component.wasm',
  '/esbt.wit',
  '/manifest.webmanifest',
  '/theme-bootstrap.js',
]);

self.addEventListener('install', (event) => {
  event.waitUntil(precacheCoherentShell());
  // Activate as soon as the coherent precache commits; activation drops
  // every cache namespace from the previous release.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      caches.keys().then((keys) =>
        Promise.all(
        keys
          .filter((key) => key.startsWith('marks-') && !CURRENT_CACHES.has(key))
          .map((key) => caches.delete(key)),
        ),
      ),
      self.clients.claim(),
    ]),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/v1') || url.pathname.startsWith('/collab')) return;

  if (url.pathname.startsWith('/assets/') || isRootRuntime(url.pathname)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  if (request.mode === 'navigate') {
    const fallback = url.pathname.startsWith('/welcome') ? MARKETING_SHELL : APP_SHELL;
    event.respondWith(networkFirst(request, fallback));
  }
});

async function precacheCoherentShell() {
  const cache = await caches.open(SHELL);
  const manifestResponse = await fetch('/esbt.component.manifest.json');
  if (!manifestResponse.ok) throw new Error('ESBT component manifest is unavailable');
  const manifest = await manifestResponse.clone().json();
  if (!Array.isArray(manifest.core_modules)
      || manifest.core_modules.length === 0
      || manifest.core_modules.length > 16) {
    throw new Error('ESBT component manifest has an invalid core-module set');
  }
  const componentPaths = [
    manifest.component?.path,
    '/esbt.wit',
    ...(manifest.core_modules ?? []).map((entry) => entry.path),
  ];
  if (componentPaths.some((path) => !isComponentPath(path))) {
    throw new Error('ESBT component manifest contains an unsafe runtime path');
  }
  if (new Set(componentPaths).size !== componentPaths.length) {
    throw new Error('ESBT component manifest repeats a runtime path');
  }
  await cache.put('/esbt.component.manifest.json', manifestResponse);
  await Promise.all([
    APP_SHELL,
    MARKETING_SHELL,
    '/manifest.webmanifest',
    '/theme-bootstrap.js',
    ...componentPaths,
  ].map((path) => cache.add(path)));
}

function isComponentPath(path) {
  return path === '/esbt.component.wasm'
    || path === '/esbt.wit'
    || /^\/esbt\.core\d*\.wasm$/.test(path);
}

function isRootRuntime(path) {
  return ROOT_RUNTIME.has(path) || /^\/esbt\.core\d*\.wasm$/.test(path);
}

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
