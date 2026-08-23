import assert from 'node:assert/strict';
import test from 'node:test';
import { assignKeyTips } from './keytips.ts';
import { solveRibbonLayout } from './layout.ts';
import type { ProjectedCommandGroup } from './types.ts';

function group(id: string, priority: number, count = 2): ProjectedCommandGroup {
  return {
    id,
    label: id,
    priority,
    contextual: false,
    agentRaised: false,
    commands: Array.from({ length: count }, (_, index) => ({
      id: `${id}.${index}`,
      label: `${id} ${index}`,
      description: '',
      category: 'Edit',
      tab: 'home',
      group: id,
      glyph: 'bold',
      operation: { kind: 'editor', operation: 'bold' },
      surfaces: ['ribbon'],
      risk: 'write',
      priority,
      enabled: true,
    })),
  };
}

test('layout collapses lower-priority groups while preserving a usable group', () => {
  const groups = [group('primary', 100, 3), group('middle', 60, 3), group('low', 20, 3)];
  const compact = solveRibbonLayout(groups, 360);
  const roomy = solveRibbonLayout(groups, 900);
  assert.deepEqual(compact.visible, ['primary']);
  assert.deepEqual(compact.collapsed, ['middle', 'low']);
  assert.equal(roomy.collapsed.length, 0);
});

test('layout has width hysteresis but recomputes when command content changes', () => {
  const initial = solveRibbonLayout([group('a', 10), group('b', 9)], 400);
  const nearby = solveRibbonLayout([group('a', 10), group('b', 9)], 410, initial);
  const changed = solveRibbonLayout([group('a', 10), group('b', 9, 5)], 410, initial);
  assert.deepEqual(nearby.visible, initial.visible);
  assert.notEqual(changed.signature, initial.signature);
});

test('key tips remain unique when preferred letters collide', () => {
  const tips = assignKeyTips([
    { id: 'a', label: 'Bold', preferred: 'B' },
    { id: 'b', label: 'Bundle', preferred: 'B' },
    { id: 'c', label: 'Break', preferred: 'B' },
  ]);
  assert.equal(new Set(tips.values()).size, 3);
  assert.equal(tips.get('a'), 'B');
});
