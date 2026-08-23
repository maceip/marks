import { chromium } from 'playwright';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

const distFiles = await readdir(new URL('../client/dist/assets/', import.meta.url));
const index = await readFile(new URL('../client/dist/index.html', import.meta.url), 'utf8');
assert(!index.includes('design-system.css'), 'catalog CSS must not be in the entry document');
assert(distFiles.some((name) => name.startsWith('DesignSystem-')), 'catalog must be a separate lazy chunk');
const port = 4197;
const server = spawn('npm', ['run', 'preview', '--workspace=client', '--', '--host', '127.0.0.1', '--port', String(port)], { stdio: 'ignore' });
const stop = () => server.kill('SIGTERM');
process.on('exit', stop);
try {
  for (let attempt = 0; attempt < 40; attempt++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/design-system`)).ok) break; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  await mkdir(new URL('../artifacts/design-system/', import.meta.url), { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`http://127.0.0.1:${port}/design-system`);
  await page.locator('h1').waitFor();
  assert.equal(await page.locator('main section').count(), 8, 'all catalog sections render');
  assert.equal(await page.locator('[aria-label="button state matrix"] > *').count(), 11, 'complete state matrix renders');

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
    await page.getByLabel('Theme').selectOption(colorScheme);
    await page.getByLabel('Material').selectOption(tier);
    await page.screenshot({ path: new URL(`../artifacts/design-system/${colorScheme}-${tier}.png`, import.meta.url).pathname, fullPage: true });
  }
  const reduced = await browser.newContext({ reducedMotion: 'reduce', forcedColors: 'active' });
  const reducedPage = await reduced.newPage();
  await reducedPage.goto(`http://127.0.0.1:${port}/design-system`);
  assert.equal(await reducedPage.locator('.motion-full').evaluate(el => getComputedStyle(el).animationDuration), '0.00001s');
  assert.notEqual(await reducedPage.locator('.ds-section').evaluate(el => getComputedStyle(el).borderTopStyle), 'none');
  await reduced.close();
  await browser.close();
  console.log('design-system accessibility and visual-regression checks passed');
} finally { stop(); }
