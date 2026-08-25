import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAnalysisDeadline } from './analysis-deadline.ts';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('document analysis cannot remain pending forever', async () => {
  let expirations = 0;
  const deadline = createAnalysisDeadline(() => { expirations += 1; }, 5);
  deadline.arm();
  await delay(15);
  assert.equal(expirations, 1);
});

test('rearming replaces the old analysis deadline and clearing cancels it', async () => {
  let expirations = 0;
  const deadline = createAnalysisDeadline(() => { expirations += 1; }, 15);
  deadline.arm();
  await delay(8);
  deadline.arm();
  await delay(8);
  assert.equal(expirations, 0);
  deadline.clear();
  await delay(20);
  assert.equal(expirations, 0);
});
