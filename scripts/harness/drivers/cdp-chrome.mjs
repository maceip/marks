/**
 * Launch system Chrome with a private profile and an ephemeral CDP port.
 *
 * agent-browser is a CLI, not a Node library. In this environment the
 * desktop Chrome wrapper pins port 9222 and a shared profile, so the
 * harness starts a dedicated Chrome and points agent-browser at --cdp.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHROME_LAUNCH_ARGS, launchEnv } from '../env.mjs';

export async function launchChromeCdp({
  executablePath,
  headless = true,
  extraArgs = [],
} = {}) {
  if (!executablePath) {
    throw new Error('launchChromeCdp requires executablePath');
  }

  const userDataDir = mkdtempSync(join(tmpdir(), 'marks-chrome-'));
  const args = [
    ...CHROME_LAUNCH_ARGS,
    `--user-data-dir=${userDataDir}`,
    '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1',
    ...(headless ? ['--headless=new'] : []),
    ...extraArgs,
    'about:blank',
  ];

  const child = spawn(executablePath, args, {
    env: launchEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let settled = false;
  const port = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error(`Chrome did not publish a DevTools port: ${executablePath}`));
      }
    }, 20_000);

    const onData = (chunk) => {
      const text = chunk.toString();
      const match = text.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match && !settled) {
        try {
          const port = Number(new URL(match[1]).port);
          if (!port) return;
          settled = true;
          clearTimeout(timeout);
          resolve(port);
        } catch {
          // keep waiting
        }
      }
    };

    child.stderr.on('data', onData);
    child.stdout.on('data', onData);
    child.once('error', (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(error);
      }
    });
    child.once('exit', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error(`Chrome exited before DevTools came up (code ${code})`));
      }
    });
  });

  return {
    child,
    port,
    userDataDir,
    async close() {
      if (!child.killed) {
        child.kill('SIGTERM');
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 2000);
          child.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        });
        if (!child.killed && child.exitCode == null) child.kill('SIGKILL');
      }
      try {
        rmSync(userDataDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    },
  };
}
