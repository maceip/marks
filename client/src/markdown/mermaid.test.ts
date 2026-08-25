import assert from 'node:assert/strict';
import test from 'node:test';
import { validateMermaidSource } from './mermaid.ts';

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
});
