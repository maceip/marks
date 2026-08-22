/**
 * End-to-end smoke test.
 *
 * Drives two real browsers against a running server and checks the things that
 * are easy to break and hard to notice: convergence between peers, presence,
 * offline editing, per-user undo, incremental preview rendering, and the
 * server's derived titles. Run it against a build:
 *
 *   npm run build
 *   # Start the Rust Marks server separately.
 *   node scripts/smoke.mjs
 *
 * Playwright owns this two-peer / REST suite. The same glass checks run on
 * Puppeteer and agent-browser via npm run smoke:platforms — see
 * docs/TEST-HARNESS.md.
 */
import { chromium } from 'playwright';
import { CHROME_LAUNCH_ARGS, launchEnv } from './harness/env.mjs';

const BASE = process.env.MARKS_URL ?? 'http://localhost:3000';
const CHROMIUM = process.env.CHROMIUM_PATH ?? undefined;
const SHOTS = process.env.MARKS_SHOTS ?? null;

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
};

const browser = await chromium.launch({
  executablePath: CHROMIUM,
  args: CHROME_LAUNCH_ARGS,
  env: launchEnv(),
});

const pages = [];
async function open(url) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  const handle = { context, page, errors };
  pages.push(handle);
  return handle;
}

const settle = (page, ms = 1500) => page.waitForTimeout(ms);
const previewText = (page) => page.locator('.marks-preview').innerText();
const shot = async (page, name) => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
};

const FIXTURE = `# Smoke test document

A paragraph with **bold**, *italic*, \`code\` and a [link](https://example.com).

| Feature | Works |
| --- | --- |
| Tables | yes |
| Math | yes |

- [ ] an unchecked task
- [x] a checked task

Inline math $e^{i\\pi} + 1 = 0$ and a block:

$$
\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}
$$

\`\`\`ts
export const answer = (): number => 42;
\`\`\`

\`\`\`mermaid
flowchart LR
  A[Edit] --> B[CRDT] --> C[Preview]
\`\`\`

## Second section

More prose so the document has several blocks to diff against.

## Fish **&** chips

Enough trailing prose to make the document taller than the pane, so scrolling
has somewhere to go. Repeated deliberately.

Enough trailing prose to make the document taller than the pane, so scrolling
has somewhere to go. Repeated deliberately.

Enough trailing prose to make the document taller than the pane, so scrolling
has somewhere to go. Repeated deliberately.

Enough trailing prose to make the document taller than the pane, so scrolling
has somewhere to go. Repeated deliberately.
`;

