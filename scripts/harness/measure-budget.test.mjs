import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateBudgets, parseHud, parseMeasureArgs } from '../measure-budget.mjs';

const HUD = `
Performance
Edit → preview painted
55.0 ms
p50
114 ms
p95
200 ms
max
60 samples in this session
Last render pass
Blocks reused
99%
Blocks
1 dirty / 757
DOM ops
3
`;

test('parseHud reads p50/p95 and dirty-block counts from the HUD', () => {
  const hud = parseHud(HUD);
  assert.equal(hud.p50, 55);
  assert.equal(hud.p95, 114);
  assert.equal(hud.max, 200);
  assert.equal(hud.dirty, 1);
  assert.equal(hud.blocks, 757);
  assert.equal(hud.domOps, 3);
});

test('evaluateBudgets fails a reading that exceeds its cap', () => {
  const result = evaluateBudgets(
    { firstRenderMs: 12_000, p50: 55, p95: 114, dirty: 1, domOps: 3 },
    { budgetFirstMs: 45_000, budgetP50: 40, budgetP95: 900, budgetDirty: 2, budgetDom: 8 },
  );
  assert.equal(result.ok, false);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].name, 'p50-ms');
});

test('evaluateBudgets fails when a budgeted reading is missing', () => {
  const result = evaluateBudgets({ p50: null }, { budgetP50: 400 });
  assert.equal(result.ok, false);
  assert.equal(result.failures[0].reason, 'missing reading');
});

test('evaluateBudgets passes when every set budget holds', () => {
  const result = evaluateBudgets(
    { firstRenderMs: 8_000, p50: 55, p95: 114, dirty: 1, domOps: 3 },
    { budgetFirstMs: 20_000, budgetP50: 150, budgetP95: 300, budgetDirty: 2, budgetDom: 8 },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.failures, []);
});

test('parseMeasureArgs keeps positional sections and reads budget flags', () => {
  const args = parseMeasureArgs(['400', '--budget-p50', '250', '--url', 'http://127.0.0.1:3000'], {});
  assert.equal(args.sections, 400);
  assert.equal(args.budgetP50, 250);
  assert.equal(args.url, 'http://127.0.0.1:3000');
  assert.equal(args.help, false);
});

test('parseMeasureArgs reads budget env vars', () => {
  const args = parseMeasureArgs([], { MARKS_MEASURE_BUDGET_P95: '800' });
  assert.equal(args.budgetP95, 800);
});
