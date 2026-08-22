/**
 * Find a running marks server or start one for harness tests.
 * Never kills an existing listener.
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

export async function ping(url, timeoutMs = 2_000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/api/health`, { signal: ctrl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

export async function ensureServer({
  env = process.env,
  extraPorts = [3010, 3020],
} = {}) {
  const candidates = unique([
    env.MARKS_URL,
    `http://127.0.0.1:${env.PORT ?? 3000}`,
    ...extraPorts.map((port) => `http://127.0.0.1:${port}`),
  ]);

  for (const url of candidates) {
    if (await ping(url)) return { url, started: null };
  }

  const port = String(env.MARKS_HARNESS_PORT ?? 3020);
  const url = `http://127.0.0.1:${port}`;
  const dataDir = env.MARKS_HARNESS_DATA_DIR ?? '/tmp/marks-collab-platforms';
  mkdirSync(dataDir, { recursive: true });

  const child = spawn('npm', ['start'], {
    cwd: ROOT,
    env: {
      ...env,
      HOST: '127.0.0.1',
      PORT: port,
      MARKS_URL: url,
      MARKS_DATA_DIR: dataDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  child.unref();

  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw new Error(`npm start exited ${child.exitCode} before ${url} answered`);
    }
    if (await ping(url)) return { url, started: child };
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for ${url} after starting npm start (pid ${child.pid})`);
}