try {
  /* ---------------------------------------------------- rendering ------- */
  console.log('\nrendering');

  // A fresh document per run: the suite must not depend on, or leave behind,
  // state in a shared one.
  const a = await open(`${BASE}/`);
  await a.page.waitForSelector('.new-doc', { timeout: 20_000 });
  await a.page.click('.new-doc .button.primary');
  await a.page.waitForSelector('.cm-content', { timeout: 20_000 });
  await settle(a.page, 2500);
  const docUrl = a.page.url();

  await a.page.click('.cm-content');
  await a.page.keyboard.insertText(FIXTURE);
  await a.page.waitForSelector('.marks-preview .marks-block', { timeout: 20_000 });
  await settle(a.page, 2500);

  check('document renders blocks', (await a.page.locator('.marks-preview .marks-block').count()) > 8);
  check('math renders', (await a.page.locator('.marks-preview .katex').count()) > 0);
  check('diagrams render', (await a.page.locator('.marks-mermaid-out svg').count()) > 0);
  check('tables render', (await a.page.locator('.marks-preview table tr').count()) > 2);
  check('code is highlighted', (await a.page.locator('.marks-preview code.hljs .hljs-keyword').count()) > 0);
  check('task lists render', (await a.page.locator('.marks-preview input[type=checkbox]').count()) === 2);
  await shot(a.page, '01-document');

  /* ---------------------------------------------------- incremental ----- */
  console.log('\nincremental preview');
  // Append rather than prepend: typing at the top would swallow the first
  // heading into a paragraph and change what the outline should contain.
  await a.page.keyboard.press('Control+End');
  await a.page.keyboard.type('Edited by peer A. ', { delay: 15 });
  await settle(a.page, 900);
  check('typing reaches the preview', (await previewText(a.page)).includes('Edited by peer A'));

  await a.page.keyboard.press('Control+Shift+M');
  await settle(a.page, 700);
  const hud = await a.page.locator('.hud').innerText();
  const dirty = /Blocks\n(\d+) dirty \/ (\d+)/.exec(hud);
  const domOps = /DOM ops\n(\d+)/.exec(hud);
  check(
    'only changed blocks re-render',
    dirty !== null && Number(dirty[1]) <= 2 && Number(dirty[2]) > 5,
    dirty ? `${dirty[1]} dirty of ${dirty[2]}` : 'no reading',
  );
  check('DOM churn stays proportional to the edit', domOps !== null && Number(domOps[1]) <= 6, domOps?.[1]);
  await shot(a.page, '02-hud');
  await a.page.keyboard.press('Control+Shift+M');

  /* ---------------------------------------------------- collaboration --- */
  console.log('\ncollaboration');
  const b = await open(docUrl);
  await b.page.waitForSelector('.marks-preview .marks-block', { timeout: 20_000 });
  await settle(b.page, 1500);
  check("second peer receives the first peer's edits", (await previewText(b.page)).includes('Edited by peer A'));

  await b.page.click('.cm-content');
  await b.page.keyboard.press('Control+End');
  await b.page.keyboard.type('\n\nAdded by peer B.\n');
  await settle(a.page, 1800);

  const aText = await previewText(a.page);
  const bText = await previewText(b.page);
  check("first peer receives the second peer's edits", aText.includes('Added by peer B'));
  check('previews converge', aText === bText);
  check('presence shows both peers', (await a.page.locator('.presence .avatar').count()) === 2);
  check('remote cursor is drawn', (await a.page.locator('.esbt-caret').count()) > 0);
  await shot(a.page, '03-collaboration');

  /* ---------------------------------------------------- undo ------------ */
  console.log('\nper-user undo');
  // Screenshots and cross-page waits can move window focus, and a keymap only
  // fires when the editor actually holds it.
  await b.page.bringToFront();
  await b.page.click('.cm-content');

  // Undo granularity depends on each engine's edit-grouping interval, so step
  // back until this peer's own edit is gone rather than assuming one press.
  let afterUndo = await previewText(b.page);
  for (let attempt = 0; attempt < 5 && afterUndo.includes('Added by peer B'); attempt++) {
    await b.page.keyboard.press('Control+z');
    await settle(b.page, 700);
    afterUndo = await previewText(b.page);
  }
  check('undo reverts my own edit', !afterUndo.includes('Added by peer B'));
  check("undo leaves the other peer's edit alone", afterUndo.includes('Edited by peer A'));

  /* ---------------------------------------------------- interaction ----- */
  console.log('\ninteraction');
  const box = a.page.locator('.marks-preview input[type=checkbox]').first();
  const before = await box.isChecked();
  await box.click();
  await settle(a.page, 700);
  const after = await a.page.locator('.marks-preview input[type=checkbox]').first().isChecked();
  check('clicking a checkbox writes back to the source', before !== after);

  // The edit came from the preview, not the editor, so it also exercises the
  // path that pushes local non-editor writes back into CodeMirror.
  const editorSource = await a.page.locator('.cm-content').innerText();
  check(
    'a preview edit reaches the editor',
    editorSource.includes(after ? '[x] an unchecked task' : '[ ] an unchecked task'),
  );

  await a.page.click('button[aria-label="Document outline"]');
  await settle(a.page, 400);
  const outlineItems = await a.page.locator('.outline-item').allInnerTexts();
  check('outline lists headings', outlineItems.length > 2, `${outlineItems.length} entries`);
  check(
    'outline shows plain heading text',
    outlineItems.some((text) => text.trim() === 'Fish & chips'),
    JSON.stringify(outlineItems.map((text) => text.trim())),
  );
  await a.page.click('button[aria-label="Close outline"]');

  // Scroll sync is easy to break silently: the preview index is built from
  // block elements that are descendants, not children, of the scroll pane.
  await a.page.evaluate(() => {
    document.querySelector('.preview-pane').scrollTop = 0;
    document.querySelector('.cm-scroller').scrollTop = 0;
  });
  await settle(a.page, 400);
  await a.page.evaluate(() => {
    const scroller = document.querySelector('.cm-scroller');
    scroller.scrollTop = Math.floor(scroller.scrollHeight / 2);
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  await settle(a.page, 600);
  const previewScroll = await a.page.evaluate(() => document.querySelector('.preview-pane').scrollTop);
  check('editor scrolling moves the preview', previewScroll > 0, `previewScrollTop=${previewScroll}`);

  /* ---------------------------------------------------- browser surface - */
  console.log('\nbrowser surface');
  await a.page.click('.preview-pane');
  await a.page.keyboard.press('Control+A');
  const previewSelection = await a.page.evaluate(() => document.getSelection()?.toString() ?? '');
  check(
    'select-all in the preview stays inside the document',
    previewSelection.includes('Smoke test document') && !previewSelection.includes('Benchmark engines'),
    previewSelection ? `chars=${previewSelection.length}` : 'empty selection',
  );

  await a.page.locator('.marks-preview').click({ button: 'right', position: { x: 24, y: 24 } });
  await settle(a.page, 200);
  check('preview right-click opens the marks menu', (await a.page.locator('.context-menu').count()) === 1);
  await a.page.keyboard.press('Escape');

  check('voice input is offered', (await a.page.locator('button[aria-label="Voice input"]').count()) === 1);
  check('opening shell does not stay up', (await a.page.locator('.opening-shell').count()) === 0);

  await a.page.click('button[title="Preview"]');
  await settle(a.page, 400);
  check('preview-only mode hides the editor', !(await a.page.locator('.editor-pane').isVisible()));
  await a.page.click('button[title="Split"]');

  await a.page.click('button[aria-label*="dark theme"], button[aria-label*="light theme"]');
  await settle(a.page, 800);
  check('theme toggles', (await a.page.evaluate(() => document.documentElement.dataset.theme)) === 'dark');
  await shot(a.page, '04-dark');

  /* ---------------------------------------------------- offline --------- */
  console.log('\noffline');
  await a.context.setOffline(true);
  await settle(a.page, 1500);
  check('offline is reported', (await a.page.locator('.topbar .status').first().innerText()).includes('Offline'));

  await a.page.bringToFront();
  await a.page.click('.cm-content');
  // Clicking lands the cursor wherever the click was; type at the end so the
  // text cannot land inside a fenced block, whose source the preview hides.
  await a.page.keyboard.press('Control+End');
  await a.page.keyboard.type('Typed while offline. ');
  await settle(a.page, 600);
  const offlineText = await previewText(a.page);
  check(
    'editing works offline',
    offlineText.includes('Typed while offline'),
    offlineText.includes('Typed while offline') ? '' : `preview tail: ${JSON.stringify(offlineText.slice(-80))}`,
  );

  await a.context.setOffline(false);
  await settle(b.page, 4500);
  check('offline edits sync on reconnect', (await previewText(b.page)).includes('Typed while offline'));

  /* ------------------------------------------------- second document ---- */
  console.log('\nsecond document');
  const c = await open(`${BASE}/`);
  await c.page.waitForSelector('.new-doc');
  await c.page.click('.new-doc .button.primary');
  await c.page.waitForSelector('.cm-content', { timeout: 20_000 });
  await settle(c.page, 2500);

  const secondUrl = c.page.url();
  check('new document uses the esbt engine', (await c.page.locator('.topbar .engine-tag').innerText()).trim().toLowerCase() === 'esbt');

  await c.page.click('.cm-content');
  await c.page.keyboard.type('# Second document\n\nFrom peer C. ');
  await settle(c.page, 1200);

  const d = await open(secondUrl);
  await d.page.waitForSelector('.cm-content', { timeout: 20_000 });
  await settle(d.page, 2500);
  check('cold-opening peer receives existing content', (await previewText(d.page)).includes('From peer C'));

  await d.page.click('.cm-content');
  await d.page.keyboard.press('Control+End');
  await d.page.keyboard.type('And peer D.');
  await settle(c.page, 1800);
  check('second document peers converge', (await previewText(c.page)) === (await previewText(d.page)));
  check('second document presence works', (await c.page.locator('.presence .avatar').count()) === 2);

  /* ---------------------------------------------------- server ---------- */
  console.log('\nserver');
  const docId = secondUrl.split('/d/')[1];
  const exported = await (await fetch(`${BASE}/v1/documents/${docId}/export`)).text();
  check('server exports the document as markdown', exported.includes('Second document') && exported.includes('From peer C'));

  const meta = await (await fetch(`${BASE}/v1/documents/${docId}`)).json();
  check('server derives the title from the first heading', meta.document.title === 'Second document', meta.document.title);

  const snapshot = await fetch(`${BASE}/v1/documents/${docId}/snapshot`);
  check('snapshot endpoint serves CRDT state', snapshot.ok && Number(snapshot.headers.get('content-length') ?? 1) !== 0);

  // Exporting has to read the live document: both engines persist on a
  // debounce, so a download right after typing would otherwise lose the tail.
  await d.page.click('.cm-content');
  await d.page.keyboard.press('Control+End');
  await d.page.keyboard.type(' Freshly typed.');
  await settle(d.page, 400);
  const freshExport = await (await fetch(`${BASE}/v1/documents/${docId}/export`)).text();
  check('export includes edits newer than the last store', freshExport.includes('Freshly typed'));

  // A document with a live room must stay deleted: the room holds a pending
  // write that would otherwise recreate the row.
  const doomed = await open(`${BASE}/`);
  await doomed.page.waitForSelector('.new-doc', { timeout: 20_000 });
  await doomed.page.click('.new-doc .button.primary');
  await doomed.page.waitForSelector('.cm-content', { timeout: 20_000 });
  await settle(doomed.page, 2000);
  const doomedId = doomed.page.url().split('/d/')[1];
  await doomed.page.click('.cm-content');
  await doomed.page.keyboard.type('# About to be deleted');
  await settle(doomed.page, 300);

  await fetch(`${BASE}/v1/documents/${doomedId}`, { method: 'DELETE' });
  await settle(doomed.page, 4000); // past the persist debounce
  const afterDelete = await fetch(`${BASE}/v1/documents/${doomedId}`);
  check('a deleted document stays deleted while its room is live', afterDelete.status === 404, `status ${afterDelete.status}`);

  // The retired engines' paths must be refused: connecting one to an
  // existing document would hand it an empty replica and let the first edit
  // overwrite the stored state.
  const retired = await d.page.evaluate(
    (urls) =>
      Promise.all(
        urls.map(
          (url) =>
            new Promise((resolve) => {
              const socket = new WebSocket(url);
              socket.onopen = () => resolve(`${url} accepted`);
              socket.onerror = () => resolve('rejected');
              socket.onclose = () => resolve('rejected');
              setTimeout(() => resolve(`${url} timeout`), 4000);
            }),
        ),
      ),
    [
      `${BASE.replace(/^http/, 'ws')}/collab/loro/${docId}`,
      `${BASE.replace(/^http/, 'ws')}/collab/yjs/${docId}`,
    ],
  );
  check(
    'retired engine paths are refused at the socket',
    retired.every((result) => result === 'rejected'),
    retired.join(' | '),
  );

  /* ---------------------------------------------------- errors ---------- */
  // The offline section deliberately cuts the network, so its failed requests
  // are expected rather than a defect.
  const consoleErrors = pages
    .flatMap((handle) => handle.errors)
    .filter(
      (text) =>
        !/favicon|ERR_INTERNET_DISCONNECTED|Failed to load resource/i.test(text) &&
        // The engine-mismatch and deletion checks deliberately provoke refused
        // WebSocket connections.
        !/WebSocket connection to .*collab/i.test(text),
    );
  check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
}

const failed = results.filter((result) => !result.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
