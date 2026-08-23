import assert from 'node:assert/strict';
import test from 'node:test';
import { extractDocumentSection } from './cross-document.ts';
import { createMarkdownIt } from './md.ts';

test('cross-document section extraction includes descendants and stops at a peer heading', () => {
  const source = '# Intro\n\n```md\n## Evidence\n```\n\nstart\n\n## Evidence\n\nproof\n\n### Detail\n\nmore\n\n```md\n## Not a peer\n```\n\n## Next\n\nstop\n';
  assert.equal(
    extractDocumentSection(source, 'evidence'),
    '## Evidence\n\nproof\n\n### Detail\n\nmore\n\n```md\n## Not a peer\n```\n',
  );
  assert.equal(extractDocumentSection(source, 'missing'), null);
  assert.equal(extractDocumentSection(source, ''), source);
});

test('cross-document blocks render inert escaped metadata for main-thread hydration', () => {
  const html = createMarkdownIt().render('![[document_1#Evidence|Shared proof]]');
  assert.match(html, /class="marks-document-block"/);
  assert.match(html, /data-marks-document-block="document_1"/);
  assert.match(html, /data-marks-heading="Evidence"/);
  assert.match(html, /href="\/d\/document_1"/);
  assert.match(html, />Shared proof<\/a>/);
});
