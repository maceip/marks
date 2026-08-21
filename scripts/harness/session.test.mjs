import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeKey } from './drivers/session.mjs';

describe('normalizeKey', () => {
  it('keeps Playwright-style Control+A', () => {
    assert.equal(normalizeKey('Control+A'), 'Control+A');
  });

  it('lowercases the letter for Puppeteer', () => {
    assert.equal(normalizeKey('Control+A', { lowerModifiers: true }), 'Control+a');
    assert.equal(normalizeKey('Escape', { lowerModifiers: true }), 'Escape');
  });
});
