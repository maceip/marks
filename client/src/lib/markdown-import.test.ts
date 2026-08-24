import assert from 'node:assert/strict';
import test from 'node:test';
import { MARKS_MAX_DOCUMENT_UNITS } from '../collab/profile.ts';
import { readMarkdownImport } from './markdown-import.ts';

test('Markdown import normalizes line endings and derives a bounded title', async () => {
  const imported = await readMarkdownImport({
    name: '  Product brief.md',
    size: 12,
    async text() { return '# One\r\n\rTwo\r'; },
  });
  assert.deepEqual(imported, { title: 'Product brief', content: '# One\n\nTwo\n' });
});

test('Markdown import rejects wrong extensions and decoded unit overflow', async () => {
  await assert.rejects(
    readMarkdownImport({ name: 'notes.txt', size: 1, async text() { return 'x'; } }),
    /\.md/,
  );
  await assert.rejects(
    readMarkdownImport({
      name: 'huge.md',
      size: 1,
      async text() { return 'x'.repeat(MARKS_MAX_DOCUMENT_UNITS + 1); },
    }),
    /decoded Markdown/,
  );
});
