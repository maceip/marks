import { discoverChrome } from '../chrome.mjs';
import { CHROME_LAUNCH_ARGS, DEFAULT_VIEWPORT, launchEnv, resolveAppUrl } from '../env.mjs';
import { normalizeKey } from './session.mjs';

async function loadPuppeteer() {
  try {
    return (await import('puppeteer-core')).default;
  } catch {
    return (await import('puppeteer')).default;
  }
}

export async function launch(options = {}) {
  const chrome = options.chrome ?? discoverChrome();
  const executablePath = options.executablePath ?? chrome.automation;
  if (!executablePath) {
    throw new Error(
      'No Chrome executable for Puppeteer. Set CHROMIUM_PATH to a Chrome/Chromium binary.',
    );
  }

  const puppeteer = await loadPuppeteer();
  const browser = await puppeteer.launch({
    executablePath,
    args: CHROME_LAUNCH_ARGS,
    env: launchEnv(),
    headless: options.headless !== false,
    acceptInsecureCerts: true,
  });
  const page = await browser.newPage();
  const viewport = options.viewport ?? DEFAULT_VIEWPORT;
  await page.setViewport(viewport);
  return wrap({ browser, page, base: options.base, chrome });
}

export function wrap({ browser, page, base, chrome }) {
  return {
    name: 'puppeteer',
    engine: 'puppeteer',
    page,
    chromeHint: chrome?.automation ?? null,
    async goto(path = '/') {
      await page.goto(resolveAppUrl(path, base), { waitUntil: 'domcontentloaded' });
    },
    url() {
      return page.url();
    },
    async waitForSelector(selector, { timeout = 20_000 } = {}) {
      await page.waitForSelector(selector, { timeout });
    },
    async click(selector) {
      await page.click(selector);
    },
    async rightClick(selector, { x = 24, y = 24 } = {}) {
      const handle = await page.$(selector);
      if (!handle) throw new Error(`rightClick: ${selector} not found`);
      const box = await handle.boundingBox();
      if (!box) throw new Error(`rightClick: ${selector} has no box`);
      await page.mouse.click(box.x + x, box.y + y, { button: 'right' });
    },
    async fill(selector, value) {
      const handle = await page.$(selector);
      if (!handle) throw new Error(`fill: ${selector} not found`);
      await handle.click({ clickCount: 3 });
      await page.keyboard.press('Backspace');
      await handle.type(value);
    },
    async press(key) {
      const chord = normalizeKey(key, { lowerModifiers: true });
      const parts = chord.split('+');
      if (parts.length === 1) {
        await page.keyboard.press(parts[0]);
        return;
      }
      const letter = parts.at(-1);
      const modifiers = parts.slice(0, -1);
      for (const modifier of modifiers) await page.keyboard.down(modifier);
      try {
        await page.keyboard.press(letter);
      } finally {
        for (const modifier of modifiers.slice().reverse()) await page.keyboard.up(modifier);
      }
    },
    async type(text, { delay = 0 } = {}) {
      await page.keyboard.type(text, { delay });
    },
    async insertText(text) {
      const client = await page.createCDPSession();
      await client.send('Input.insertText', { text });
    },
    async evaluate(fn, arg) {
      return page.evaluate(fn, arg);
    },
    async textContent(selector) {
      return page.$eval(selector, (el) => el.innerText);
    },
    async count(selector) {
      return page.$$eval(selector, (els) => els.length);
    },
    async isVisible(selector) {
      const handle = await page.$(selector);
      if (!handle) return false;
      return handle.isVisible();
    },
    async isChecked(selector) {
      return page.$eval(selector, (el) => Boolean(el.checked));
    },
    async wait(ms) {
      await new Promise((resolve) => setTimeout(resolve, ms));
    },
    async setViewport(viewport) {
      await page.setViewport(viewport);
    },
    async setOffline(offline) {
      await page.setOfflineMode(Boolean(offline));
    },
    async screenshot(path, { fullPage = true } = {}) {
      await page.screenshot({ path, fullPage });
      return path;
    },
    async close() {
      await browser.close();
    },
  };
}
