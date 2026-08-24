import assert from 'node:assert/strict';
import test from 'node:test';
import katex from '@vscode/markdown-it-katex';
import { highlightCode } from './highlight.ts';
import { createMarkdownIt } from './md.ts';

test('plain markdown does not require the rich rendering features', () => {
  const md = createMarkdownIt();
  const html = md.render('# Fast\n\nA **plain** document.');

  assert.match(html, /<h1/);
  assert.match(html, /<strong>plain<\/strong>/);
  assert.doesNotMatch(html, /class="katex"/);
});

test('math rendering is opt-in', () => {
  const plain = createMarkdownIt().render('The value is $x^2$.');
  const rich = createMarkdownIt({ katex }).render('The value is $x^2$.');

  assert.doesNotMatch(plain, /class="katex"/);
  assert.match(rich, /class="katex"/);
});

test('syntax highlighting is opt-in', () => {
  const source = '```javascript\nconst ready = true;\n```';
  const plain = createMarkdownIt().render(source);
  const rich = createMarkdownIt({ highlightCode }).render(source);

  assert.doesNotMatch(plain, /hljs-keyword/);
  assert.match(rich, /hljs-keyword/);
});

test('local asset links defer their blob URL to the main thread', () => {
  const id = 'local-asset-12345678-1234-1234-1234-123456789abc';
  const html = createMarkdownIt().render(`![proof](/__marks_local_asset/${id})`);
  assert.match(html, new RegExp(`data-marks-local-asset="${id}"`));
  assert.doesNotMatch(html, /src="\/__marks_local_asset/);
});
