import { hasServiceWorker, isAutomatedBrowser } from './platform.ts';

/**
 * Register the app-shell service worker.
 *
 * Rules chosen so caching does not become a product:
 *  - never in Vite dev (it would pin a stale module graph)
 *  - never under WebDriver (smoke tests must see this build)
 *  - the worker script itself is never satisfied by the HTTP cache
 *    (`updateViaCache: 'none'`): a cached sw.js is the classic way
 *    production updates stop reaching installed clients
 *  - updates are *sought*, not awaited: the browser's own check only runs
 *    on navigations (or at most daily), and a long-lived SPA tab never
 *    navigates — so check on visibility, on regained network, and hourly
 *  - the worker activates immediately on install (skipWaiting + claim in
 *    sw.js); old tabs stay coherent because the server keeps serving every
 *    retained release's hashed assets from the shared pool
 */
export function registerServiceWorker(): void {
  if (
    !hasServiceWorker()
    || (isAutomatedBrowser() && import.meta.env.VITE_MARKS_TEST_SERVICE_WORKER !== '1')
  ) return;
  if (typeof import.meta !== 'undefined' && import.meta.env?.DEV) return;

  const register = () => {
    void navigator.serviceWorker
      .register('/sw.js', { scope: '/', updateViaCache: 'none' })
      .catch(() => undefined);
  };

  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });

  const checkForUpdate = () => {
    void navigator.serviceWorker
      .getRegistration()
      .then((registration) => registration?.update())
      .catch(() => undefined);
  };

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkForUpdate();
  });
  window.addEventListener('online', checkForUpdate);
  window.setInterval(checkForUpdate, 60 * 60 * 1000);
}
