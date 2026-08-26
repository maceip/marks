import assert from 'node:assert/strict';
import test from 'node:test';

import { permittedDecision, trustedGate } from '../dependabot-llm-reconcile.mjs';

const inventory = {
  pulls: [{ number: 7, author: 'dependabot[bot]', sameRepository: true, gate: 'completed:success' }],
  issues: [{ number: 9, source_pr: 7, body: 'Replacement is tracked in #12.' }],
};

test('only the latest trusted GitHub Actions CI gate is authoritative', () => {
  const gate = trustedGate([
    { name: 'CI gate', app: { slug: 'untrusted' }, status: 'completed', conclusion: 'success', completed_at: '2026-01-03' },
    { name: 'CI gate', app: { slug: 'github-actions' }, status: 'completed', conclusion: 'failure', completed_at: '2026-01-01' },
    { name: 'CI gate', app: { slug: 'github-actions' }, status: 'completed', conclusion: 'success', completed_at: '2026-01-02' },
  ]);
  assert.equal(gate.conclusion, 'success');
});

test('LLM decisions cannot bypass deterministic merge and issue guards', () => {
  assert.equal(permittedDecision({ number: 7, action: 'merge_pr', confidence: 0.95 }, inventory), true);
  assert.equal(permittedDecision({ number: 7, action: 'merge_pr', confidence: 0.89 }, inventory), false);
  assert.equal(permittedDecision({ number: 8, action: 'merge_pr', confidence: 1 }, inventory), false);
  assert.equal(permittedDecision({ number: 9, action: 'close_issue', replacement_pr: 12, confidence: 0.95 }, inventory), true);
  assert.equal(permittedDecision({ number: 9, action: 'close_issue', replacement_pr: 13, confidence: 1 }, inventory), false);
  assert.equal(permittedDecision({ number: 9, action: 'close_issue', replacement_pr: null, confidence: 1 }, inventory), false);
});
