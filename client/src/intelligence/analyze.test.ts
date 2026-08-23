import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeDocument, applySourceFix } from './analyze.ts';
import { inspectFrontMatter, updateFrontMatter } from './frontmatter.ts';
import {
  crossDocumentBlock,
  extractHeadingSection,
  insertCitationFootnote,
  lineDiff,
  moveHeadingSection,
  normalizeDoi,
  pasteWithIntent,
  renameHeading,
  shiftHeadingDepth,
} from './operations.ts';

const FIXTURE = `---
# keep this comment
title: Working note
unknown:
  durable: true
marks:
  quality:
    readingGrade: 7
    maxSentenceWords: 12
---
# Working note

## Jump

![ ](https://images.example.test/proof.png)

[click here](#missing%ZZ) and [plain](http://example.test).

A reference[^missing] and [@paper].

- [ ] Ship it @sam due:soon
**Decision:** Keep the source portable.

api_key = "abcdefghijk12345"

![[document_other#Evidence|Shared evidence]]
`;

test('document intelligence returns exact source-backed findings and ledgers', () => {
  const report = analyzeDocument(FIXTURE, 41);
  assert.equal(report.revision, 41);
  assert.equal(report.stats.headings, 2);
  assert.equal(report.stats.images, 1);
  assert.equal(report.stats.tasks, 1);
  assert.equal(report.stats.decisions, 1);
  assert.equal(report.stats.blockReferences, 1);
  assert.equal(report.tasks[0]?.owner, 'sam');
  assert.equal(report.tasks[0]?.due, 'soon');
  assert.equal(report.blockReferences[0]?.documentId, 'document_other');

  const expectedCodes = [
    'image.alt-missing',
    'link.anchor-missing',
    'link.http',
    'link.label-generic',
    'citation.undefined',
    'task.due-invalid',
    'privacy.secret',
  ];
  for (const code of expectedCodes) {
    const finding = report.findings.find((item) => item.code === code);
    assert.ok(finding, `missing ${code}`);
    if (finding.range) {
      assert.ok(finding.range.from >= 0 && finding.range.to <= FIXTURE.length);
      assert.ok(FIXTURE.slice(finding.range.from, finding.range.to).length > 0);
    }
  }
});

test('front matter round-trips comments and unknown fields', () => {
  const updated = updateFrontMatter(FIXTURE, {
    audience: 'First-time operators',
    publishProfile: 'readme',
    privacyMode: 'strict',
    tags: ['ribbon', 'proof'],
  });
  assert.match(updated, /# keep this comment/);
  assert.match(updated, /unknown:\n  durable: true/);
  const inspected = inspectFrontMatter(updated);
  assert.equal(inspected.valid, true);
  assert.equal(inspected.known.audience, 'First-time operators');
  assert.equal(inspected.known.publishProfile, 'readme');
  assert.equal(inspected.known.privacyMode, 'strict');
  assert.deepEqual(inspected.known.tags, ['ribbon', 'proof']);
});

test('front matter refuses to rewrite malformed YAML', () => {
  const broken = '---\ntitle: [not closed\n---\n# Body\n';
  assert.equal(inspectFrontMatter(broken).valid, false);
  assert.throws(() => updateFrontMatter(broken, { title: 'Nope' }), /Fix front matter first/i);
  const unclosed = '---\ntitle: Valid YAML without a terminator\n';
  assert.equal(inspectFrontMatter(unclosed).valid, false);
  assert.throws(() => updateFrontMatter(unclosed, { title: 'Nope' }), /Close the front matter/i);
});

test('suggested fixes reject a stale source revision', () => {
  const report = analyzeDocument('![ ](proof.png)\n');
  const fix = report.findings.find((item) => item.code === 'image.alt-missing')?.fix;
  assert.ok(fix);
  assert.match(applySourceFix('![ ](proof.png)\n', fix), /Describe this image/);
  assert.throws(() => applySourceFix('prefix ![ ](proof.png)\n', fix), /document changed/i);
});

test('malformed percent encoding in an anchor is reported instead of crashing analysis', () => {
  const report = analyzeDocument('# Target\n\n[bad](#target%ZZ)\n');
  assert.equal(report.links[0]?.status, 'broken');
  assert.ok(report.findings.some((item) => item.code === 'link.anchor-missing'));
});

test('structure operations carry complete child sections and fail closed on stale headings', () => {
  const source = '# One\n\nintro\n\n## Child\n\nchild\n\n# Two\n\ntwo\n';
  const report = analyzeDocument(source);
  const one = report.headings[0];
  const two = report.headings[2];
  assert.ok(one && two);
  assert.match(renameHeading(source, one, 'First'), /^# First/m);
  assert.match(shiftHeadingDepth(source, one, 'demote'), /^## One/m);
  assert.ok(moveHeadingSection(source, report.headings, two, 'up').startsWith('# Two'));
  const extracted = extractHeadingSection(source, one, 'document_child', 'One');
  assert.match(extracted.source, /## Child/);
  assert.match(extracted.remaining, /^!\[\[document_child\|One\]\]/);
  assert.throws(() => renameHeading(`prefix\n${source}`, one, 'Stale'), /heading changed/i);
});

test('citation, paste, block, and bounded diff helpers emit portable Markdown', () => {
  assert.equal(normalizeDoi('https://doi.org/10.1234/Proof.'), '10.1234/Proof');
  assert.equal(normalizeDoi('https://example.test/nope'), null);
  assert.match(insertCitationFootnote('Claim', 0, 5, 'Ada. Proof.'), /Claim\[\^source-1\][\s\S]*\[\^source-1\]: Ada\. Proof\./);
  assert.equal(crossDocumentBlock('doc_1', 'Evidence', 'Shared'), '![[doc_1#Evidence|Shared]]');
  assert.match(pasteWithIntent('one\ntwo', 'quote', 'https://source.test'), /^> one\n> two\n<!-- marks:source/);
  assert.match(pasteWithIntent('```', 'code'), /^````\n```\n````$/);
  assert.deepEqual(lineDiff('a\nb', 'a\nc').map((chunk) => chunk.kind), ['equal', 'removed', 'added']);
});
