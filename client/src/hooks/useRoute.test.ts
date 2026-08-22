import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ABOUT_DOCUMENT_ID } from '../content/about.ts';
import { parseRoute, routeToPath } from './useRoute.ts';

describe('parseRoute', () => {
  it('opens the about document from the welcome URL', () => {
    assert.deepEqual(parseRoute('/welcome'), { name: 'document', id: ABOUT_DOCUMENT_ID });
    assert.deepEqual(parseRoute('/welcome/'), { name: 'document', id: ABOUT_DOCUMENT_ID });
  });

  it('keeps document and benchmark routes', () => {
    assert.deepEqual(parseRoute('/d/about-marks'), { name: 'document', id: 'about-marks' });
    assert.deepEqual(parseRoute('/bench'), { name: 'benchmark' });
    assert.deepEqual(parseRoute('/'), { name: 'home' });
  });

  it('prints a document path for in-app navigation', () => {
    assert.equal(routeToPath({ name: 'document', id: ABOUT_DOCUMENT_ID }), '/d/about-marks');
  });
});
