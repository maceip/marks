import { chromium } from 'playwright';
import { preview } from 'vite';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const distFiles = await readdir(new URL('../client/dist/assets/', import.meta.url));
const index = await readFile(new URL('../client/dist/index.html', import.meta.url), 'utf8');
const inventory = JSON.parse(await readFile(new URL('../docs/design-system-inventory.json', import.meta.url), 'utf8'));
assert(!index.includes('design-system.css'), 'catalog CSS must not be in the entry document');
assert(distFiles.some((name) => name.startsWith('DesignSystem-')), 'catalog must be a separate lazy chunk');
const port = 4197;
// Await Vite's programmatic preview server instead of racing a detached npm
// child against a fixed sleep. On a cold CI runner npm/Vite startup can exceed
// the old six-second poll window even though the production build is valid.
const server = await preview({
  root: fileURLToPath(new URL('../client/', import.meta.url)),
  logLevel: 'error',
  preview: {
    host: '127.0.0.1',
    port,
    strictPort: true,
  },
});
try {
  const response = await fetch(`http://127.0.0.1:${port}/design-system`, {
    signal: AbortSignal.timeout(5_000),
  });
  assert(response.ok, `Vite preview returned ${response.status} for the design-system catalog`);
  await mkdir(new URL('../artifacts/design-system/', import.meta.url), { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`http://127.0.0.1:${port}/design-system`);
  await page.locator('.ds-header h1').waitFor();
  assert.equal(await page.locator('main section').count(), 9, 'all catalog sections render');
  assert.equal(await page.locator('[aria-label="button state matrix"] > *').count(), 11, 'complete state matrix renders');
  assert.equal(await page.locator('[data-design-system-entry]').count(), 4, 'all authoritative entry points render');
  assert.equal(await page.locator('[data-design-system-owner]').count(), 17, 'all canonical owners render');
  assert.equal(await page.locator('[data-design-system-rule]').count(), 6, 'all enforcement rules render');
  assert.equal(await page.locator('[data-design-system-exception]').count(), 5, 'all explicit exceptions render');

  const expectedIcons = inventory.icons.entries;
  assert.equal(await page.locator('#foundations .marks-icon[data-icon]').count(), expectedIcons.length, 'every registered icon renders');
  await page.waitForFunction(() => [...document.querySelectorAll('#foundations .marks-icon-sheet')].every((image) => image.complete));
  const assetFailures = await page.locator('#foundations .marks-icon-sheet').evaluateAll((images) => images.flatMap((image) => (
    image.naturalWidth === 104 && image.naturalHeight === 104 ? [] : [`${image.getAttribute('src')}: ${image.naturalWidth}x${image.naturalHeight}`]
  )));
  assert.deepEqual(assetFailures, [], `all catalog icon assets decode at 104x104: ${assetFailures.join(', ')}`);
  const fallbackNames = await page.locator('#foundations [data-icon-source="vector-fallback"]').evaluateAll((icons) => icons.map((icon) => icon.getAttribute('data-icon')).sort());
  assert.deepEqual(fallbackNames, expectedIcons.filter((icon) => icon.source === 'vector-fallback').map((icon) => icon.name).sort(), 'only registered vector-only icons use the fallback renderer');
  for (const name of ['startTemplate', 'githubReadme', 'meetingNotes', 'importWebsite', 'ghostOverlay']) {
    assert.equal(await page.locator(`#foundations [data-icon="${name}"][data-icon-source="sheet"]`).count(), 1, `${name} renders from its governed PNG asset`);
  }

  const fullMotionIcon = page.locator('#foundations [data-icon="bold"]');
  await fullMotionIcon.evaluate((icon) => {
    icon.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await page.waitForFunction(() => document.querySelector('#foundations [data-icon="bold"] .marks-icon-action')?.getAnimations().length === 1);
  const fullIconMotion = await fullMotionIcon.evaluate((icon) => {
    const count = (selector) => icon.querySelector(selector)?.getAnimations().length ?? 0;
    return {
      action: count('.marks-icon-action'),
      halo: count('.marks-icon-halo'),
      beam: count('.marks-icon-beam'),
      particles: [...icon.querySelectorAll('.marks-icon-particle')].reduce((total, particle) => total + particle.getAnimations().length, 0),
    };
  });
  assert.deepEqual(fullIconMotion, { action: 1, halo: 1, beam: 1, particles: 4 }, 'shared full-motion icon activation recipe runs');
  await page.waitForTimeout(450);
  await page.locator('.ds-controls select').nth(3).selectOption('reduced');
  const reducedMotionIcon = page.locator('#foundations [data-icon="italic"]');
  await reducedMotionIcon.evaluate((icon) => {
    icon.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await page.waitForFunction(() => document.querySelector('#foundations [data-icon="italic"] .marks-icon-halo')?.getAnimations().length === 1);
  const reducedIconMotion = await reducedMotionIcon.evaluate((icon) => {
    const count = (selector) => icon.querySelector(selector)?.getAnimations().length ?? 0;
    return {
      action: count('.marks-icon-action'),
      halo: count('.marks-icon-halo'),
      beam: count('.marks-icon-beam'),
      particles: [...icon.querySelectorAll('.marks-icon-particle')].reduce((total, particle) => total + particle.getAnimations().length, 0),
    };
  });
  assert.deepEqual(reducedIconMotion, { action: 0, halo: 1, beam: 1, particles: 0 }, 'shared reduced-motion icon activation recipe runs');
  await page.locator('.ds-controls select').nth(3).selectOption('full');

  assert.equal(await page.locator('#chrome .ribbon-tab').count(), 5, 'catalog composes the production ribbon tab primitive');
  assert.equal(await page.locator('#chrome .ribbon-command-group').count(), 2, 'catalog composes production ribbon groups');
  assert.equal(await page.locator('#responsive [data-posture] .ribbon-command').count(), 4, 'every posture example uses the production ribbon command');

  await page.keyboard.press('Tab');
  const focused = await page.evaluate(() => document.activeElement?.matches('button,select,a[href],input'));
  assert(focused, 'keyboard navigation reaches an interactive control');

  const contrast = await page.evaluate(() => {
    const parse = (value) => value.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [0, 0, 0];
    const lum = (rgb) => rgb.map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }).reduce((n,v,i)=>n+v*[.2126,.7152,.0722][i],0);
    const style = getComputedStyle(document.querySelector('.design-system'));
    const [a,b] = [lum(parse(style.color)), lum(parse(style.backgroundColor))].sort((x,y)=>y-x);
    return (a + .05) / (b + .05);
  });
  assert(contrast >= 4.5, `base text contrast ${contrast.toFixed(2)} must meet AA`);

  await page.evaluate(() => { document.body.style.zoom = '2'; });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), '200% zoom must not overflow horizontally');
  await page.evaluate(() => { document.body.style.zoom = ''; });

  for (const colorScheme of ['light', 'dark']) for (const tier of ['cinematic', 'balanced', 'foundation', 'opaque']) {
    await page.locator('.ds-controls select').nth(0).selectOption(colorScheme);
    await page.locator('.ds-controls select').nth(4).selectOption(tier);
    await page.screenshot({ path: new URL(`../artifacts/design-system/${colorScheme}-${tier}.png`, import.meta.url).pathname, fullPage: true });
  }
  const reduced = await browser.newContext({ reducedMotion: 'reduce', forcedColors: 'active' });
  const reducedPage = await reduced.newPage();
  await reducedPage.goto(`http://127.0.0.1:${port}/design-system`);
  assert(Number.parseFloat(await reducedPage.locator('.motion-full').evaluate(el => getComputedStyle(el).animationDuration)) <= 0.001, 'reduced motion removes catalog animation');
  assert.notEqual(await reducedPage.locator('.ds-section').first().evaluate(el => getComputedStyle(el).borderTopStyle), 'none');
  await reduced.close();
  await browser.close();
  console.log('design-system governance, runtime, accessibility, and capture checks passed');
} finally {
  await server.close();
}
