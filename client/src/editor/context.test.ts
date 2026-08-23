import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inspectEditorContext } from './context.ts';

describe('inspectEditorContext', () => {
  it('detects a heading at the caret', () => {
    const doc = '# Title\n\nBody';
    assert.deepEqual(inspectEditorContext(doc, 3), { kind: 'heading', headingLevel: 1 });
  });

  it('detects a markdown image on the current line', () => {
    const doc = 'intro\n![alt text](https://example.com/p.png)\n';
    const context = inspectEditorContext(doc, 12);
    assert.equal(context.kind, 'image');
    assert.equal(context.image?.alt, 'alt text');
    assert.equal(context.image?.html, false);
  });

  it('detects an HTML figure with size and alignment', () => {
    const doc = '<img src="blob:1" alt="shot" class="marks-figure" width="320" data-align="right" />';
    const context = inspectEditorContext(doc, 10);
    assert.equal(context.kind, 'image');
    assert.equal(context.image?.width, 320);
    assert.equal(context.image?.align, 'right');
    assert.equal(context.image?.html, true);
  });

  it('detects a pipe table and counts rows', () => {
    const doc = '| A | B |\n| --- | --- |\n| 1 | 2 |\n\nAfter';
    const context = inspectEditorContext(doc, 20);
    assert.equal(context.kind, 'table');
    assert.equal(context.table?.rows, 2);
    assert.equal(context.table?.cols, 2);
  });

  it('detects an inserted shape figure', () => {
    const doc = `<figure class="marks-shape" data-shape="diamond" data-fill="accent">
<svg viewBox="0 0 160 96" role="img" aria-label="Decision"></svg>
<figcaption>Decision</figcaption>
</figure>`;
    const context = inspectEditorContext(doc, 40);
    assert.equal(context.kind, 'shape');
    assert.equal(context.shape?.shape, 'diamond');
    assert.equal(context.shape?.label, 'Decision');
  });
});
