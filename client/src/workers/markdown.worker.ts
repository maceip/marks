/// <reference lib="webworker" />
import type { Token } from 'markdown-it';
import { collectHeadings, envSignature, groupTokens, hashString } from '../markdown/blocks';
import { incrementalParseSafe, splitSourceBlocks } from '../markdown/incremental';
import { createMarkdownIt, type MarkdownRendererFeatures } from '../markdown/md';
import type { BlockPatch, Heading, RenderRequest, RenderResponse } from '../markdown/types';

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
let md = createMarkdownIt();
let katexPlugin: MarkdownRendererFeatures['katex'];
let highlighter: MarkdownRendererFeatures['highlightCode'];

const MATH_HINT = /(^|[^\\])\$/m;
const FENCE_LANGUAGE_HINT = /^(?: {0,3})(?:`{3,}|~{3,})\s*([A-Za-z][\w+-]*)/gm;
const HIGHLIGHT_LANGUAGES = new Set([
  'bash', 'sh', 'zsh', 'shell', 'console', 'c', 'cpp', 'csharp', 'css', 'diff',
  'dockerfile', 'go', 'graphql', 'ini', 'toml', 'java', 'javascript', 'js', 'mjs',
  'cjs', 'node', 'json', 'kotlin', 'lua', 'markdown', 'php', 'python', 'py', 'ruby',
  'rust', 'rs', 'scss', 'sql', 'swift', 'typescript', 'ts', 'tsx', 'jsx', 'xml',
  'html', 'svg', 'vue', 'yaml', 'yml',
]);

function requestsSyntaxHighlight(text: string): boolean {
  for (const match of text.matchAll(FENCE_LANGUAGE_HINT)) {
    if (HIGHLIGHT_LANGUAGES.has(match[1].toLowerCase())) return true;
  }
  return false;
}

/** key -> rendered HTML, from the previous pass. */
let cache = new Map<string, string>();
/** Keys the main thread currently has in its DOM. */
let present = new Set<string>();
let lastEnvSignature = '';
let lastText = '';
let lastEnv: Record<string, unknown> = {};
let lastHeadings: Heading[] = [];

function clearRenderCache(): void {
  cache = new Map();
  present = new Set();
  lastEnvSignature = '';
  lastText = '';
  lastEnv = {};
  lastHeadings = [];
}

async function loadRequestedFeatures(text: string): Promise<void> {
  let changed = false;

  if (!highlighter && requestsSyntaxHighlight(text)) {
    const module = await import('../markdown/highlight');
    highlighter = module.highlightCode;
    changed = true;
  }

  if (!katexPlugin && MATH_HINT.test(text)) {
    const module = await import('@vscode/markdown-it-katex');
    katexPlugin = module.default as MarkdownRendererFeatures['katex'];
    changed = true;
  }

  if (!changed) return;
  md = createMarkdownIt({ katex: katexPlugin, highlightCode: highlighter });
  clearRenderCache();
}

async function render(seq: number, text: string): Promise<RenderResponse> {
  await loadRequestedFeatures(text);

  const incremental = lastText.length > 0 ? incrementalParseSafe(lastText, text) : null;
  if (incremental?.safe) {
    return renderIncremental(seq, text, incremental.dirty.map((block) => block.key));
  }

  const parseStart = performance.now();
  const env: Record<string, unknown> = {};
  const tokens = md.parse(text, env) as Token[];
  const parseMs = performance.now() - parseStart;

  const signature = envSignature(env, tokens);
  if (signature !== lastEnvSignature) {
    // A reference, abbreviation, footnote, or globally allocated heading slug
    // changed: block rendering is no longer independent of the document.
    cache = new Map();
    present = new Set();
    lastEnvSignature = signature;
  }

  lastText = text;
  lastEnv = env;
  lastHeadings = collectHeadings(tokens);

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
    headings: lastHeadings,
    stats: {
      blocks: blocks.length,
      dirty,
      parseMs,
      parseMode: 'full',
      renderMs,
      bytes,
      chars: text.length,
    },
  };
}

function renderIncremental(seq: number, text: string, dirtyKeys: string[]): RenderResponse {
  const dirtySet = new Set(dirtyKeys);
  const parseStart = performance.now();
  const sourceBlocks = splitSourceBlocks(text);
  const parsedDirty = new Map<string, Token[]>();
  for (const block of sourceBlocks) {
    if (!dirtySet.has(block.key) && cache.has(block.key)) continue;
    parsedDirty.set(block.key, md.parse(block.source, lastEnv) as Token[]);
  }
  const parseMs = performance.now() - parseStart;

  const renderStart = performance.now();
  const nextCache = new Map<string, string>();
  const blocks: BlockPatch[] = [];
  let dirty = 0;
  let bytes = 0;

  for (const block of sourceBlocks) {
    let html = !dirtySet.has(block.key) ? cache.get(block.key) : undefined;
    if (html === undefined) {
      const tokens = parsedDirty.get(block.key) ?? (md.parse(block.source, lastEnv) as Token[]);
      html = md.renderer.render(tokens, md.options, lastEnv);
      dirty += 1;
    }
    nextCache.set(block.key, html);
    const patch: BlockPatch = { key: block.key, line: block.start };
    if (!present.has(block.key) || dirtySet.has(block.key)) {
      patch.html = html;
      bytes += html.length;
    }
    blocks.push(patch);
  }

  const renderMs = performance.now() - renderStart;
  cache = nextCache;
  present = new Set(blocks.map((block) => block.key));
  lastText = text;
  lastHeadings = remapHeadingLines(text, lastHeadings);

  return {
    type: 'rendered',
    seq,
    blocks,
    headings: lastHeadings,
    stats: {
      blocks: blocks.length,
      dirty,
      parseMs,
      parseMode: 'incremental',
      renderMs,
      bytes,
      chars: text.length,
    },
  };
}

function remapHeadingLines(text: string, headings: Heading[]): Heading[] {
  const headingBlocks = splitSourceBlocks(text).filter((block) => /^#{1,6}\s+\S/m.test(block.source));
  return headings.map((heading, index) => ({
    ...heading,
    line: headingBlocks[index]?.start ?? heading.line,
  }));
}

self.onmessage = async (event: MessageEvent<RenderRequest>) => {
  const message = event.data;

  if (message.type === 'reset') {
    clearRenderCache();
    return;
  }

  if (message.type === 'render') {
    try {
      (self as unknown as Worker).postMessage(await render(message.seq, message.text));
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
