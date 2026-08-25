import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { copyForHttpStatus, ServiceError } from './service-errors.ts';

describe('service error copy', () => {
  it('maps contract statuses without leaking paths or JSON', () => {
    for (const status of [400, 401, 403, 404, 409, 429, 500] as const) {
      const copy = copyForHttpStatus(status);
      assert.doesNotMatch(copy.title, /\/v1|\{|error/i);
      assert.doesNotMatch(copy.detail, /\/v1|\{ "error"/);
    }
    assert.match(copyForHttpStatus(401).detail, /look the same/);
    assert.match(copyForHttpStatus(409).detail, /login request/i);
  });

  it('treats unknown statuses as a generic failure', () => {
    assert.equal(copyForHttpStatus(502).title, copyForHttpStatus(500).title);
    const error = new ServiceError(404);
    assert.equal(error.message, error.copy.title);
    assert.doesNotMatch(error.message, /documents/);
  });
});
