/**
 * Shared launch policy for every browser platform.
 *
 * Proxy env vars must not intercept localhost. Container Chrome needs
 * --no-sandbox. These apply to Playwright, Puppeteer, and the Chrome
 * process that agent-browser attaches to.
 */

export const DEFAULT_URL = process.env.MARKS_URL ?? 'http://localhost:3000';

export const DEFAULT_VIEWPORT = { width: 1440, height: 900 };

export const CHROME_LAUNCH_ARGS = [
  '--no-proxy-server',
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--password-store=basic',
];

export function launchEnv(source = process.env) {
  return Object.fromEntries(
    Object.entries(source).filter(([key]) => !/^(https?_proxy|all_proxy|no_proxy)$/i.test(key)),
  );
}

export function resolveAppUrl(path = '/', base = DEFAULT_URL) {
  if (/^https?:\/\//i.test(path) || path.startsWith('data:') || path.startsWith('about:')) {
    return path;
  }
  const origin = base.replace(/\/$/, '');
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${origin}${suffix}`;
}

export function parseBooleanFlag(value) {
  if (value === true || value === false) return value;
  if (value == null) return false;
  return /^(1|true|yes|on)$/i.test(String(value));
}
