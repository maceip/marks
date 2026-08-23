#!/usr/bin/env node
/**
 * Prove the service-mode browser talks to a live marks-server.
 *
 * This is not the two-browser preview-sync smoke. The Wasm CollabSession
 * mints a site-bound ticket, then fetches the scratch snapshot, then
 * connects. This script only checks first-paint identity, catalog create,
 * snapshot fetch, and ticket mint. Pair it with `live_service` for two-peer
 * native convergence on the same document.
 *
 * Examples:
 *   MARKS_URL=http://127.0.0.1:3000 node scripts/ci-service-ui.mjs
 *   node scripts/ci-service-ui.mjs --url http://127.0.0.1:3000 --receipt /tmp/receipt.json
 *   node scripts/ci-service-ui.mjs --help
 */
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { CHROME_LAUNCH_ARGS, launchEnv } from './harness/env.mjs';

function printHelp() {
  console.log(`Usage:
  node scripts/ci-service-ui.mjs --url <origin> [--receipt <path>]

Prove the service-mode client (VITE_MARKS_DATA_MODE=service) against a
running marks-server. Writes a receipt the Rust two-peer test consumes.

Options:
  --url <origin>       marks-server origin (or MARKS_URL). Required.
  --receipt <path>     JSON receipt path (or MARKS_CI_RECEIPT).
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
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--url' || arg === '--receipt') {
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
const receiptPath = args.receipt || process.env.MARKS_CI_RECEIPT || '';
const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
};

const v1 = [];
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: CHROME_LAUNCH_ARGS,
  env: launchEnv(),
});

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
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

  check(
    'no Node /api alias',
    v1.every((entry) => !entry.path.startsWith('/api')),
    v1
      .filter((entry) => entry.path.startsWith('/api'))
      .map((entry) => `${entry.method} ${entry.path}`)
      .join(', '),
  );

  if (receiptPath && credential && typeof documentId === 'string') {
    const receipt = {
      documentId,
      scratchId: credential.scratchId,
      capability: credential.capability,
      origin: BASE,
    };
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    console.log(`receipt: ${receiptPath}`);
  } else if (receiptPath) {
    check('wrote service-mode receipt', false, 'missing document or scratch');
  }
} finally {
  await browser.close();
}

const failed = results.filter((result) => !result.pass);
console.log(`\n${results.length - failed.length}/${results.length} service-mode UI checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
