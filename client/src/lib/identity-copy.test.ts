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
    assert.match(SCRATCH_UPGRADE_LINE, /saved and public/i);
    assert.match(SCRATCH_HONEST_LINE, /anyone with this page URL/i);
    assert.match(SCRATCH_HONEST_LINE, /log in before closing/i);
  });

  it('describes pairing and return visit without inventing a second account type', () => {
    assert.equal(PAIRING_STEPS.length, 3);
    assert.equal(RETURN_VISIT_STEPS.length, 3);
    assert.match(SHARE_GRANT_LINE, /Marks account/);
    assert.doesNotMatch(PAIRING_STEPS.map((step) => step.detail).join(' '), /password|passkey|oauth/i);
  });

  it('leads an unauthenticated phone to a laptop without advertising phone-only registration', () => {
    assert.match(SELF_KEEP_PHONE_LINE, /laptop/i);
    assert.match(SELF_KEEP_PHONE_LINE, /scan the QR code/i);
    assert.doesNotMatch(SELF_KEEP_PHONE_LINE, /fallback|phone-only|only this phone/i);
    assert.match(SELF_KEEP_HONEST_LINE, /account access/i);
    assert.match(SELF_KEEP_HONEST_LINE, /public pages remain/i);
    assert.match(SELF_KEEP_OTHER_DEVICE_LINE, /open this public page/i);
    assert.doesNotMatch(
      [SELF_KEEP_PHONE_LINE, SELF_KEEP_HONEST_LINE, SELF_KEEP_OTHER_DEVICE_LINE].join(' '),
      /password|passkey|oauth|email/i,
    );
  });
});
