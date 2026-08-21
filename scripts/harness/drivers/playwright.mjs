import { chromium } from 'playwright';
import { discoverChrome } from '../chrome.mjs';
import { CHROME_LAUNCH_ARGS, DEFAULT_VIEWPORT, launchEnv, resolveAppUrl } from '../env.mjs';

export async function launch(options = {}) {
  const chrome = options.chrome ?? discoverChrome();
  const executablePath = options.executablePath ?? process.env.CHROMIUM_PATH ?? undefined;
  const browser = await chromium.launch({
    executablePath,
    args: CHROME_LAUNCH_ARGS,
    env: launchEnv(),
    headless: options.headless !== false,
  });
  const context = await browser.newContext({
    viewport: options.viewport ?? DEFAULT_VIEWPORT,
  });
  const page = await context.newPage();
  return wrap({ browser, context, page, base: options.base, chrome });
}

export function wrap({ browser, context, page, base, chrome }) {
  return {
    name: 'playwright',
    engine: 'playwright',
    page,
    chromeHint: chrome?.playwright ?? chrome?.automation ?? null,
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
      await page.locator(selector).first().click({ button: 'right', position: { x, y } });
    },
    async fill(selector, value) {
      await page.fill(selector, value);
    },
    async press(key) {
      await page.keyboard.press(key);
    },
    async type(text, { delay = 0 } = {}) {
      await page.keyboard.type(text, { delay });
    },
    async insertText(text) {
      await page.keyboard.insertText(text);
    },
    async evaluate(fn, arg) {
      return page.evaluate(fn, arg);
    },
    async textContent(selector) {
      return page.locator(selector).first().innerText();
    },
    async count(selector) {
      return page.locator(selector).count();
    },
    async isVisible(selector) {
      return page.locator(selector).first().isVisible();
    },
    async isChecked(selector) {
      return page.locator(selector).first().isChecked();
    },
    async wait(ms) {
      await page.waitForTimeout(ms);
    },
    async setOffline(offline) {
      await context.setOffline(Boolean(offline));
    },
    async close() {
      await browser.close();
    },
  };
}
