import { surfaceRuntime } from './surface/runtime';

const root = document.documentElement;
const themeButton = document.querySelector<HTMLButtonElement>('.marketing-theme');

function setTheme(theme: 'light' | 'dark') {
  root.dataset.theme = theme;
  try {
    localStorage.setItem('marks:theme', theme);
  } catch {
    // A private browsing session can still use the selected theme for this page.
  }
  themeButton?.setAttribute(
    'aria-label',
    theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme',
  );
}

themeButton?.addEventListener('click', () => {
  setTheme(root.dataset.theme === 'dark' ? 'light' : 'dark');
});
setTheme(root.dataset.theme === 'dark' ? 'dark' : 'light');

const demo = document.querySelector<HTMLElement>('.product-stage');
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-mode]')) {
  button.addEventListener('click', () => {
    const mode = button.dataset.mode;
    if (!demo || !mode) return;
    demo.dataset.demoMode = mode;
    for (const peer of document.querySelectorAll<HTMLButtonElement>('[data-mode]')) {
      peer.setAttribute('aria-pressed', String(peer === button));
    }
  });
}

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
if (!reduceMotion && 'IntersectionObserver' in window) {
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      }
    },
    { rootMargin: '0px 0px -10% 0px', threshold: 0.08 },
  );
  for (const element of document.querySelectorAll('.reveal:not(.is-visible)')) observer.observe(element);
} else {
  for (const element of document.querySelectorAll('.reveal')) element.classList.add('is-visible');
}

for (const year of document.querySelectorAll<HTMLElement>('[data-year]')) {
  year.textContent = String(new Date().getFullYear());
}

// Marketing paints its complete CSS glass first. The same app renderer joins
// after first paint on capable devices; nothing shader-related blocks the CTA.
if (surfaceRuntime.supportsShader) {
  const attachMaterials = () => {
    void import('./surface/renderer').then(({ mountSurfaceMaterial }) => {
      const cleanups: Array<() => void> = [];
      const nav = document.querySelector<HTMLElement>('.marketing-nav');
      const demoWindow = document.querySelector<HTMLElement>('.demo-window');
      if (nav) cleanups.push(mountSurfaceMaterial(nav, { variant: 'chrome', intensity: 0.9 }));
      if (demoWindow) {
        if ('IntersectionObserver' in window) {
          const observer = new IntersectionObserver(
            (entries) => {
              if (!entries[0]?.isIntersecting) return;
              cleanups.push(
                mountSurfaceMaterial(demoWindow, { variant: 'hero', intensity: 0.98 }),
              );
              observer.disconnect();
            },
            { rootMargin: '240px 0px', threshold: 0.01 },
          );
          observer.observe(demoWindow);
          cleanups.push(() => observer.disconnect());
        } else {
          cleanups.push(
            mountSurfaceMaterial(demoWindow, { variant: 'hero', intensity: 0.98 }),
          );
        }
      }
      window.addEventListener('pagehide', () => cleanups.forEach((cleanup) => cleanup()), {
        once: true,
      });
    });
  };
  if ('requestIdleCallback' in window) {
    window.requestIdleCallback(attachMaterials, { timeout: 780 });
  } else {
    setTimeout(attachMaterials, 90);
  }
}
