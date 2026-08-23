import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { composeLocally } from './ai-compose.ts';

const SOURCE = `# Brief

An opening sentence about speed.

## Proof

A second section with a decision buried in it.
`;

describe('composeLocally', () => {
  it('summarizes headings without calling a service', () => {
    const result = composeLocally({ mode: 'summarize', source: SOURCE, title: 'Brief' });
    assert.match(result.markdown, /Summary/);
    assert.match(result.markdown, /Proof/);
    assert.equal(result.replace, false);
  });

  it('builds a numbered outline from headings', () => {
    const result = composeLocally({ mode: 'outline', source: SOURCE });
    assert.match(result.markdown, /1\. Brief/);
    assert.match(result.markdown, /2\. Proof/);
  });

  it('shortens by keeping opening sentences', () => {
    const result = composeLocally({
      mode: 'shorten',
      source: 'First sentence. Second sentence. Third sentence. Fourth sentence.',
    });
    assert.match(result.markdown, /First sentence/);
    assert.doesNotMatch(result.markdown, /Fourth sentence/);
    assert.equal(result.replace, true);
  });

  it('composes a local draft skeleton from a topic', () => {
    const result = composeLocally({ mode: 'compose', source: '', instruction: 'Launch note' });
    assert.match(result.markdown, /# Launch note/);
    assert.match(result.markdown, /Intent/);
  });
});
