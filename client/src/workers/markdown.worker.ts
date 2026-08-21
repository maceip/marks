/// <reference lib="webworker" />
import type { Token } from 'markdown-it';
import { collectHeadings, envSignature, groupTokens, hashString } from '../markdown/blocks';
import { createMarkdownIt } from '../markdown/md';
import type { BlockPatch, RenderRequest, RenderResponse } from '../markdown/types';

/**
 * Markdown rendering, off the main thread.
 *
 * The expensive part of a preview is not parsing — it is running the renderer,
 * KaTeX and highlight.js over the whole document, then handing the browser a
 * new DOM tree to lay out. This worker parses everything (so link references
 * and footnotes stay correct) but renders only the blocks whose source
 * actually changed, and ships HTML only for blocks the main thread does not
 * already hold.
 */
const md = createMarkdownIt();

/** key -> rendered HTML, from the previous pass. */
let cache = new Map<string, string>();
/** Keys the main thread currently has in its DOM. */
let present = new Set<string>();
let lastEnvSignature = '';

function render(seq: number, text: string): RenderResponse {
  const parseStart = performance.now();
  const env: Record<string, unknown> = {};
  const tokens = md.parse(text, env) as Token[];
  const parseMs = performance.now() - parseStart;

  const signature = envSignature(env);
  if (signature !== lastEnvSignature) {
    // A reference, abbreviation or footnote definition moved: block rendering
    // is no longer independent of the rest of the document.
    cache = new Map();
    present = new Set();
    lastEnvSignature = signature;
  }

  const lines = text.split('\n');
  const groups = groupTokens(tokens, lines);

  const renderStart = performance.now();
  const nextCache = new Map<string, string>();
  const blocks: BlockPatch[] = [];
  const seen = new Map<string, number>();
  let dirty = 0;
  let bytes = 0;

  for (const group of groups) {
    if (group.tokens.length === 0) continue;

    // Generated blocks (footnote lists) have no source; render them every pass.
    const identity = group.source ?? `@${group.tokens.map((token) => token.type).join(',')}`;
    const base = hashString(identity);
    const occurrence = (seen.get(base) ?? 0) + 1;
    seen.set(base, occurrence);
    const key = occurrence === 1 ? base : `${base}~${occurrence}`;

    let html = cache.get(key);
    if (html === undefined || group.source === null) {
      html = md.renderer.render(group.tokens, md.options, env);
      dirty += 1;
    }
    nextCache.set(key, html);

    const patch: BlockPatch = { key, line: Math.max(group.line, 0) };
    // Generated blocks — the footnote list — keep the same key while their
    // contents change, since the key can only be derived from the token types.
    // They are re-rendered every pass, so they must also be re-sent.
    if (!present.has(key) || group.source === null) {
      patch.html = html;
      bytes += html.length;
    }
    blocks.push(patch);
  }

  const renderMs = performance.now() - renderStart;

  cache = nextCache;
  present = new Set(blocks.map((block) => block.key));

  return {
    type: 'rendered',
    seq,
    blocks,
    headings: collectHeadings(tokens),
    stats: {
      blocks: blocks.length,
      dirty,
      parseMs,
      renderMs,
      bytes,
      chars: text.length,
    },
  };
}

self.onmessage = (event: MessageEvent<RenderRequest>) => {
  const message = event.data;

  if (message.type === 'reset') {
    cache = new Map();
    present = new Set();
    lastEnvSignature = '';
    return;
  }

  if (message.type === 'render') {
    try {
      (self as unknown as Worker).postMessage(render(message.seq, message.text));
    } catch (error) {
      console.error('[marks] markdown render failed', error);
      const response: RenderResponse = {
        type: 'rendered',
        seq: message.seq,
        blocks: [
          {
            key: `error-${message.seq}`,
            line: 0,
            html: `<div class="marks-callout marks-callout-danger"><p>Preview failed to render.</p></div>`,
          },
        ],
        headings: [],
        stats: { blocks: 1, dirty: 1, parseMs: 0, renderMs: 0, bytes: 0, chars: message.text.length },
      };
      (self as unknown as Worker).postMessage(response);
    }
  }
};
