#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { chromium } from 'playwright';

const base = process.env.MARKS_URL ?? 'http://127.0.0.1:5173';
const update = process.env.UPDATE_RIBBON_SCREENSHOTS === '1';
const cases = [
  { name: 'desktop-light-comfortable', width: 1024, theme: 'light', density: 'comfortable' },
  { name: 'desktop-dark-compact', width: 1024, theme: 'dark', density: 'compact' },
  { name: 'studio-light-comfortable', width: 1440, theme: 'light', density: 'comfortable' },
  { name: 'studio-dark-compact', width: 1440, theme: 'dark', density: 'compact' },
  { name: 'studio-contextual', width: 1440, theme: 'light', density: 'comfortable', contextual: true },
  { name: 'desktop-collapsed', width: 1024, theme: 'dark', density: 'comfortable', collapsed: true },
];

const browser = await chromium.launch({ headless: true });
try {
  for (const item of cases) {
    const page = await browser.newPage({ viewport: { width: item.width, height: 800 }, deviceScaleFactor: 1 });
    await page.addInitScript(({ theme, density, collapsed }) => {
      localStorage.setItem('marks:theme', theme);
      localStorage.setItem('marks:density', density);
      localStorage.setItem('marks:ribbon-collapsed', String(collapsed));
    }, item);
    await page.goto(base);
    const create = page.locator('.new-doc .button.primary, .home-actions .button.primary').first();
    if (await create.isVisible()) await create.click();
    await page.locator('.app-ribbon.ribbon-document').waitFor();
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
    const image = await page.locator('.app-ribbon').screenshot({ animations: 'disabled' });
    const path = resolve('docs/screenshots/ribbon', `${item.name}.png`);
    if (update) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, image);
    } else {
      const baseline = await readFile(path);
      assert.deepEqual(image, baseline, `${item.name} differs; inspect then update baselines intentionally`);
    }
    await page.close();
  }
} finally {
  await browser.close();
}
