import assert from 'node:assert/strict';
import test from 'node:test';
import {
  globalDefinitionSignature,
  incrementalParseSafe,
  splitSourceBlocks,
} from './incremental.ts';

test('source blocks retain exact UTF-16 bounds for duplicate and moved blocks', () => {
  const text = 'same\n\n# Heading\n\nsame';
  const blocks = splitSourceBlocks(text);
  assert.deepEqual(blocks.map(({ source, sourceStart, sourceEnd }) => [source, sourceStart, sourceEnd]), [
    ['same', 0, 4], ['# Heading', 6, 15], ['same', 17, 21],
  ]);
  assert.notEqual(blocks[0].key, blocks[2].key);
});

const document = `# Title

First paragraph with some words.

## Section

Second paragraph.

\`\`\`javascript
const ready = true;
\`\`\`

- one
- two
- three
`;

test('splitSourceBlocks keeps fences and lists whole', () => {
  const blocks = splitSourceBlocks(document);
  const sources = blocks.map((block) => block.source);
  assert.ok(sources.some((source) => source.startsWith('# Title')));
  assert.ok(sources.some((source) => source.includes('const ready = true;')));
  assert.ok(sources.some((source) => source.includes('- one') && source.includes('- three')));
});

test('editing one paragraph is an incremental-safe dirty set of one block', () => {
  const next = document.replace('some words', 'changed words');
  const result = incrementalParseSafe(document, next);
  assert.equal(result.safe, true);
  assert.equal(result.dirty.length, 1);
  assert.match(result.dirty[0].source, /changed words/);
});

test('a new link reference forces a full parse', () => {
  const next = `${document}\n[ref]: https://example.com\n`;
  const result = incrementalParseSafe(document, next);
  assert.equal(result.safe, false);
  assert.notEqual(globalDefinitionSignature(document), globalDefinitionSignature(next));
});

test('a colliding heading forces a full parse', () => {
  const next = `${document}\n# Title\n`;
  const result = incrementalParseSafe(document, next);
  assert.equal(result.safe, false);
});
