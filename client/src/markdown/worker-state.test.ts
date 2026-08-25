import assert from 'node:assert/strict';
import test from 'node:test';
import { transitionPatch } from './worker-state.ts';

test('a WebKit worker re-evaluation requests a full render before using old offsets', () => {
  const marketing = '# Google Docs for Markdown\n\n' + 'm'.repeat(3_445);
  const fixturePrefix = '# Current WebKit service proof\n\n- [ ] shared service task\n\n';
  const fixture = fixturePrefix + 'f'.repeat(1_172 - fixturePrefix.length);

  // Generation A rendered the marketing starter. A lazy renderer chunk then
  // re-evaluated the worker entry as generation B with empty module state.
  const replacement = transitionPatch('', 'generation-b', {
    type: 'patch',
    seq: 2,
    generation: 'generation-a',
    baseChars: marketing.length,
    chars: fixture.length,
    edits: [{ from: 0, to: marketing.length, insert: fixture }],
  });
  assert.deepEqual(replacement, {
    type: 'resync',
    seq: 2,
    generation: 'generation-b',
    actualChars: 0,
    reason: 'generation',
  });

  // Once the client resends its authoritative text, later incremental edits
  // stay in generation B's coordinate space.
  const append = transitionPatch(fixture, 'generation-b', {
    type: 'patch',
    seq: 4,
    generation: 'generation-b',
    baseChars: fixture.length,
    chars: fixture.length + 1,
    edits: [{ from: fixture.length, to: fixture.length, insert: '0' }],
  });
  assert.deepEqual(append, { type: 'applied', text: `${fixture}0` });
});

test('length and coordinate mismatches fail closed into resynchronization', () => {
  const base = 'same length';
  const baseMismatch = transitionPatch(base, 'g', {
    type: 'patch', seq: 1, generation: 'g', baseChars: 0, chars: 1,
    edits: [{ from: 0, to: 0, insert: 'x' }],
  });
  assert.equal(baseMismatch.type, 'resync');
  if (baseMismatch.type === 'resync') assert.equal(baseMismatch.reason, 'base-length');

  const invalidEdit = transitionPatch(base, 'g', {
    type: 'patch', seq: 2, generation: 'g', baseChars: base.length, chars: base.length,
    edits: [{ from: 99, to: 99, insert: 'x' }],
  });
  assert.equal(invalidEdit.type, 'resync');
  if (invalidEdit.type === 'resync') assert.equal(invalidEdit.reason, 'invalid-edit');

  const resultMismatch = transitionPatch(base, 'g', {
    type: 'patch', seq: 3, generation: 'g', baseChars: base.length, chars: 1,
    edits: [{ from: 0, to: 0, insert: 'x' }],
  });
  assert.equal(resultMismatch.type, 'resync');
  if (resultMismatch.type === 'resync') assert.equal(resultMismatch.reason, 'result-length');
});
