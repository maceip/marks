/**
 * Three-platform collision: Playwright, Puppeteer, and agent-browser each
 * open the same ESBT document, type a unique marker at the same time, and
 * must all see every marker. Each test screenshots that browser afterward.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { DRIVER_NAMES, discoverDrivers, missingDriverHelp } from './discover.mjs';
import { ensureServer } from './ensure-server.mjs';

const MARKERS = {
  playwright: 'PW_COLLIDE_7f3a9c',
  puppeteer: 'PP_COLLIDE_1b8e42',
  'agent-browser': 'AB_COLLIDE_4e2d11',
};

const ALL_MARKERS = Object.values(MARKERS);

function shotDir() {
  if (existsSync('/opt/cursor/artifacts')) return '/opt/cursor/artifacts';
  const dir = join(tmpdir(), 'marks-collab-shots');
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function loadDriver(name) {
  if (name === 'playwright') return import('./drivers/playwright.mjs');
  if (name === 'puppeteer') return import('./drivers/puppeteer.mjs');
  if (name === 'agent-browser') return import('./drivers/agent-browser.mjs');
  throw new Error(`unknown driver: ${name}`);
}

async function createDocument(base) {
  const res = await fetch(`${base.replace(/\/$/, '')}/api/documents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Three-platform collision' }),
  });
  if (!res.ok) {
    throw new Error(`POST /api/documents failed: ${res.status} ${await res.text()}`);
  }
  const body = await res.json();
  const id = body?.document?.id;
  if (!id) throw new Error(`createDocument: no id in ${JSON.stringify(body)}`);
  return id;
}

async function previewText(session) {
  try {
    return String((await session.textContent('.marks-preview')) ?? '');
  } catch {
    return '';
  }
}

async function untilPreviewsContain(sessions, markers, { timeout = 25_000 } = {}) {
  const started = Date.now();
  let last = {};
  while (Date.now() - started < timeout) {
    last = {};
    let ok = true;
    for (const [name, session] of Object.entries(sessions)) {
      const text = await previewText(session);
      last[name] = text;
      if (!markers.every((marker) => text.includes(marker))) ok = false;
    }
    if (ok) return last;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  const detail = Object.entries(last)
    .map(([name, text]) => `${name}: ${JSON.stringify(text).slice(0, 240)}`)
    .join('\n');
  throw new Error(`previews did not converge on ${markers.join(', ')}\n${detail}`);
}

describe('three-platform collisions and edits', { timeout: 180_000 }, () => {
  /** @type {Record<string, object>} */
  let sessions = {};
  let base = '';

  before(async () => {
    const report = discoverDrivers();
    for (const name of DRIVER_NAMES) {
      if (!report.drivers[name]?.available) {
        throw new Error(missingDriverHelp(name, report));
      }
    }
    if (!report.chrome.automation && !report.chrome.playwright) {
      throw new Error('No Chrome/Chromium for Puppeteer or agent-browser. Set CHROMIUM_PATH.');
    }

    const server = await ensureServer();
    base = server.url;

    const docId = await createDocument(base);
    const path = `/d/${docId}`;

    for (const name of DRIVER_NAMES) {
      const driver = await loadDriver(name);
      sessions[name] = await driver.launch({
        base,
        headless: true,
        chrome: report.chrome,
      });
      await sessions[name].goto(path);
      await sessions[name].waitForSelector('.cm-content', { timeout: 25_000 });
    }

    await Promise.all(Object.values(sessions).map((session) => session.wait(1_500)));
    await Promise.all(Object.values(sessions).map((session) => session.click('.cm-content')));
    await Promise.all(
      DRIVER_NAMES.map((name) => sessions[name].insertText(`\n${MARKERS[name]}\n`)),
    );

    await untilPreviewsContain(sessions, ALL_MARKERS);
  });

  after(async () => {
    for (const session of Object.values(sessions)) {
      try {
        await session.close();
      } catch {
        // browser already gone
      }
    }
  });

  for (const name of DRIVER_NAMES) {
    test(
      `${name} preview contains every peer's concurrent edit`,
      { timeout: 60_000 },
      async () => {
        const dest = join(shotDir(), `collab_${name.replace(/[^a-z0-9-]/gi, '_')}.png`);
        try {
          const text = await previewText(sessions[name]);
          for (const marker of ALL_MARKERS) {
            assert.ok(
              text.includes(marker),
              `${name} preview missing ${marker}: ${text.slice(0, 300)}`,
            );
          }
        } finally {
          mkdirSync(shotDir(), { recursive: true });
          await sessions[name].screenshot(dest);
          console.log(`screenshot ${name}: ${dest}`);
        }
      },
    );
  }
});
