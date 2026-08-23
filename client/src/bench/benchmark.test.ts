import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeSamples } from './statistics.ts';
import { generateTrace } from './trace.ts';

test('benchmark trace is deterministic and every operation is valid in sequence', () => {
  const first = generateTrace(100_000, 20260821);
  const second = generateTrace(100_000, 20260821);
  assert.deepEqual(first, second);

  let length = 0;
  for (const operation of first) {
    assert.ok(operation.position >= 0 && operation.position <= length);
    if (operation.insert !== undefined) length += operation.insert.length;
    else {
      assert.ok(operation.remove && operation.position + operation.remove <= length);
      length -= operation.remove!;
    }
  }
  assert.ok(length > 0);
});

test('receipt summary preserves raw order and applies the declared median/p95 policy', () => {
  assert.deepEqual(summarizeSamples([5, 1, 3, 2, 4]), {
    median: 3,
    p95: 5,
    min: 1,
    max: 5,
    samples: [5, 1, 3, 2, 4],
  });
  assert.equal(summarizeSamples([4, 1, 2, 3]).median, 2.5);
  assert.throws(() => summarizeSamples([]));
  assert.throws(() => summarizeSamples([1, Number.NaN]));
});
