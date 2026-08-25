// Prove a production update propagates to an already-open tab, end to end:
// build the client twice so a lazily loaded chunk's hashed filename (and
// therefore the stamped service worker) differs, open a tab against
// release A with its service worker controlling, switch the server to
// release B with A's assets available only through the shared retained
// pool, and confirm — without ever navigating or closing the tab — that
// the worker updates and takes over immediately, the old release's lazy
// chunk still resolves, and a chunk retained by no release stays an
// uncacheable 404.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHROME_LAUNCH_ARGS, launchEnv } from './harness/env.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bin = process.env.MARKS_BIN ?? join(root, 'target', 'debug', 'marks-server');
const work = mkdtempSync(join(tmpdir(), 'marks-two-release.'));
const distA = join(work, 'dist-a');
const distB = join(work, 'dist-b');
const pool = join(work, 'pool');
const port = 4217;
const origin = `http://127.0.0.1:${port}`;

function build(outDir, salt) {
  execFileSync('npx', ['vite', 'build', '--outDir', outDir, '--emptyOutDir'], {
    cwd: join(root, 'client'),
    stdio: ['ignore', 'pipe', 'inherit'],
    env: {
      ...process.env,
      VITE_MARKS_DATA_MODE: 'service',
      VITE_MARKS_TEST_SERVICE_WORKER: '1',
      VITE_MARKS_RELEASE_SALT: salt,
    },
  });
}

console.log('building release A and release B with distinct chunk salts');
build(distA, 'release-a');
build(distB, 'release-b');

const lazyChunk = (dist) =>
  readdirSync(join(dist, 'assets')).find(
    (name) => name.startsWith('DesignSystem-') && name.endsWith('.js'),
  );
const workerVersion = (dist) =>
  readFileSync(join(dist, 'sw.js'), 'utf8').match(/const VERSION = '([^']+)';/)[1];
const chunkA = lazyChunk(distA);
const chunkB = lazyChunk(distB);
const versionA = workerVersion(distA);
const versionB = workerVersion(distB);
assert(chunkA && chunkB, 'both builds expose the lazy design-system chunk');
assert.notEqual(chunkA, chunkB, 'salted builds must produce distinct lazy chunk names');
assert.notEqual(versionA, versionB, 'a release that changes the shell must change sw.js bytes');

mkdirSync(pool);
for (const dist of [distA, distB]) {
  for (const name of readdirSync(join(dist, 'assets'))) {
    const target = join(pool, name);
    if (!existsSync(target)) copyFileSync(join(dist, 'assets', name), target);
  }
}

const serverLog = [];
let server = null;
function startServer(staticDir, assetPool) {
  const env = {
    ...process.env,
    MARKS_LISTEN: `127.0.0.1:${port}`,
    MARKS_ORIGIN: origin,
    MARKS_DB: join(work, 'marks.db3'),
    MARKS_ASSET_DIR: join(work, 'doc-assets'),
    MARKS_STATIC_DIR: staticDir,
  };
  if (assetPool) env.MARKS_ASSET_POOL = assetPool;
  server = spawn(bin, [], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', (chunk) => serverLog.push(chunk));
  server.stderr.on('data', (chunk) => serverLog.push(chunk));
}
async function stopServer() {
  if (!server) return;
  const exited = new Promise((resolveExit) => server.once('exit', resolveExit));
  server.kill('SIGTERM');
  await exited;
  server = null;
}
async function waitHealthy() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      if ((await fetch(`${origin}/healthz`)).ok) return;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error('marks-server never became healthy');
}
let cleaned = false;
const cleanup = () => {
  if (cleaned) return;
  cleaned = true;
  if (server) server.kill('SIGTERM');
  rmSync(work, { recursive: true, force: true });
};
process.on('exit', cleanup);

try {
  // Phase 1: an ordinary tab on release A, controlled by A's worker.
  startServer(distA, null);
  await waitHealthy();
  const browser = await chromium.launch({ args: CHROME_LAUNCH_ARGS, env: launchEnv() });
  try {
    const page = await browser.newPage();
    await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) {
        await new Promise((resolveControl) =>
          navigator.serviceWorker.addEventListener('controllerchange', resolveControl, { once: true }),
        );
      }
    });
    const cachesA = await page.evaluate(() => caches.keys());
    assert(cachesA.includes(`marks-shell-${versionA}`), `release A worker controls: ${cachesA}`);
    console.log(`  ok   release A's worker controls the tab (namespace ${versionA})`);

    // Phase 2: production switches to release B while the tab stays open.
    await stopServer();
    startServer(distB, pool);
    await waitHealthy();

    const workerScript = await page.request.get(`${origin}/sw.js`);
    assert.equal(workerScript.headers()['cache-control'], 'no-cache, must-revalidate');
    console.log('  ok   sw.js is never HTTP-cacheable');

    // The held tab discovers the update through an explicit check — the
    // same call the app makes on visibility, reconnect, and hourly — and
    // the new worker takes over without any navigation or tab close.
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      const changed = new Promise((resolveChange) =>
        navigator.serviceWorker.addEventListener('controllerchange', resolveChange, { once: true }),
      );
      await registration.update();
      await changed;
    });
    await page.waitForFunction(
      async (expected) => {
        const keys = await caches.keys();
        return keys.includes(`marks-shell-${expected.next}`) && !keys.includes(`marks-shell-${expected.previous}`);
      },
      { next: versionB, previous: versionA },
      { timeout: 30_000 },
    );
    console.log(`  ok   the held tab's worker updated in place (${versionA} -> ${versionB})`);

    // The stale tab's module graph still references release A's hashed URL.
    const exportsA = await page.evaluate(
      async (path) => Object.keys(await import(path)),
      `/assets/${chunkA}`,
    );
    assert(exportsA.includes('DesignSystem'), `old-release lazy chunk resolves: ${exportsA}`);
    console.log(`  ok   old-release lazy chunk ${chunkA} imports through the pool`);

    const pooled = await page.request.get(`${origin}/assets/${chunkA}`);
    assert.equal(pooled.status(), 200);
    assert.equal(pooled.headers()['cache-control'], 'public, max-age=31536000, immutable');
    assert.match(pooled.headers()['content-type'], /javascript/);
    console.log('  ok   pooled chunk keeps the immutable asset policy');

    const active = await page.request.get(`${origin}/assets/${chunkB}`);
    assert.equal(active.status(), 200);
    console.log('  ok   active-release chunk serves from the release itself');

    const gone = await page.request.get(`${origin}/assets/DesignSystem-zzzzzzzz.js`);
    assert.equal(gone.status(), 404);
    assert.equal(gone.headers()['cache-control'], 'no-store');
    console.log('  ok   a chunk retained by no release stays an uncacheable 404');
  } finally {
    await browser.close();
  }
  console.log('two-release coexistence and worker update-propagation proof passed');
  // The spawned server's piped stdio would otherwise keep the event loop
  // alive forever; tear down and exit explicitly.
  cleanup();
  process.exit(0);
} catch (error) {
  console.error(Buffer.concat(serverLog).toString());
  console.error(error);
  cleanup();
  process.exit(1);
}
