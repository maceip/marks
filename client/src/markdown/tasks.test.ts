import assert from 'node:assert/strict';
import test from 'node:test';
import { taskMarkerAt } from './tasks.ts';

test('taskMarkerAt resolves the marker from an exact rendered source span', () => {
  const prefix = '# Before\n\n';
  const block = '- [ ] first\n- [x] second\n1. [X] third\n';
  const source = `${prefix}${block}\nAfter`;
  const start = prefix.length;
  const end = start + block.length;

  assert.deepEqual(taskMarkerAt(source, start, end, 0), {
    from: source.indexOf('[ ]') + 1,
    checked: false,
  });
  assert.deepEqual(taskMarkerAt(source, start, end, 1), {
    from: source.indexOf('[x]') + 1,
    checked: true,
  });
  assert.deepEqual(taskMarkerAt(source, start, end, 2), {
    from: source.indexOf('[X]') + 1,
    checked: true,
  });
});

test('taskMarkerAt refuses invalid spans and missing ordinals', () => {
  const source = '- [ ] task\n';
  assert.equal(taskMarkerAt(source, -1, source.length, 0), null);
  assert.equal(taskMarkerAt(source, 0, source.length + 1, 0), null);
  assert.equal(taskMarkerAt(source, 0, source.length, 1), null);
});
