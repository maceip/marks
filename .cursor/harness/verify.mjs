// Attach to a harness's hot Chrome over CDP and drive a real navigation.
// Prints the page's observed public egress IP (proving traffic is source-NAT'd
// out of the CGNAT namespace) plus the document title. Must be run inside the
// harness's network namespace, from the harness package directory.
const [, , harness, port] = process.argv;
const cdp = `http://127.0.0.1:${port}`;
const url = 'https://api.ipify.org?format=text';

const out = { harness, cdp, ok: false };
try {
  if (harness === 'playwright') {
    const { chromium } = await import('playwright');
    const browser = await chromium.connectOverCDP(cdp);
    const ctx = browser.contexts()[0] ?? (await browser.newContext());
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    out.egress = (await page.textContent('body'))?.trim();
    out.title = await page.title();
    await page.close();
    // Do not close the connected (hot) browser; just drop the connection.
  } else if (harness === 'puppeteer') {
    const puppeteer = (await import('puppeteer')).default;
    const browser = await puppeteer.connect({ browserURL: cdp });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    out.egress = (await page.$eval('body', (el) => el.innerText)).trim();
    out.title = await page.title();
    await page.close();
    await browser.disconnect();
  } else {
    throw new Error(`unknown harness ${harness}`);
  }
  out.ok = Boolean(out.egress);
} catch (err) {
  out.error = String(err && err.message ? err.message : err);
}
console.log(JSON.stringify(out));
process.exit(out.ok ? 0 : 1);
