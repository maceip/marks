import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ROLE_COPY, SCRATCH_HONEST_LINE, SCRATCH_UPGRADE_LINE } from './identity-copy.ts';

describe('identity copy', () => {
  it('names the four document roles without inventing account types', () => {
    assert.equal(ROLE_COPY.owner.label, 'Owner');
    assert.equal(ROLE_COPY.editor.label, 'Can edit');
    assert.equal(ROLE_COPY.commenter.label, 'Can comment');
    assert.equal(ROLE_COPY.viewer.label, 'Can view');
    assert.match(ROLE_COPY.owner.detail, /cannot be granted/i);
  });

  it('tells the truth about an unpromoted tab', () => {
    assert.match(SCRATCH_UPGRADE_LINE, /temporary/i);
    assert.match(SCRATCH_HONEST_LINE, /unrecoverable/i);
    assert.match(SCRATCH_HONEST_LINE, /not a named account/i);
  });
});
