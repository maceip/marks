import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeEntities, htmlLooksRich, htmlToMarkdown } from './html-to-markdown.ts';

test('decodes named and numeric entities', () => {
  assert.equal(decodeEntities('a&amp;b&#39;c&#x2F;d'), "a&b'c/d");
});

test('converts headings, emphasis and links', () => {
  const md = htmlToMarkdown(
    '<h1>Title</h1><p>Hello <strong>world</strong> and <em>friends</em>. <a href="https://example.com">link</a></p>',
  );
  assert.match(md, /^# Title/m);
  assert.match(md, /\*\*world\*\*/);
  assert.match(md, /\*friends\*/);
  assert.match(md, /\[link\]\(https:\/\/example.com\)/);
});

test('converts lists and code', () => {
  const md = htmlToMarkdown(
    '<ul><li>one</li><li>two</li></ul><pre><code class="language-ts">const x = 1;</code></pre>',
  );
  assert.match(md, /^- one/m);
  assert.match(md, /^- two/m);
  assert.match(md, /```ts\nconst x = 1;/);
});

test('strips scripts and comments', () => {
  const md = htmlToMarkdown('<p>ok</p><script>alert(1)</script><!-- secret --><p>done</p>');
  assert.equal(md.includes('alert'), false);
  assert.equal(md.includes('secret'), false);
  assert.match(md, /ok/);
  assert.match(md, /done/);
});

test('plain wrapped copy is not treated as rich', () => {
  assert.equal(htmlLooksRich('<div>hello world</div>', 'hello world'), false);
  assert.equal(htmlLooksRich('<p>Hello <strong>there</strong></p>', 'Hello there'), true);
  assert.equal(htmlLooksRich('<h1>Title</h1>', 'Title'), true);
});
