import assert from 'node:assert/strict';
import test from 'node:test';
import { isMermaidRenderTimeout, validateMermaidSource } from './mermaid.ts';

test('small Mermaid diagrams remain renderable', () => {
  assert.equal(validateMermaidSource('flowchart LR\n  A[Draft] --> B[Share]'), null);
});

test('Mermaid source is bounded before main-thread layout', () => {
  assert.match(validateMermaidSource(`flowchart LR\n${'x'.repeat(4_100)}`) ?? '', /larger/u);
  assert.match(
    validateMermaidSource(Array.from({ length: 81 }, (_, index) => `node${index}`).join('\n')) ?? '',
    /too many lines/u,
  );
  assert.match(validateMermaidSource(`flowchart LR\n${'A --> B '.repeat(161)}`) ?? '', /too many/u);
  const semicolonNodes = `flowchart LR;${Array.from(
    { length: 800 },
    (_, index) => `N${index}`,
  ).join(';')}`;
  assert.ok(new TextEncoder().encode(semicolonNodes).byteLength < 4_096);
  assert.match(validateMermaidSource(semicolonNodes) ?? '', /too complex/u);

  const chartScalars = `xychart-beta\nx-axis [${'1,'.repeat(700)}]\nline [${'1,'.repeat(700)}]`;
  assert.ok(new TextEncoder().encode(chartScalars).byteLength < 4_096);
  assert.match(validateMermaidSource(chartScalars) ?? '', /too complex/u);
});

test('only a hard render deadline trips the page-level Mermaid circuit', () => {
  assert.equal(
    isMermaidRenderTimeout(new DOMException('render expired', 'TimeoutError')),
    true,
  );
  assert.equal(isMermaidRenderTimeout(new Error('invalid syntax')), false);
});
