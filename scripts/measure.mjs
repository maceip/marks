/**
 * Measure preview latency on a large document.
 *
 * Types into a generated document of a given size and reports the numbers the
 * in-app performance panel shows, so the claims in the README can be checked
 * rather than taken on faith. Budget flags make the process fail when a
 * reading exceeds its cap (the future Rust-server performance workflow will
 * use those).
 *
 *   npm run build
 *   # Start the Rust Marks server separately.
 *   node scripts/measure.mjs
 *   node scripts/measure.mjs 400
 *   node scripts/measure.mjs --budget-p50 150 --budget-p95 300 --budget-first-ms 20000
 */
import { chromium } from 'playwright';
import { CHROME_LAUNCH_ARGS, launchEnv } from './harness/env.mjs';
import {
  USAGE,
  evaluateBudgets,
  formatBudgetFailures,
  parseHud,
  parseMeasureArgs,
} from './measure-budget.mjs';

let args;
try {
  args = parseMeasureArgs(process.argv.slice(2), process.env);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(2);
}

if (args.help) {
  console.log(USAGE);
  process.exit(0);
}

const CHROMIUM = process.env.CHROMIUM_PATH ?? undefined;

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

const browser = await chromium.launch({
  executablePath: CHROMIUM,
  args: CHROME_LAUNCH_ARGS,
  env: launchEnv(),
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const source = document_(args.sections);
console.log(`document: ${(source.length / 1024).toFixed(1)} KB, ${source.split('\n').length} lines`);

await page.goto(`${args.url}/`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.new-doc', { timeout: 20_000 });
await page.click('.new-doc .button.primary');
await page.waitForSelector('.cm-content', { timeout: 20_000 });
await page.waitForTimeout(2500);

await page.click('.cm-content');
const started = Date.now();
await page.keyboard.insertText(source);
await page.waitForFunction(
  (expected) => document.querySelectorAll('.marks-preview .marks-block').length > expected,
  args.sections * 2,
  { timeout: 60_000 },
);
const firstRenderMs = Date.now() - started;
console.log(`first full render: ${firstRenderMs} ms`);
await page.waitForTimeout(1500);

// Type in the middle of the document — the worst case for a renderer that
// rebuilds everything.
await page.keyboard.press('Control+Home');
for (let i = 0; i < Math.floor(args.sections / 4); i++) await page.keyboard.press('ArrowDown');

await page.keyboard.press('Control+Shift+M');
await page.waitForTimeout(500);
for (let i = 0; i < args.keystrokes; i++) await page.keyboard.type('x', { delay: 25 });
await page.waitForTimeout(1200);

const hudText = await page.locator('.hud').innerText();
console.log(`\nafter ${args.keystrokes} keystrokes\n${'-'.repeat(40)}`);
console.log(hudText.replace(/\n(?=(p50|p95|max|\d))/gi, ' ').trim());

const hud = parseHud(hudText);
const result = evaluateBudgets({ firstRenderMs, ...hud }, args);
if (!result.ok) {
  console.error(`\nbudget\n${'-'.repeat(40)}`);
  console.error(formatBudgetFailures(result.failures));
  await browser.close();
  process.exit(1);
}

await browser.close();
