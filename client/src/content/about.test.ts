import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ABOUT_DOCUMENT, ABOUT_DOCUMENT_ID } from './about.ts';

describe('about document', () => {
  it('is a crafted Marks page, not a second website', () => {
    assert.equal(ABOUT_DOCUMENT_ID, 'about-marks');
    assert.match(ABOUT_DOCUMENT, /^# About Marks/m);
    assert.match(ABOUT_DOCUMENT, /The page you are reading is not a brochure/);
  });

  it('explains the product, accounts, and the machinery', () => {
    assert.match(ABOUT_DOCUMENT, /scratch workspace/i);
    assert.match(ABOUT_DOCUMENT, /session cookie/i);
    assert.match(ABOUT_DOCUMENT, /device key/i);
    assert.match(ABOUT_DOCUMENT, /ESBT/);
    assert.match(ABOUT_DOCUMENT, /Web Worker/);
    assert.match(ABOUT_DOCUMENT, /Liquid glass/);
  });
});
