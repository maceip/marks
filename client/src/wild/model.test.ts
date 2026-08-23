import assert from 'node:assert/strict';
import test from 'node:test';
import { requireCommand } from '../commands/registry.ts';
import {
  applyCounterfactual,
  createCounterfactual,
  deriveContextSignals,
  minimalSourceDelta,
  predictConsequences,
  reverseCounterfactual,
} from './model.ts';

test('context half-life finds bounded live claims and ignores fenced examples', () => {
  const now = Date.parse('2026-08-23T12:00:00Z');
  const source = [
    '# Release',
    'Currently this uses API v3.2. See https://example.test/spec.',
    '```text',
    'today version v99 due:2020-01-01',
    '```',
    'Review due:2026-08-30.',
  ].join('\n');
  const signals = deriveContextSignals('doc-context', source, now);
  assert.deepEqual(signals.map((signal) => signal.kind).sort(), [
    'deadline',
    'external-dependency',
    'relative-time',
    'version-claim',
  ]);
  const current = signals.find((signal) => signal.expected === 'Currently');
  assert.deepEqual(current?.range, { from: 10, to: 19, line: 2, column: 1 });
  assert.ok(signals.every((signal) => source.slice(signal.range.from, signal.range.to) === signal.expected));
});

test('consequence lanes derive from the registered command contract', () => {
  const formatting = predictConsequences(requireCommand('format.bold'));
  assert.equal(formatting.find((lane) => lane.id === 'source')?.impact, 'change');
  assert.equal(formatting.find((lane) => lane.id === 'collaboration')?.impact, 'boundary');
  const print = predictConsequences(requireCommand('document.print'));
  assert.equal(print.find((lane) => lane.id === 'source')?.impact, 'observe');
  assert.equal(print.find((lane) => lane.id === 'external')?.impact, 'boundary');
});

test('minimal deltas and automatic reversals preserve only the changed span', async () => {
  assert.deepEqual(minimalSourceDelta('alpha old omega', 'alpha new omega'), {
    from: 6,
    beforeChars: 3,
    afterChars: 3,
    beforeLines: 1,
    afterLines: 1,
  });
  const patch = await reverseCounterfactual(
    'doc-reversal',
    'Before replacement',
    'format.bold',
    'command',
    'alpha old omega',
    'alpha new omega',
    100,
  );
  assert.ok(patch);
  assert.equal(patch.expected, 'new');
  assert.equal(patch.replacement, 'old');
  assert.equal(applyCounterfactual('alpha new omega', patch).text, 'alpha old omega');
});

test('counterfactual application reanchors only one unique context and fails closed on ambiguity', async () => {
  const patch = await createCounterfactual(
    'doc-alternative',
    'Use beta',
    'A deliberate alternate word.',
    'prefix alpha suffix',
    7,
    12,
    'beta',
    200,
  );
  const rebased = applyCounterfactual('moved prefix alpha suffix', patch);
  assert.equal(rebased.text, 'moved prefix beta suffix');
  assert.equal(rebased.rebased, true);
  assert.throws(
    () => applyCounterfactual('x prefix alpha suffix / prefix alpha suffix', patch),
    /no unique safe source anchor/u,
  );
});
