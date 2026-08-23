import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  PAIRING_STEPS,
  ROLE_COPY,
  RETURN_VISIT_STEPS,
  SCRATCH_HONEST_LINE,
  SCRATCH_UPGRADE_LINE,
  SELF_KEEP_HONEST_LINE,
  SELF_KEEP_OTHER_DEVICE_LINE,
  SELF_KEEP_PHONE_LINE,
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

  it('tells the phone-only visitor the truth about a single-device keep', () => {
    assert.match(SELF_KEEP_PHONE_LINE, /this phone/i);
    assert.match(SELF_KEEP_HONEST_LINE, /unrecoverable/i);
    assert.match(SELF_KEEP_OTHER_DEVICE_LINE, /never merge/i);
    assert.doesNotMatch(
      [SELF_KEEP_PHONE_LINE, SELF_KEEP_HONEST_LINE, SELF_KEEP_OTHER_DEVICE_LINE].join(' '),
      /password|passkey|oauth|email/i,
    );
  });
});
