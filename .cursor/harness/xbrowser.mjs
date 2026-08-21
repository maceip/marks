// Cross-browser marks driver. Runs INSIDE a harness's network namespace,
// attaches to that harness's hot Chrome over CDP, loads the marks web app from
// the namespace's host-veth gateway, and either types a marker into the doc or
// reads the doc waiting for a marker to arrive (proving CRDT sync through the
// hosted server across isolated CGNAT namespaces).
//
// usage: node xbrowser.mjs <playwright|puppeteer> <cdpPort> <baseUrl> <docPath> <type|read> <marker>
const [, , engine, port, baseUrl, docPath, action, marker] = process.argv;
const url = `${baseUrl}${docPath}`;
const out = { engine, action, url, marker, ok: false };

// page.evaluate has an identical signature in Playwright and Puppeteer, so poll
// with it rather than waitForFunction (whose arg order differs between them).
async function waitForMarker(page, m, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await page
      .evaluate((x) => document.querySelector('.marks-preview')?.innerText.includes(x) ?? false, m)
      .catch(() => false);
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// marks collapses to an editor-only layout on narrow viewports (the preview
// pane is hidden), so drive with a desktop-sized viewport to get the split view.
const VIEWPORT = { width: 1440, height: 900 };

async function withPlaywright() {
  const { chromium } = await import('playwright');
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const ctx = await browser.newContext({ viewport: VIEWPORT });
  const page = await ctx.newPage();
  return { page, disconnect: async () => {} }; // leave browser + page open
}
async function withPuppeteer() {
  const puppeteer = (await import('puppeteer')).default;
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` });
  const page = await browser.newPage();
  await page.setViewport(VIEWPORT);
  return { page, disconnect: async () => browser.disconnect() };
}

try {
  const { page, disconnect } = engine === 'playwright' ? await withPlaywright() : await withPuppeteer();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('.cm-content', { timeout: 30000 });
  await page.waitForSelector('.marks-preview', { state: 'attached', timeout: 30000 }).catch(() => {});
  out.loaded = true;

  if (action === 'type') {
    await page.click('.cm-content');
    // Type the marker as its own line so it renders as a distinct block.
    await page.keyboard.type(`${marker}\n`);
    // Confirm it rendered in THIS browser's own preview.
    out.ok = await waitForMarker(page, marker, 20000);
    if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT }).catch(() => {});
    // Leave the page open so its WebSocket keeps the edit live on the server.
  } else {
    // Poll until the marker syncs in from the server (or time out).
    out.ok = await waitForMarker(page, marker, 25000);
    out.previewTail = (await page.$eval('.marks-preview', (el) => el.innerText).catch(() => '')).slice(-160);
  }
  await disconnect();
} catch (err) {
  out.error = String(err && err.message ? err.message : err);
}
console.log(JSON.stringify(out));
process.exit(out.ok ? 0 : 1);
