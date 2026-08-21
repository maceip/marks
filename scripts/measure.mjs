/**
 * Measure preview latency on a large document.
 *
 * Types into a generated document of a given size and reports the numbers the
 * in-app performance panel shows, so the claims in the README can be checked
 * rather than taken on faith:
 *
 *   npm run build && npm start &
 *   node scripts/measure.mjs            # ~60 KB
 *   node scripts/measure.mjs 400        # ~110 KB
 */
import { chromium } from 'playwright';

const BASE = process.env.MARKS_URL ?? 'http://localhost:3000';
const CHROMIUM = process.env.CHROMIUM_PATH ?? undefined;
const SECTIONS = Number(process.argv[2] ?? 220);
const KEYSTROKES = Number(process.argv[3] ?? 60);

function document_(sections) {
  const out = ['# Scale test\n'];
  for (let i = 0; i < sections; i++) {
    out.push(`## Section ${i}\n`);
    out.push(
      `Paragraph ${i} with **bold**, *italic*, \`code\` and a [link](https://example.com), plus enough filler prose to wrap across several lines in the preview pane.\n`,
    );
    out.push(`- item one for ${i}\n- item two for ${i}\n- [ ] a task for ${i}\n`);
    if (i % 5 === 0) out.push('```ts\nexport const value' + i + ' = () => ({ id: ' + i + ' });\n```\n');
    if (i % 7 === 0) out.push(`| a | b |\n| --- | --- |\n| ${i} | ${i * 2} |\n`);
    if (i % 11 === 0) out.push(`> Quote ${i}\n`);
  }
  return out.join('\n');
}

const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !/^(https?_proxy|all_proxy|no_proxy)$/i.test(key)),
);
const browser = await chromium.launch({
  executablePath: CHROMIUM,
  args: ['--no-proxy-server', '--no-sandbox'],
  env,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const source = document_(SECTIONS);
console.log(`document: ${(source.length / 1024).toFixed(1)} KB, ${source.split('\n').length} lines`);

await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.new-doc', { timeout: 20_000 });
await page.click('.new-doc .button.primary');
await page.waitForSelector('.cm-content', { timeout: 20_000 });
await page.waitForTimeout(2500);

await page.click('.cm-content');
const started = Date.now();
await page.keyboard.insertText(source);
await page.waitForFunction(
  (expected) => document.querySelectorAll('.marks-preview .marks-block').length > expected,
  SECTIONS * 2,
  { timeout: 60_000 },
);
console.log(`first full render: ${Date.now() - started} ms`);
await page.waitForTimeout(1500);

// Type in the middle of the document — the worst case for a renderer that
// rebuilds everything.
await page.keyboard.press('Control+Home');
for (let i = 0; i < Math.floor(SECTIONS / 4); i++) await page.keyboard.press('ArrowDown');

await page.keyboard.press('Control+Shift+M');
await page.waitForTimeout(500);
for (let i = 0; i < KEYSTROKES; i++) await page.keyboard.type('x', { delay: 25 });
await page.waitForTimeout(1200);

const hud = await page.locator('.hud').innerText();
console.log(`\nafter ${KEYSTROKES} keystrokes\n${'-'.repeat(40)}`);
console.log(hud.replace(/\n(?=(p50|p95|max|\d))/gi, ' ').trim());

await browser.close();
