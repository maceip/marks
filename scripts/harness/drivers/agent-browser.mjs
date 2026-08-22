/**
 * Drive the Vercel Labs agent-browser CLI as a page adapter.
 *
 * agent-browser is not a Node library. Every action is one CLI invocation
 * against a named session. Chrome is launched by this harness (shared
 * no-sandbox args, private profile) and the CLI attaches with --cdp so
 * we never pick up the desktop wrapper on port 9222.
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { discoverChrome } from '../chrome.mjs';
import { discoverDrivers } from '../discover.mjs';
import { DEFAULT_VIEWPORT, resolveAppUrl } from '../env.mjs';
import { launchChromeCdp } from './cdp-chrome.mjs';
import { serializeEvaluate } from './session.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

function resolveAgentBin(explicit) {
  if (explicit) return explicit;
  const local = join(ROOT, 'node_modules/.bin/agent-browser');
  if (existsSync(local)) return local;
  const report = discoverDrivers();
  if (report.drivers['agent-browser'].bin) return report.drivers['agent-browser'].bin;
  throw new Error('agent-browser CLI not found. npm install -D agent-browser');
}

function unwrapJson(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const start = trimmed.indexOf('{') === -1 ? trimmed.indexOf('[') : trimmed.indexOf('{');
  const payload = start >= 0 ? trimmed.slice(start) : trimmed;
  try {
    return JSON.parse(payload);
  } catch {
    return { raw: trimmed };
  }
}

function resultOf(parsed) {
  if (parsed == null) return null;
  if (typeof parsed !== 'object') return parsed;
  if ('data' in parsed) {
    const data = parsed.data;
    if (data && typeof data === 'object' && 'result' in data) return data.result;
    if (data && typeof data === 'object' && 'value' in data) return data.value;
    return data;
  }
  if ('result' in parsed) return parsed.result;
  if ('value' in parsed) return parsed.value;
  return parsed;
}

function runCli(bin, args, { session, port, timeout = 30_000 } = {}) {
  const full = ['--session', session, '--json', '--cdp', String(port), ...args];
  return new Promise((resolve, reject) => {
    const child = spawn(bin, full, {
      env: { ...process.env, AGENT_BROWSER_SESSION: session },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`agent-browser timed out: ${args.join(' ')}\n${stderr || stdout}`));
    }, timeout);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const parsed = unwrapJson(stdout) ?? unwrapJson(stderr);
      if (code !== 0) {
        const message =
          (parsed && (parsed.error || parsed.message)) ||
          stderr.trim() ||
          stdout.trim() ||
          `exit ${code}`;
        reject(new Error(`agent-browser ${args.join(' ')}: ${message}`));
        return;
      }
      resolve({ parsed, stdout, stderr });
    });
  });
}

function runEval(bin, script, ctx) {
  const encoded = Buffer.from(script, 'utf8').toString('base64');
  return runCli(bin, ['eval', '-b', encoded], ctx);
}

export async function launch(options = {}) {
  const chrome = options.chrome ?? discoverChrome();
  const executablePath = options.executablePath ?? chrome.automation;
  if (!executablePath) {
    throw new Error(
      'No Chrome executable for agent-browser. Set CHROMIUM_PATH to a Chrome/Chromium binary.',
    );
  }

  const bin = resolveAgentBin(options.bin);
  const session = options.session ?? `marks-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const cdp = await launchChromeCdp({
    executablePath,
    headless: options.headless !== false,
  });

  const ctx = { session, port: cdp.port };
  const base = options.base;
  const viewport = options.viewport ?? DEFAULT_VIEWPORT;

  try {
    await runCli(bin, ['open', 'about:blank'], { ...ctx, timeout: 20_000 });
    await runCli(bin, ['set', 'viewport', String(viewport.width), String(viewport.height)], ctx);
  } catch (error) {
    await cdp.close();
    throw error;
  }

  const api = {
    name: 'agent-browser',
    engine: 'agent-browser',
    chromeHint: executablePath,
    bin,
    session,
    async goto(path = '/') {
      const url = resolveAppUrl(path, base);
      await runCli(bin, ['open', url], { ...ctx, timeout: 40_000 });
    },
    async url() {
      const { parsed } = await runCli(bin, ['get', 'url'], ctx);
      const value = resultOf(parsed);
      return typeof value === 'string' ? value : String(value?.url ?? value ?? '');
    },
    async waitForSelector(selector, { timeout = 20_000 } = {}) {
      await runCli(bin, ['wait', selector], { ...ctx, timeout: timeout + 2_000 });
    },
    async click(selector) {
      await runCli(bin, ['click', selector], ctx);
    },
    async rightClick(selector, { x = 24, y = 24 } = {}) {
      const { parsed } = await runEval(
        bin,
        `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) throw new Error(${JSON.stringify(`rightClick: ${selector} not found`)});
          const box = el.getBoundingClientRect();
          return { x: Math.round(box.left + ${Number(x)}), y: Math.round(box.top + ${Number(y)}) };
        })()`,
        ctx,
      );
      const point = resultOf(parsed);
      const px = Number(point?.x);
      const py = Number(point?.y);
      if (!Number.isFinite(px) || !Number.isFinite(py)) {
        throw new Error(`rightClick: could not locate ${selector}: ${JSON.stringify(parsed)}`);
      }
      await runCli(bin, ['mouse', 'move', String(px), String(py)], ctx);
      await runCli(bin, ['mouse', 'down', 'right'], ctx);
      await runCli(bin, ['mouse', 'up', 'right'], ctx);
    },
    async fill(selector, value) {
      await runCli(bin, ['fill', selector, value], ctx);
    },
    async press(key) {
      await runCli(bin, ['press', key], ctx);
    },
    async type(text) {
      await runCli(bin, ['keyboard', 'type', text], ctx);
    },
    async insertText(text) {
      await runCli(bin, ['keyboard', 'inserttext', text], ctx);
    },
    async evaluate(fn, arg) {
      const script = serializeEvaluate(fn, arg);
      const { parsed } = await runEval(bin, script, ctx);
      return resultOf(parsed);
    },
    async textContent(selector) {
      const { parsed } = await runEval(
        bin,
        `(() => document.querySelector(${JSON.stringify(selector)})?.innerText ?? '')()`,
        ctx,
      );
      return resultOf(parsed);
    },
    async count(selector) {
      const { parsed } = await runEval(
        bin,
        `(() => document.querySelectorAll(${JSON.stringify(selector)}).length)()`,
        ctx,
      );
      return Number(resultOf(parsed) ?? 0);
    },
    async isVisible(selector) {
      const { parsed } = await runEval(
        bin,
        `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return false;
          const style = getComputedStyle(el);
          return style.display !== 'none' && style.visibility !== 'hidden' && el.getClientRects().length > 0;
        })()`,
        ctx,
      );
      return Boolean(resultOf(parsed));
    },
    async isChecked(selector) {
      const { parsed } = await runEval(
        bin,
        `(() => Boolean(document.querySelector(${JSON.stringify(selector)})?.checked))()`,
        ctx,
      );
      return Boolean(resultOf(parsed));
    },
    async wait(ms) {
      await runCli(bin, ['wait', String(ms)], ctx);
    },
    async setOffline(offline) {
      await runCli(bin, ['set', 'offline', offline ? 'on' : 'off'], ctx);
    },
    async screenshot(path, { fullPage = true } = {}) {
      const args = fullPage ? ['screenshot', '--full', path] : ['screenshot', path];
      await runCli(bin, args, { ...ctx, timeout: 20_000 });
      return path;
    },
    async close() {
      try {
        await runCli(bin, ['close'], { ...ctx, timeout: 10_000 });
      } catch {
        // browser may already be gone
      }
      await cdp.close();
    },
  };

  return api;
}
