#!/usr/bin/env node
/**
 * Prove the service-mode browser talks to a live marks-server.
 *
 * This is the production-path browser proof: artifact identity, scratch
 * admission, two isolated browser replicas, per-peer undo, preview writeback,
 * durable server commit, reload recovery, optional offline journal/reconnect,
 * public-slug admission, threshold persistence, drag/drop import/export, and
 * Markdown conversion. Pair its receipt with `live_service` for native peers
 * on the same document.
 *
 * Examples:
 *   MARKS_URL=http://127.0.0.1:3000 node scripts/ci-service-ui.mjs
 *   node scripts/ci-service-ui.mjs --url http://127.0.0.1:3000 --receipt /tmp/receipt.json
 *   node scripts/ci-service-ui.mjs --help
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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

const SCRATCH_STORAGE_KEY = 'marks.auth.scratch.v1';
function textPdf(text) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`;
  objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

const SCROLL_PROSE = Array.from(
  { length: 24 },
  (_, index) => `Paragraph ${index + 1}: enough current-service prose to make both panes scroll.`,
).join('\n\n');

const SERVICE_FIXTURE = (browserName) => `# Current ${browserName} service proof

Cross-browser ${browserName} proof 🧭

- [ ] shared service task

## Scroll synchronization

${SCROLL_PROSE}
`;

async function readReplicaEvidence(page, documentId, timeoutMs = 5_000) {
  return page.evaluate(async ({ id, timeout }) => {
    const deadline = Date.now() + timeout;
    const raw = sessionStorage.getItem('marks.auth.scratch.v1');
    const credential = raw ? JSON.parse(raw) : null;
    const headers = credential
      ? { Authorization: `MarksScratch ${credential.scratchId}.${credential.capability}` }
      : {};
    const controller = new AbortController();
    const fetchTimer = setTimeout(() => controller.abort(), timeout);
    let snapshotResponse;
    let exportResponse;
    try {
      [snapshotResponse, exportResponse] = await Promise.all([
        fetch(`/v1/scratch/documents/${encodeURIComponent(id)}/snapshot?shallow=1`, {
          headers,
          signal: controller.signal,
        }),
        fetch(`/v1/documents/${encodeURIComponent(id)}/export`, {
          headers,
          signal: controller.signal,
        }),
      ]);
    } finally {
      clearTimeout(fetchTimer);
    }
    const snapshot = new Uint8Array(await snapshotResponse.arrayBuffer());
    const journal = await new Promise((resolve, reject) => {
      let database = null;
      let settled = false;
      const settle = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        database?.close();
        callback(value);
      };
      const fail = (error) => settle(
        reject,
        error instanceof Error ? error : new Error(String(error ?? 'IndexedDB evidence failed')),
      );
      const timer = setTimeout(
        () => fail(new Error('timed out reading IndexedDB recovery evidence')),
        Math.max(1, deadline - Date.now()),
      );
      const request = indexedDB.open('keyval-store');
      request.onerror = () => fail(request.error);
      request.onblocked = () => fail(new Error('IndexedDB recovery evidence was blocked'));
      request.onsuccess = () => {
        database = request.result;
        if (!database.objectStoreNames.contains('keyval')) {
          settle(resolve, null);
          return;
        }
        const transaction = database.transaction('keyval', 'readonly');
        const get = transaction.objectStore('keyval').get(`marks:esbt:journal:${id}`);
        transaction.onerror = () => fail(transaction.error);
        transaction.onabort = () => fail(transaction.error ?? new Error('IndexedDB evidence aborted'));
        get.onerror = () => fail(get.error);
        get.onsuccess = () => {
          const value = get.result;
          settle(resolve, value
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
  }, { id: documentId, timeout: timeoutMs });
}

function requireCheck(check, name, pass, detail = '') {
  check(name, pass, detail);
  if (!pass) {
    throw new Error(`prerequisite failed: ${name}${detail ? ` (${detail})` : ''}`);
  }
}

function trackWait(promise) {
  void promise.catch(() => undefined);
  return promise;
}

async function withDeadline(promise, timeoutMs, label) {
  void promise.catch(() => undefined);
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitForServiceWorkerController(page, timeoutMs = 30_000) {
  await page.evaluate(async (timeout) => {
    await new Promise((resolve, reject) => {
      let settled = false;
      let listening = false;
      const cleanup = () => {
        clearTimeout(timer);
        if (listening) navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
      };
      const succeed = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const fail = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      const onControllerChange = () => {
        if (navigator.serviceWorker.controller) succeed();
      };
      const timer = setTimeout(() => {
        fail(new Error(
          `service worker did not become ready and control the page within ${timeout}ms`,
        ));
      }, timeout);

      navigator.serviceWorker.ready.then(() => {
        if (settled) return;
        if (navigator.serviceWorker.controller) {
          succeed();
          return;
        }
        listening = true;
        navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);
      }, fail);
    });
  }, timeoutMs);
}

function writeReceiptAtomically(path, receipt) {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
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
if (!['chromium', 'firefox', 'webkit'].includes(args.browser)) {
  throw new Error(`Error: unsupported browser ${args.browser}.`);
}
const receiptPath = args.receipt || process.env.MARKS_CI_RECEIPT || '';
if (receiptPath) rmSync(receiptPath, { force: true });
const results = [];
const applicationErrors = [];
const failedRequests = [];
let pendingReceipt = null;
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
};

const v1 = [];
function observePage(page, label) {
  page.on('console', (message) => {
    const text = message.text();
    if (
      message.type() === 'error' &&
      (text.includes('[marks]') || /Content Security Policy|Refused to (execute|load)/i.test(text))
    ) {
      applicationErrors.push(`${label} console: ${text}`);
    }
  });
  page.on('pageerror', (error) => {
    applicationErrors.push(`${label} pageerror: ${error.stack ?? error.message}`);
  });
  page.on('requestfailed', (request) => {
    failedRequests.push(
      `${label} ${request.method()} ${request.url()} — ${request.failure()?.errorText ?? 'unknown'}`,
    );
  });
  page.on('response', (response) => {
    const path = pathnameOf(response.url());
    if (path.startsWith('/v1') || path.startsWith('/api') || path.startsWith('/collab')) {
      v1.push({ label, method: response.request().method(), path, status: response.status() });
    }
  });
}

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
  observePage(page, 'primary');

  const sessionProbe = trackWait(page.waitForResponse(
    (response) => pathnameOf(response.url()) === '/v1/auth/session',
    { timeout: 30_000 },
  ));
  const catalogProbe = trackWait(page.waitForResponse(
    (response) =>
      response.request().method() === 'GET' && pathnameOf(response.url()) === '/v1/documents',
    { timeout: 30_000 },
  ));
  const created = trackWait(page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && pathnameOf(response.url()) === '/v1/documents',
    { timeout: 30_000 },
  ));
  // Register before navigation. Anonymous first paint creates a unique public
  // page and mounts its room without requiring a New-document click.
  const snapshotWait = trackWait(page.waitForResponse(
    (response) =>
      response.request().method() === 'GET' &&
      /\/v1\/scratch\/documents\/[^/]+\/snapshot/.test(pathnameOf(response.url())),
    { timeout: 30_000 },
  ));
  const ticketWait = trackWait(page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      /\/v1\/scratch\/documents\/[^/]+\/session$/.test(pathnameOf(response.url())),
    { timeout: 30_000 },
  ));
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  const mode = await page.evaluate(() => document.documentElement.dataset.marksMode ?? '');
  requireCheck(
    check,
    'documentElement is the service-mode build',
    mode === 'service',
    `service proof loaded data-marks-mode=${mode || 'missing'}; rebuild with VITE_MARKS_DATA_MODE=service`,
  );
  const artifactResponse = await page.request.get(`${BASE}/v1/artifact`);
  requireCheck(
    check,
    'runtime artifact endpoint responds',
    artifactResponse.ok(),
    `status ${artifactResponse.status()}`,
  );
  const artifact = await artifactResponse.json();
  requireCheck(check, 'runtime artifact receipt is coherent',
    artifact.engineCoherent === true
      && artifact.profileCoherent === true
      && artifact.staticArtifactVerified === true,
    `${artifact.serverEngineRevision} / ${artifact.componentEngineRevision}`);
  if (process.env.MARKS_REQUIRE_RELEASE === '1') {
    requireCheck(check, 'runtime artifact is release-ready', artifact.releaseReady === true, artifact.buildRevision);
  }
  const session = await sessionProbe;
  requireCheck(
    check,
    'first paint probes GET /v1/auth/session',
    session.status() === 401 || session.status() === 200,
    `status ${session.status()}`,
  );
  const catalog = await catalogProbe;
  requireCheck(check, 'home lists documents from GET /v1/documents', catalog.ok(), `status ${catalog.status()}`);
  const createdResponse = await created;
  requireCheck(
    check,
    'anonymous root creates a unique page through /v1/documents',
    createdResponse.status() === 201,
    `status ${createdResponse.status()}`,
  );
  const createdBody = await createdResponse.json();
  const documentId = createdBody?.document?.id;
  requireCheck(
    check,
    'create returns a document id',
    typeof documentId === 'string' && documentId.startsWith('document_'),
    String(documentId),
  );
  requireCheck(
    check,
    'anonymous page is public by its opaque slug on creation',
    createdBody?.document?.public === true &&
      createdBody?.document?.public_role === 'editor' &&
      createdBody?.document?.slug === documentId,
    JSON.stringify(createdBody?.document),
  );
  requireCheck(
    check,
    'anonymous slug is initialized with the editable marketing Markdown',
    createdBody?.document?.title === 'Google Docs for Markdown' &&
      createdBody?.document?.chars > 2_000,
    `${String(createdBody?.document?.title)} chars=${String(createdBody?.document?.chars)}`,
  );

  await page.waitForURL((url) => url.pathname === `/d/${documentId}`, { timeout: 30_000 });
  requireCheck(
    check,
    'router opens the server-created document',
    page.url().includes(`/d/${documentId}`),
    page.url(),
  );

  const [snapshot, ticket] = await Promise.all([snapshotWait, ticketWait]);
  requireCheck(
    check,
    'editor fetches the scratch snapshot prefix',
    snapshot.ok() && pathnameOf(snapshot.url()).includes(documentId),
    `status ${snapshot.status()} ${pathnameOf(snapshot.url())}`,
  );
  requireCheck(
    check,
    'editor mints a one-use room ticket',
    ticket.ok() && pathnameOf(ticket.url()).includes(documentId),
    `status ${ticket.status()} ${pathnameOf(ticket.url())}`,
  );

  const credential = await page.evaluate(() => {
    const raw = sessionStorage.getItem('marks.auth.scratch.v1');
    return raw ? JSON.parse(raw) : null;
  });
  requireCheck(
    check,
    'scratch credential is tab-scoped sessionStorage',
    Boolean(credential?.scratchId && credential?.capability),
    credential?.scratchId ?? 'missing',
  );

  await page.waitForSelector('.cm-content', { timeout: 30_000 });
  await page.waitForFunction(
    () => document.querySelector('.cm-content')?.innerText?.includes('Google Docs for Markdown') &&
      document.querySelector('.marks-preview')?.innerText?.includes('Typical Markdown') &&
      document.querySelector('.app')?.getAttribute('data-marketing') === 'true',
    undefined,
    { timeout: 30_000 },
  );
  const initialExport = await page.request.get(`${BASE}/v1/documents/${documentId}/export`, {
    headers: {
      Authorization: `MarksScratch ${credential.scratchId}.${credential.capability}`,
    },
  });
  requireCheck(
    check,
    'initial Markdown export responds',
    initialExport.ok(),
    `status ${initialExport.status()}`,
  );
  const initialMarkdown = await initialExport.text();
  requireCheck(
    check,
    'editable introduction is durable before the first user edit',
    initialMarkdown.includes('# Google Docs for Markdown') &&
      initialMarkdown.includes('Delete this entire introduction'),
  );
  const marketingPresentation = await page.evaluate(() => ({
    editor: document.querySelector('.cm-content')?.innerText ?? '',
    preview: document.querySelector('.marks-preview')?.innerText ?? '',
    marker: document.querySelector('.app')?.getAttribute('data-marketing') ?? '',
    mode: [...(document.querySelector('.workspace')?.classList ?? [])]
      .find((name) => name.startsWith('mode-')) ?? '',
  }));
  requireCheck(
    check,
    'new public slug renders the Markdown marketing page inside the real workspace',
    marketingPresentation.preview.includes('Typical Markdown') &&
      marketingPresentation.marker === 'true',
    `marker=${marketingPresentation.marker || 'missing'} mode=${marketingPresentation.mode || 'missing'} ` +
      `editor=${marketingPresentation.editor.length} preview=${marketingPresentation.preview.length}`,
  );
  const committedText = `Cross-browser ${args.browser} proof 🧭`;
  const fixture = SERVICE_FIXTURE(args.browser);
  requireCheck(
    check,
    'admitted scratch document is writable',
    await page.locator('.cm-content').getAttribute('contenteditable') === 'true',
  );
  await page.locator('.cm-content').click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a');
  await page.keyboard.insertText(fixture);
  await page.waitForFunction(
    (expected) => document.querySelector('.cm-content')?.textContent?.includes(expected),
    committedText,
    { timeout: 30_000 },
  );
  check(
    'user can delete and replace the entire marketing starter',
    !(await page.locator('.cm-content').innerText()).includes('Google Docs for Markdown'),
    committedText,
  );
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

  // Keep the edits separate so the room observes more than six anonymous
  // commits, then require the document metadata to expose the persistence
  // transition rather than inferring it from a still-open browser.
  for (let edit = 0; edit < 7; edit += 1) {
    await page.locator('.cm-content').click();
    await page.keyboard.press('End');
    await page.keyboard.insertText(String(edit));
    await page.waitForTimeout(80);
  }
  await page.waitForFunction(
    async ({ documentId, credential }) => {
      const response = await fetch(`/v1/documents/${documentId}`, {
        headers: {
          Authorization: `MarksScratch ${credential.scratchId}.${credential.capability}`,
        },
      }).catch(() => null);
      if (!response?.ok) return false;
      const body = await response.json();
      return body.document?.public === true &&
        body.document?.anonymous_edits > 6 &&
        body.document?.persisted === true &&
        Number.isFinite(body.document?.persisted_at);
    },
    { documentId, credential },
    { timeout: 30_000 },
  );
  check('more than six anonymous edits mark the public page persisted', true);

  await page.waitForSelector('.marks-preview input[type=checkbox]', { timeout: 30_000 });
  check(
    'current service renders an interactive task from the admitted replica',
    (await page.locator('.marks-preview input[type=checkbox]').count()) === 1,
  );
  await page.evaluate(() => {
    const preview = document.querySelector('.preview-pane');
    const editor = document.querySelector('.cm-scroller');
    if (!(preview instanceof HTMLElement) || !(editor instanceof HTMLElement)) {
      throw new Error('scroll panes are missing');
    }
    preview.scrollTop = 0;
    editor.scrollTop = 0;
  });
  const previewCheckbox = page.locator('.marks-preview input[type=checkbox]');
  await page.waitForTimeout(200);
  const checkboxCenter = await previewCheckbox.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  // Use the settled DOM box so WebKit cannot calculate its action point from
  // the preview's prior synchronized scroll position.
  await page.mouse.click(checkboxCenter.x, checkboxCenter.y);
  await page.waitForFunction(
    () => document.querySelector('.cm-content')?.textContent?.includes('[x] shared service task'),
    undefined,
    { timeout: 15_000 },
  );
  await page.waitForFunction(
    async ({ documentId, credential }) => {
      const response = await fetch(`/v1/documents/${documentId}/export`, {
        headers: {
          Authorization: `MarksScratch ${credential.scratchId}.${credential.capability}`,
        },
      }).catch(() => null);
      return response?.ok && (await response.text()).includes('[x] shared service task');
    },
    { documentId, credential },
    { timeout: 30_000 },
  );
  check('preview checkbox writes through to the editor and durable service source', true);

  const outlineChord = process.platform === 'darwin' ? 'Meta+Shift+o' : 'Control+Shift+o';
  await page.keyboard.press(outlineChord);
  await page.waitForSelector('.outline-item', { timeout: 10_000 });
  const outlineItems = await page.locator('.outline-item').allInnerTexts();
  check(
    'current service outline reflects admitted Markdown headings',
    outlineItems.some((text) => text.trim() === `Current ${args.browser} service proof`) &&
      outlineItems.some((text) => text.trim() === 'Scroll synchronization'),
    JSON.stringify(outlineItems.map((text) => text.trim())),
  );
  await page.locator('button[aria-label="Close outline"]').click();

  await page.evaluate(() => {
    const preview = document.querySelector('.preview-pane');
    const editor = document.querySelector('.cm-scroller');
    if (!(preview instanceof HTMLElement) || !(editor instanceof HTMLElement)) {
      throw new Error('scroll panes are missing');
    }
    preview.scrollTop = 0;
    editor.scrollTop = Math.floor(editor.scrollHeight / 2);
    editor.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  await page.waitForTimeout(600);
  const previewScroll = await page.evaluate(
    () => document.querySelector('.preview-pane')?.scrollTop ?? 0,
  );
  check('current service editor scrolling moves the preview', previewScroll > 0, String(previewScroll));

  // Open the slug in a completely isolated anonymous profile without copying
  // the owner's scratch capability. Public-by-URL collaboration must mint a
  // different scratch identity and its own one-use room ticket. Separate
  // BrowserContexts also rule out IndexedDB or BroadcastChannel shortcuts.
  const peerContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const peerPage = await peerContext.newPage();
  observePage(peerPage, 'peer');
  const peerSnapshotWait = trackWait(peerPage.waitForResponse(
    (response) =>
      response.request().method() === 'GET' &&
      pathnameOf(response.url()) === `/v1/scratch/documents/${documentId}/snapshot`,
    { timeout: 30_000 },
  ));
  const peerTicketWait = trackWait(peerPage.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      pathnameOf(response.url()) === `/v1/scratch/documents/${documentId}/session`,
    { timeout: 30_000 },
  ));
  await peerPage.goto(`${BASE}/d/${documentId}`, { waitUntil: 'domcontentloaded' });
  const [peerSnapshot, peerTicket] = await Promise.all([peerSnapshotWait, peerTicketWait]);
  const peerCredential = await peerPage.evaluate((storageKey) => {
    const raw = sessionStorage.getItem(storageKey);
    return raw ? JSON.parse(raw) : null;
  }, SCRATCH_STORAGE_KEY);
  requireCheck(
    check,
    'copy-pasted slug admits a different anonymous editor without sharing settings',
    peerSnapshot.ok() &&
      peerTicket.ok() &&
      Boolean(peerCredential?.scratchId) &&
      peerCredential.scratchId !== credential.scratchId,
    `snapshot ${peerSnapshot.status()} ticket ${peerTicket.status()} peer ${peerCredential?.scratchId ?? 'missing'}`,
  );
  await peerPage.waitForSelector('.cm-content', { timeout: 30_000 });
  await peerPage.waitForFunction(
    ({ expected, task }) => {
      const source = document.querySelector('.cm-content')?.textContent;
      return source?.includes(expected) && source.includes(task);
    },
    { expected: committedText, task: '[x] shared service task' },
    { timeout: 30_000 },
  );
  check('isolated browser peer cold-opens committed content including preview writeback', true);

  const peerText = `Second ${args.browser} browser edit`;
  await peerPage.locator('.cm-line').last().click();
  await peerPage.keyboard.press('End');
  await peerPage.keyboard.insertText(`\n\n${peerText}`);
  await page.waitForFunction(
    (expected) => document.querySelector('.cm-content')?.textContent?.includes(expected),
    peerText,
    { timeout: 30_000 },
  );
  check('isolated browser replicas converge through marks-server', true, peerText);

  await page.waitForSelector('.esbt-caret', { timeout: 15_000 });
  check('current service paints the remote browser caret', true);
  await page.waitForFunction(
    () => document.querySelectorAll('.presence-avatar-button').length >= 2,
    undefined,
    { timeout: 15_000 },
  );
  check('presence bar shows both live browser connections', true, '2 connections');

  const undoChord = process.platform === 'darwin' ? 'Meta+z' : 'Control+z';
  let peerSource = await peerPage.locator('.cm-content').innerText();
  for (let attempt = 0; attempt < 5 && peerSource.includes(peerText); attempt += 1) {
    await peerPage.locator('.cm-content').click();
    await peerPage.keyboard.press(undoChord);
    await peerPage.waitForTimeout(500);
    peerSource = await peerPage.locator('.cm-content').innerText();
  }
  check(
    'per-peer undo removes only the second browser edit',
    !peerSource.includes(peerText) && peerSource.includes(committedText),
  );
  await page.waitForFunction(
    (removed) => !document.querySelector('.cm-content')?.textContent?.includes(removed),
    peerText,
    { timeout: 30_000 },
  );
  check('the first browser receives the second browser undo', true);

  await peerContext.close();

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
    try {
      const recoveryEvidence = await withDeadline(
        readReplicaEvidence(page, documentId),
        7_000,
        'reload recovery evidence',
      );
      console.error(`reload recovery evidence: ${JSON.stringify(recoveryEvidence)}`);
    } catch (evidenceError) {
      console.error(
        `reload recovery evidence unavailable: ${evidenceError instanceof Error ? evidenceError.message : String(evidenceError)}`,
      );
    }
    throw error;
  }
  check('reload reopens committed text', true);

  if (process.env.MARKS_TEST_SERVICE_WORKER === '1') {
    await waitForServiceWorkerController(page);
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

  const importedMarkdown = `# Imported on ${args.browser}\n\nPortable UTF-16: 🧪`;
  const convertedImport = trackWait(page.waitForResponse(
    (response) => response.request().method() === 'POST' && pathnameOf(response.url()) === '/v1/import/file',
    { timeout: 30_000 },
  ));
  const importedResponse = trackWait(page.waitForResponse(
    (response) => response.request().method() === 'POST' && pathnameOf(response.url()) === '/v1/documents',
    { timeout: 30_000 },
  ));
  const draggedFile = {
    name: `browser-${args.browser}.md`,
    mimeType: 'text/markdown',
    markdown: importedMarkdown,
  };
  await page.evaluate(({ name, mimeType, markdown }) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([markdown], name, { type: mimeType }));
    document.querySelector('.app')?.dispatchEvent(new DragEvent('dragenter', {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
    }));
  }, draggedFile);
  await page.waitForSelector('.document-drop-target', { timeout: 10_000 });
  check('supported document drag shows the Markdown import target', true);
  await page.evaluate(({ name, mimeType, markdown }) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([markdown], name, { type: mimeType }));
    document.querySelector('.app')?.dispatchEvent(new DragEvent('drop', {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
    }));
  }, draggedFile);
  const converted = await convertedImport;
  const imported = await importedResponse;
  requireCheck(
    check,
    'dropped file conversion responds',
    converted.ok(),
    `status ${converted.status()}`,
  );
  requireCheck(
    check,
    'converted document creation responds',
    imported.status() === 201,
    `status ${imported.status()}`,
  );
  const importedBody = await imported.json();
  const importedId = importedBody?.document?.id;
  requireCheck(
    check,
    'converted import returns a populated public document id',
    typeof importedId === 'string' &&
      importedId.startsWith('document_') &&
      importedBody?.document?.public === true,
    JSON.stringify(importedBody?.document),
  );
  await page.waitForURL((url) => url.pathname === `/d/${importedId}`, { timeout: 30_000 });
  await page.waitForSelector('.cm-content', { timeout: 30_000 });
  await page.waitForFunction(
    (expected) => document.querySelector('.cm-content')?.textContent?.includes(expected),
    `Imported on ${args.browser}`,
    { timeout: 30_000 },
  );
  check(
    'document drop converts and creates one populated public page',
    true,
    `${converted.status()} / ${imported.status()} / ${String(importedId)}`,
  );

  const downloadEvent = trackWait(page.waitForEvent('download', { timeout: 30_000 }));
  await page.locator('.titlebar-download').click();
  const download = await downloadEvent;
  const downloadPath = await download.path();
  const downloaded = downloadPath ? readFileSync(downloadPath, 'utf8') : '';
  check('Markdown export returns the current source', downloaded === importedMarkdown, download.suggestedFilename());

  const pdfText = `Browser Wasm ${args.browser} PDF drop proof`;
  const pdfImportsBefore = v1.filter((entry) =>
    entry.method === 'POST' && entry.path === '/v1/import/file').length;
  const pdfCreatedResponse = trackWait(page.waitForResponse(
    (response) => response.request().method() === 'POST' && pathnameOf(response.url()) === '/v1/documents',
    { timeout: 45_000 },
  ));
  const pdfFixture = {
    name: `browser-wasm-${args.browser}.pdf`,
    base64: textPdf(pdfText).toString('base64'),
  };
  await page.evaluate(({ name, base64 }) => {
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], name, { type: 'application/pdf' }));
    document.querySelector('.app')?.dispatchEvent(new DragEvent('dragenter', {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
    }));
    document.querySelector('.app')?.dispatchEvent(new DragEvent('drop', {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
    }));
  }, pdfFixture);
  const pdfCreated = await pdfCreatedResponse;
  const pdfBody = await pdfCreated.json();
  const pdfDocumentId = pdfBody?.document?.id;
  requireCheck(
    check,
    'browser Wasm PDF drop creates a populated public Markdown page',
    pdfCreated.status() === 201 &&
      typeof pdfDocumentId === 'string' &&
      pdfBody?.document?.public === true,
    `${pdfCreated.status()} / ${String(pdfDocumentId)}`,
  );
  await page.waitForURL((url) => url.pathname === `/d/${pdfDocumentId}`, { timeout: 45_000 });
  await page.waitForFunction(
    (expected) => document.querySelector('.cm-content')?.textContent?.includes(expected),
    pdfText,
    { timeout: 45_000 },
  );
  const pdfImportsAfter = v1.filter((entry) =>
    entry.method === 'POST' && entry.path === '/v1/import/file').length;
  check(
    'PDF drop stays in browser Wasm and never uploads to the server',
    pdfImportsAfter === pdfImportsBefore,
    `${pdfImportsBefore} before / ${pdfImportsAfter} after`,
  );

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

  if (receiptPath) {
    pendingReceipt = {
      documentId,
      scratchId: credential.scratchId,
      capability: credential.capability,
      origin: BASE,
      browser: args.browser,
      artifact,
    };
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
if (failed.length === 0 && receiptPath) {
  if (!pendingReceipt) throw new Error('service-mode receipt was not prepared');
  writeReceiptAtomically(receiptPath, pendingReceipt);
  console.log(`receipt: ${receiptPath}`);
}
process.exit(failed.length === 0 ? 0 : 1);
