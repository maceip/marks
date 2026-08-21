import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { discoverChrome, isCloudDesktopWrapper } from './chrome.mjs';

const WRAPPER = `#!/bin/bash
exec /usr/bin/google-chrome-stable --no-sandbox --remote-debugging-port=9222 --user-data-dir=/home/ubuntu/.config/google-chrome "$@"
`;

describe('isCloudDesktopWrapper', () => {
  it('flags the shared-profile desktop wrapper', () => {
    assert.equal(
      isCloudDesktopWrapper('/usr/local/bin/google-chrome', () => WRAPPER),
      true,
    );
  });

  it('does not flag a real binary', () => {
    assert.equal(isCloudDesktopWrapper('/opt/google/chrome/chrome', () => '\u007fELF'), false);
  });
});

describe('discoverChrome', () => {
  it('prefers the raw Chrome binary over the cloud desktop wrapper', () => {
    const report = discoverChrome({
      env: {},
      exists: (path) =>
        path === '/opt/google/chrome/chrome' || path === '/usr/local/bin/google-chrome',
      readFile: (path) => (path.includes('local') ? WRAPPER : '\u007fELF'),
      playwrightPath: '/home/ubuntu/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',
    });
    assert.equal(report.automation, '/opt/google/chrome/chrome');
    assert.equal(report.reason, 'system chrome');
    assert.deepEqual(report.skippedWrappers, ['/usr/local/bin/google-chrome']);
    assert.equal(
      report.playwright,
      '/home/ubuntu/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',
    );
  });

  it('honors CHROMIUM_PATH over discovery', () => {
    const report = discoverChrome({
      env: { CHROMIUM_PATH: '/custom/chrome' },
      exists: () => false,
      readFile: () => '\u007fELF',
      playwrightPath: '/bundled/chrome',
    });
    assert.equal(report.automation, '/custom/chrome');
    assert.equal(report.overrideKey, 'CHROMIUM_PATH');
    assert.equal(report.reason, 'override CHROMIUM_PATH');
  });

  it('falls back to Playwright Chromium when no system Chrome exists', () => {
    const report = discoverChrome({
      env: {},
      exists: () => false,
      readFile: () => '\u007fELF',
      playwrightPath: '/bundled/chrome',
    });
    assert.equal(report.automation, '/bundled/chrome');
    assert.equal(report.reason, 'playwright bundled chromium');
  });
});
