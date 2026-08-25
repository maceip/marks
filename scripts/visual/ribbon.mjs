#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { chromium } from 'playwright';

const base = process.env.MARKS_URL ?? 'http://127.0.0.1:5173';
const update = process.env.UPDATE_RIBBON_SCREENSHOTS === '1';
const cases = [
  { name: 'phone-portrait-320x568-light', posture: 'phone', width: 320, height: 568, theme: 'light', density: 'comfortable', mobile: true },
  { name: 'phone-portrait-320x568-dark', posture: 'phone', width: 320, height: 568, theme: 'dark', density: 'comfortable', mobile: true },
  { name: 'phone-portrait-390x844-light', posture: 'phone', width: 390, height: 844, theme: 'light', density: 'comfortable', mobile: true },
  { name: 'phone-portrait-390x844-dark', posture: 'phone', width: 390, height: 844, theme: 'dark', density: 'comfortable', mobile: true },
  { name: 'phone-portrait-390x844-light-categories', posture: 'phone', width: 390, height: 844, theme: 'light', density: 'comfortable', mobile: true, categories: true },
  { name: 'phone-portrait-390x844-dark-view-ghost', posture: 'phone', width: 390, height: 844, theme: 'dark', density: 'comfortable', mobile: true, tab: 'view' },
  { name: 'phone-landscape-844x390-light', posture: 'phone', width: 844, height: 390, theme: 'light', density: 'comfortable', mobile: true },
  { name: 'phone-landscape-844x390-dark', posture: 'phone', width: 844, height: 390, theme: 'dark', density: 'comfortable', mobile: true },
  { name: 'studio-1024x800-light-comfortable', posture: 'studio', width: 1024, height: 800, theme: 'light', density: 'comfortable' },
  { name: 'studio-1024x800-dark-compact', posture: 'studio', width: 1024, height: 800, theme: 'dark', density: 'compact' },
  { name: 'studio-1024x800-dark-collapsed', posture: 'studio', width: 1024, height: 800, theme: 'dark', density: 'comfortable', collapsed: true },
  { name: 'desktop-1440x900-light-comfortable', posture: 'desktop', width: 1440, height: 900, theme: 'light', density: 'comfortable' },
  { name: 'desktop-1440x900-dark-compact', posture: 'desktop', width: 1440, height: 900, theme: 'dark', density: 'compact' },
  { name: 'desktop-1440x900-light-contextual', posture: 'desktop', width: 1440, height: 900, theme: 'light', density: 'comfortable', contextual: true },
  { name: 'fold-book-1280x800-light-comfortable', posture: 'fold-book', width: 1280, height: 800, theme: 'light', density: 'comfortable' },
  { name: 'fold-book-1280x800-dark-compact', posture: 'fold-book', width: 1280, height: 800, theme: 'dark', density: 'compact' },
  { name: 'fold-laptop-840x1100-light-comfortable', posture: 'fold-laptop', width: 840, height: 1100, theme: 'light', density: 'comfortable' },
  { name: 'fold-laptop-840x1100-dark-compact', posture: 'fold-laptop', width: 840, height: 1100, theme: 'dark', density: 'compact' },
];

assert.equal(new Set(cases.map((item) => item.name)).size, cases.length, 'visual case names must be unique');
for (const [width, height] of [[320, 568], [390, 844], [844, 390]]) {
  const themes = new Set(cases
    .filter((item) => item.posture === 'phone' && item.width === width && item.height === height)
    .map((item) => item.theme));
  assert.deepEqual(themes, new Set(['light', 'dark']), `${width}x${height} phone coverage must include light and dark`);
}
for (const posture of ['desktop', 'fold-book', 'fold-laptop']) {
  const themes = new Set(cases.filter((item) => item.posture === posture).map((item) => item.theme));
  assert.deepEqual(themes, new Set(['light', 'dark']), `${posture} coverage must include light and dark`);
}
if (process.argv.includes('--list')) {
  for (const item of cases) console.log(item.name);
  process.exit(0);
}

const browser = await chromium.launch({ headless: true });
try {
  for (const item of cases) {
    const page = await browser.newPage({
      viewport: { width: item.width, height: item.height },
      deviceScaleFactor: 1,
      isMobile: item.mobile ?? false,
      hasTouch: item.mobile ?? false,
    });
    await page.emulateMedia({ colorScheme: item.theme, reducedMotion: 'reduce' });
    await page.addInitScript(({ theme, density, collapsed }) => {
      localStorage.setItem('marks:theme', theme);
      localStorage.setItem('marks:user', JSON.stringify({
        name: 'Visual Reviewer',
        colorIndex: 3,
        id: 'visual-reviewer',
      }));
      localStorage.setItem('marks:ui-preferences:v1', JSON.stringify({
        density,
        glass: true,
        motion: false,
      }));
      localStorage.setItem('marks:ribbon-collapsed', String(Boolean(collapsed)));
      sessionStorage.setItem('marks:surface-tier:v1', 'foundation');
    }, item);
    await page.goto(urlFor(item.posture));
    await page.locator('.app-ribbon').waitFor();
    const documentRibbon = page.locator('.app-ribbon.ribbon-document');
    const create = page.locator('.new-doc .button.primary, .home-actions .button.primary').first();
    if (!(await documentRibbon.isVisible())) {
      await create.waitFor();
      await create.click();
    }
    await documentRibbon.waitFor();
    await page.locator('.toast button[aria-label="Dismiss notification"]').evaluateAll((buttons) => {
      buttons.forEach((button) => button.click());
    });
    await page.locator('.toast').waitFor({ state: 'detached', timeout: 2_000 }).catch(() => undefined);
    if (new URL(page.url()).searchParams.get('marks-posture') !== item.posture) {
      await page.goto(urlFor(item.posture, page.url()));
      await documentRibbon.waitFor();
    }
    await page.locator(`html[data-shell="${item.posture}"]`).waitFor();
    await page.locator('.ribbon-loading').waitFor({ state: 'detached' });
    const command = item.posture === 'phone'
      ? page.locator('.phone-ribbon [data-command-id]').first()
      : page.locator('.ribbon-body [data-command-id]').first();
    await command.waitFor({ state: 'attached' });
    if (item.categories || item.tab) {
      await page.locator('.phone-category-trigger').click();
      await page.locator('.phone-category-sheet').waitFor();
    }
    if (item.tab) {
      await page.locator(`[data-ribbon-tab="${item.tab}"]`).click();
      await page.locator(`.phone-ribbon [data-command-id="view.ghost-overlay"]`).waitFor({ state: 'attached' });
    }
    if (item.contextual) {
      await page.locator('.ribbon-tabs').evaluate((tabs) => {
        const tab = document.createElement('button');
        tab.className = 'ribbon-tab contextual active';
        tab.setAttribute('role', 'tab');
        tab.setAttribute('aria-selected', 'true');
        tab.textContent = 'Picture';
        tabs.append(tab);
      });
    }
    const capture = item.categories
      ? page.locator('.phone-category-layer')
      : item.posture === 'phone'
        ? page.locator('.phone-ribbon')
        : page.locator('.app-ribbon');
    const image = await capture.screenshot({ animations: 'disabled' });
    const path = resolve('docs/screenshots/ribbon', `${item.name}.png`);
    if (update) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, image);
    } else {
      const baseline = await readFile(path);
      assert.ok(image.equals(baseline), `${item.name} differs; inspect then update baselines intentionally`);
    }
    await page.close();
  }
} finally {
  await browser.close();
}

function urlFor(posture, input = base) {
  const url = new URL(input);
  url.searchParams.set('marks-posture', posture);
  return url.toString();
}
