import { hasServiceWorker, isAutomatedBrowser } from './platform.ts';

/**
 * Register the app-shell service worker.
 *
 * Rules chosen so caching does not become a product:
 *  - never in Vite dev (it would pin a stale module graph)
 *  - never under WebDriver (smoke tests must see this build)
 *  - first install may claim clients so a reload is enough to go offline
 *  - later updates wait for the next navigation — no "refresh now?" toast
 */
export function registerServiceWorker(): void {
  if (!hasServiceWorker() || isAutomatedBrowser()) return;
  if (typeof import.meta !== 'undefined' && import.meta.env?.DEV) return;

  const register = () => {
    void navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then((registration) => {
        registration.addEventListener('updatefound', () => {
          const worker = registration.installing;
          if (!worker) return;
          worker.addEventListener('statechange', () => {
            if (worker.state === 'installed' && !navigator.serviceWorker.controller) {
              worker.postMessage('skipWaiting');
            }
          });
        });
      })
      .catch(() => undefined);
  };

  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    void navigator.serviceWorker.getRegistration().then((registration) => registration?.update());
  });
}
