import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  PAIRING_STEPS,
  ROLE_COPY,
  RETURN_VISIT_STEPS,
  SCRATCH_HONEST_LINE,
  SCRATCH_UPGRADE_LINE,
  SHARE_GRANT_LINE,
} from './identity-copy.ts';

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

  it('describes pairing and return visit without inventing a second account type', () => {
    assert.equal(PAIRING_STEPS.length, 4);
    assert.equal(RETURN_VISIT_STEPS.length, 3);
    assert.match(SHARE_GRANT_LINE, /live session/);
    assert.doesNotMatch(PAIRING_STEPS.map((step) => step.detail).join(' '), /password|passkey|oauth/i);
  });
});
