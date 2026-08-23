#!/usr/bin/env node
/**
 * Prove the service-mode browser talks to a live marks-server.
 *
 * This is the production-path browser proof: artifact identity, scratch
 * admission, Wasm editing, durable server commit, reload recovery, optional
 * offline journal/reconnect, and Markdown import/export. Pair its receipt
 * with `live_service` for a native second peer on the same document.
 *
 * Examples:
 *   MARKS_URL=http://127.0.0.1:3000 node scripts/ci-service-ui.mjs
 *   node scripts/ci-service-ui.mjs --url http://127.0.0.1:3000 --receipt /tmp/receipt.json
 *   node scripts/ci-service-ui.mjs --help
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { chromium, firefox, webkit } from 'playwright';
import { CHROME_LAUNCH_ARGS, launchEnv } from './harness/env.mjs';

function printHelp() {
  console.log(`Usage:
  node scripts/ci-service-ui.mjs --url <origin> [--browser chromium|firefox|webkit] [--receipt <path>]

Prove the service-mode client (VITE_MARKS_DATA_MODE=service) against a
running marks-server. Writes a receipt the Rust two-peer test consumes.

Options:
  --url <origin>       marks-server origin (or MARKS_URL). Required.
  --receipt <path>     JSON receipt path (or MARKS_CI_RECEIPT).
  --browser <name>     Playwright engine (or MARKS_BROWSER; default chromium).
  --help               Show this help.

Examples:
  node scripts/ci-service-ui.mjs --url http://127.0.0.1:3000
  MARKS_URL=http://127.0.0.1:3000 node scripts/ci-service-ui.mjs --receipt /tmp/marks-ci-receipt.json
`);
}

function parseArgs(argv) {
  const options = {
    url: process.env.MARKS_URL ?? '',
    receipt: process.env.MARKS_CI_RECEIPT ?? '',
    browser: process.env.MARKS_BROWSER ?? 'chromium',
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--url' || arg === '--receipt' || arg === '--browser') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`Error: ${arg} needs a value.\n  node scripts/ci-service-ui.mjs --url http://127.0.0.1:3000 --receipt /tmp/marks-ci-receipt.json`);
      }
      options[arg.slice(2)] = value;
      index += 1;
      continue;
    }
    throw new Error(`Error: unknown argument ${arg}.\n  node scripts/ci-service-ui.mjs --help`);
  }
  return options;
}

function pathnameOf(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

async function readReplicaEvidence(page, documentId) {
  return page.evaluate(async (id) => {
    const raw = sessionStorage.getItem('marks.auth.scratch.v1');
    const credential = raw ? JSON.parse(raw) : null;
    const headers = credential
      ? { Authorization: `MarksScratch ${credential.scratchId}.${credential.capability}` }
      : {};
    const [snapshotResponse, exportResponse] = await Promise.all([
      fetch(`/v1/scratch/documents/${encodeURIComponent(id)}/snapshot?shallow=1`, { headers }),
      fetch(`/v1/documents/${encodeURIComponent(id)}/export`, { headers }),
    ]);
    const snapshot = new Uint8Array(await snapshotResponse.arrayBuffer());
    const journal = await new Promise((resolve, reject) => {
      const request = indexedDB.open('keyval-store');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains('keyval')) {
          resolve(null);
          database.close();
          return;
        }
        const transaction = database.transaction('keyval', 'readonly');
        const get = transaction.objectStore('keyval').get(`marks:esbt:journal:${id}`);
        get.onerror = () => reject(get.error);
        get.onsuccess = () => {
          const value = get.result;
          resolve(value
            ? {
                version: value.version,
                siteId: value.siteId,
                role: value.role,
                snapshotBytes: value.snapshot?.byteLength ?? -1,
                snapshotPrefix: [...(value.snapshot?.slice(0, 12) ?? [])],
                pending: value.pending?.map((item) => ({
                  id: item.id,
                  kind: item.kind,
                  bytes: item.bytes?.byteLength ?? -1,
                  prefix: [...(item.bytes?.slice(0, 12) ?? [])],
                })) ?? [],
              }
            : null);
          database.close();
        };
      };
    });
    return {
      editor: document.querySelector('.cm-content')?.textContent ?? null,
      exported: await exportResponse.text(),
      snapshot: {
        status: snapshotResponse.status,
        bytes: snapshot.byteLength,
        prefix: [...snapshot.slice(0, 12)],
      },
      journal,
    };
  }, documentId);
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printHelp();
  process.exit(0);
}
if (!args.url) {
  console.error('Error: --url or MARKS_URL is required.');
  console.error('  node scripts/ci-service-ui.mjs --url http://127.0.0.1:3000');
  process.exit(2);
}

const BASE = args.url.replace(/\/$/, '');
if (!['chromium', 'firefox', 'webkit'].includes(args.browser)) {
  throw new Error(`Error: unsupported browser ${args.browser}.`);
}
const receiptPath = args.receipt || process.env.MARKS_CI_RECEIPT || '';
const results = [];
const applicationErrors = [];
const failedRequests = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
};

const v1 = [];
const browserType = { chromium, firefox, webkit }[args.browser];
const browser = await browserType.launch(
  args.browser === 'chromium'
    ? {
        executablePath: process.env.CHROMIUM_PATH || undefined,
        args: CHROME_LAUNCH_ARGS,
        env: launchEnv(),
      }
    : {},
);

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on('console', (message) => {
    const text = message.text();
    if (
      message.type() === 'error' &&
      (text.includes('[marks]') || /Content Security Policy|Refused to (execute|load)/i.test(text))
    ) {
      applicationErrors.push(`console: ${text}`);
    }
  });
  page.on('pageerror', (error) => {
    applicationErrors.push(`pageerror: ${error.stack ?? error.message}`);
  });
  page.on('requestfailed', (request) => {
    failedRequests.push(
      `${request.method()} ${request.url()} — ${request.failure()?.errorText ?? 'unknown'}`,
    );
  });
  page.on('response', (response) => {
    const path = pathnameOf(response.url());
    if (path.startsWith('/v1') || path.startsWith('/api') || path.startsWith('/collab')) {
      v1.push({ method: response.request().method(), path, status: response.status() });
    }
  });

  const sessionProbe = page.waitForResponse(
    (response) => pathnameOf(response.url()) === '/v1/auth/session',
    { timeout: 30_000 },
  );
  const catalogProbe = page.waitForResponse(
    (response) =>
      response.request().method() === 'GET' && pathnameOf(response.url()) === '/v1/documents',
    { timeout: 30_000 },
  );
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  const artifactResponse = await page.request.get(`${BASE}/v1/artifact`);
  const artifact = await artifactResponse.json();
  check('runtime artifact receipt is coherent',
    artifactResponse.ok()
      && artifact.engineCoherent === true
      && artifact.profileCoherent === true
      && artifact.staticArtifactVerified === true,
    `${artifact.serverEngineRevision} / ${artifact.wasmEngineRevision}`);
  if (process.env.MARKS_REQUIRE_RELEASE === '1') {
    check('runtime artifact is release-ready', artifact.releaseReady === true, artifact.buildRevision);
  }
  const session = await sessionProbe;
  check('first paint probes GET /v1/auth/session', session.status() === 401 || session.status() === 200, `status ${session.status()}`);
  const catalog = await catalogProbe;
  check('home lists documents from GET /v1/documents', catalog.ok(), `status ${catalog.status()}`);

  const mode = await page.evaluate(() => document.documentElement.dataset.marksMode ?? '');
  check('documentElement is the service-mode build', mode === 'service', `data-marks-mode=${mode || 'missing'}`);
  await page.waitForSelector('.home-actions .button.primary, .new-doc .button.primary', {
    timeout: 30_000,
  });

  const created = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && pathnameOf(response.url()) === '/v1/documents',
    { timeout: 30_000 },
  );
  // Register before the click: the Wasm session admits (binds site) then
  // fetches the snapshot, and either request can fire as soon as the
  // editor route mounts.
  const snapshotWait = page.waitForResponse(
    (response) =>
      response.request().method() === 'GET' &&
      /\/v1\/scratch\/documents\/[^/]+\/snapshot/.test(pathnameOf(response.url())),
    { timeout: 30_000 },
  );
  const ticketWait = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      /\/v1\/scratch\/documents\/[^/]+\/session$/.test(pathnameOf(response.url())),
    { timeout: 30_000 },
  );
  await page.locator('.home-actions .button.primary, .new-doc .button.primary').first().click();
  const createdResponse = await created;
  check('New document POSTs /v1/documents', createdResponse.status() === 201, `status ${createdResponse.status()}`);
  const createdBody = await createdResponse.json();
  const documentId = createdBody?.document?.id;
  check('create returns a document id', typeof documentId === 'string' && documentId.startsWith('document_'), String(documentId));

  await page.waitForURL((url) => url.pathname === `/d/${documentId}`, { timeout: 30_000 });
  check('router opens the server-created document', page.url().includes(`/d/${documentId}`));

  const [snapshot, ticket] = await Promise.all([snapshotWait, ticketWait]);
  check(
    'editor fetches the scratch snapshot prefix',
    snapshot.ok() && pathnameOf(snapshot.url()).includes(documentId),
    `status ${snapshot.status()} ${pathnameOf(snapshot.url())}`,
  );
  check(
    'editor mints a one-use room ticket',
    ticket.ok() && pathnameOf(ticket.url()).includes(documentId),
    `status ${ticket.status()} ${pathnameOf(ticket.url())}`,
  );

  const credential = await page.evaluate(() => {
    const raw = sessionStorage.getItem('marks.auth.scratch.v1');
    return raw ? JSON.parse(raw) : null;
  });
  check(
    'scratch credential is tab-scoped sessionStorage',
    Boolean(credential?.scratchId && credential?.capability),
  );

  await page.waitForSelector('.cm-content', { timeout: 30_000 });
  const committedText = `Cross-browser ${args.browser} proof 🧭`;
  check(
    'admitted scratch document is writable',
    await page.locator('.cm-content').getAttribute('contenteditable') === 'true',
  );
  await page.locator('.cm-content').click();
  await page.keyboard.insertText(committedText);
  await page.waitForFunction(
    (expected) => document.querySelector('.cm-content')?.textContent?.includes(expected),
    committedText,
    { timeout: 30_000 },
  );
  check('editor accepts the local mutation', true, committedText);
  await page.waitForFunction(
    async ({ documentId, credential, expected }) => {
      const response = await fetch(`/v1/documents/${documentId}/export`, {
        headers: {
          Authorization: `MarksScratch ${credential.scratchId}.${credential.capability}`,
        },
      }).catch(() => null);
      return response?.ok && (await response.text()).includes(expected);
    },
    { documentId, credential, expected: committedText },
    { timeout: 30_000 },
  );
  check('editor mutation receives a durable server-visible commit', true, committedText);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.cm-content', { timeout: 30_000 });
  try {
    await page.waitForFunction(
      (expected) => document.querySelector('.cm-content')?.textContent?.includes(expected),
      committedText,
      { timeout: 30_000 },
    );
  } catch (error) {
    console.error(`reload editor text: ${JSON.stringify(await page.locator('.cm-content').textContent())}`);
    console.error(`reload requests: ${JSON.stringify(v1.slice(-20))}`);
    console.error(`reload status: ${JSON.stringify(await page.locator('.status').textContent().catch(() => null))}`);
    const recoveryEvidence = await readReplicaEvidence(page, documentId);
    console.error(`reload recovery evidence: ${JSON.stringify(recoveryEvidence)}`);
    throw error;
  }
  check('reload reopens committed text', true);

  if (process.env.MARKS_TEST_SERVICE_WORKER === '1') {
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) {
        await new Promise((resolve) => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
      }
    });
    await context.setOffline(true);
    if (args.browser === 'webkit') {
      // Playwright's WebKit port aborts an offline top-level navigation before
      // a controlling service worker can answer it. Still prove real network
      // isolation plus the mounted replica's offline journal/reconnect path;
      // Chromium and Firefox cover cold service-worker boot above this layer.
      const isolated = await page.evaluate(async () => {
        try {
          await fetch(`/v1/artifact?offline-proof=${crypto.randomUUID()}`, {
            cache: 'no-store',
          });
          return false;
        } catch {
          return true;
        }
      });
      check('WebKit network is isolated before the offline edit', isolated);
    } else {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.cm-content', { timeout: 30_000 });
      await page.waitForFunction(
        (expected) => document.querySelector('.cm-content')?.textContent?.includes(expected),
        committedText,
        { timeout: 30_000 },
      );
      check('service worker cold-opens the journal offline', true);
    }
    const offlineText = ` offline-${args.browser}`;
    await page.locator('.cm-content').click();
    await page.keyboard.insertText(offlineText);
    await page.waitForFunction(
      (expected) => document.querySelector('.cm-content')?.textContent?.includes(expected),
      offlineText,
      { timeout: 30_000 },
    );
    check('Wasm replica accepts a journaled edit while offline', true, offlineText);
    await context.setOffline(false);
    await page.waitForFunction(
      async ({ documentId, credential, expected }) => {
        const response = await fetch(`/v1/documents/${documentId}/export`, {
          headers: {
            Authorization: `MarksScratch ${credential.scratchId}.${credential.capability}`,
          },
        }).catch(() => null);
        return response?.ok && (await response.text()).includes(expected);
      },
      { documentId, credential, expected: offlineText },
      { timeout: 45_000 },
    );
    check('offline edit reconnects and commits', true, offlineText);
  }

  const importedMarkdown = `# Imported on ${args.browser}\n\nPortable UTF-16: 🧪\n`;
  const importedResponse = page.waitForResponse(
    (response) => response.request().method() === 'POST' && pathnameOf(response.url()) === '/v1/documents',
    { timeout: 30_000 },
  );
  await page.locator('input[accept*=".md"]').setInputFiles({
    name: `browser-${args.browser}.md`,
    mimeType: 'text/markdown',
    buffer: Buffer.from(importedMarkdown),
  });
  const imported = await importedResponse;
  const importedBody = await imported.json();
  const importedId = importedBody?.document?.id;
  await page.waitForURL((url) => url.pathname === `/d/${importedId}`, { timeout: 30_000 });
  await page.waitForSelector('.cm-content', { timeout: 30_000 });
  await page.waitForFunction(
    (expected) => document.querySelector('.cm-content')?.textContent?.includes(expected),
    `Imported on ${args.browser}`,
    { timeout: 30_000 },
  );
  check('Markdown import creates one populated document', imported.status() === 201, String(importedId));

  const downloadEvent = page.waitForEvent('download', { timeout: 30_000 });
  await page.locator('.titlebar-download').click();
  const download = await downloadEvent;
  const downloadPath = await download.path();
  const downloaded = downloadPath ? readFileSync(downloadPath, 'utf8') : '';
  check('Markdown export returns the current source', downloaded === importedMarkdown, download.suggestedFilename());

  check(
    'no Node /api alias',
    v1.every((entry) => !entry.path.startsWith('/api')),
    v1
      .filter((entry) => entry.path.startsWith('/api'))
      .map((entry) => `${entry.method} ${entry.path}`)
      .join(', '),
  );
  check(
    'no uncaught application errors',
    applicationErrors.length === 0,
    applicationErrors.join(' | '),
  );

  if (receiptPath && credential && typeof documentId === 'string') {
    const receipt = {
      documentId,
      scratchId: credential.scratchId,
      capability: credential.capability,
      origin: BASE,
      browser: args.browser,
      artifact,
    };
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    console.log(`receipt: ${receiptPath}`);
  } else if (receiptPath) {
    check('wrote service-mode receipt', false, 'missing document or scratch');
  }
} catch (error) {
  if (applicationErrors.length > 0) {
    console.error(`application errors: ${JSON.stringify(applicationErrors)}`);
  }
  if (failedRequests.length > 0) {
    console.error(`recent failed requests: ${JSON.stringify(failedRequests.slice(-30))}`);
  }
  console.error(`recent service requests: ${JSON.stringify(v1.slice(-30))}`);
  throw error;
} finally {
  await browser.close();
}

const failed = results.filter((result) => !result.pass);
console.log(`\n${results.length - failed.length}/${results.length} service-mode UI checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
