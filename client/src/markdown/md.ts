import MarkdownIt from 'markdown-it';
import type { MarkdownIt as MarkdownItInstance, StateCore, Token } from 'markdown-it';
import abbr from 'markdown-it-abbr';
import anchor from 'markdown-it-anchor';
import container from 'markdown-it-container';
import deflist from 'markdown-it-deflist';
import { full as emoji } from 'markdown-it-emoji';
import footnote from 'markdown-it-footnote';
import ins from 'markdown-it-ins';
import mark from 'markdown-it-mark';
import multimdTable from 'markdown-it-multimd-table';
import sub from 'markdown-it-sub';
import sup from 'markdown-it-sup';

type MarkdownPlugin = Parameters<MarkdownItInstance['use']>[0];

export interface MarkdownRendererFeatures {
  katex?: MarkdownPlugin;
  highlightCode?: (code: string, language: string) => string | null;
}

/** Callout blocks, matching the `:::info` syntax people already type in HackMD. */
const CALLOUTS = ['info', 'success', 'warning', 'danger', 'note'] as const;

/**
 * CJS/ESM interop.
 *
 * Some markdown-it plugins are published as CommonJS with `exports.default`,
 * which surfaces as a nested `{ default }` after bundling rather than the
 * plugin function itself. Normalise before handing anything to `md.use`.
 */
function interop<T>(mod: T): T {
  if (typeof mod === 'function') return mod;
  const nested = (mod as { default?: T }).default;
  return typeof nested === 'function' ? nested : mod;
}

export function slugify(text: string): string {
  return (
    text
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .replace(/\s+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-|-$/g, '') || 'section'
  );
}

/**
 * GitHub-style task lists.
 *
 * The published markdown-it-task-lists plugin builds its checkbox as a raw
 * HTML string and omits a space between two attributes, so the browser drops
 * the `checked` state. Emitting a proper token is both correct and shorter.
 */
function taskLists(md: MarkdownItInstance): void {
  md.core.ruler.after('inline', 'marks-task-lists', (state: StateCore) => {
    const tokens = state.tokens;

    for (let index = 2; index < tokens.length; index++) {
      const inline = tokens[index];
      if (inline.type !== 'inline') continue;
      if (tokens[index - 1].type !== 'paragraph_open') continue;
      if (tokens[index - 2].type !== 'list_item_open') continue;

      const match = /^\[([ xX])\][ \t]+/.exec(inline.content);
      if (!match) continue;

      const checked = match[1] !== ' ';
      inline.content = inline.content.slice(match[0].length);

      const first = inline.children?.[0];
      if (first && first.type === 'text') {
        first.content = first.content.slice(match[0].length);
      }

      const checkbox = new state.Token('html_inline', '', 0);
      checkbox.content = `<input class="task-list-item-checkbox" type="checkbox"${
        checked ? ' checked' : ''
      }> `;
      inline.children?.unshift(checkbox);

      tokens[index - 2].attrJoin('class', 'task-list-item');
    }

    return true;
  });
}

export function createMarkdownIt(features: MarkdownRendererFeatures = {}): MarkdownItInstance {
  const md = new MarkdownIt({
    html: true, // sanitised downstream by DOMPurify
    linkify: true,
    breaks: false,
    typographer: true,
    highlight(code, language) {
      // Diagrams are handed to the main thread, which owns the DOM mermaid needs.
      if (language === 'mermaid') {
        return `<div class="marks-mermaid" data-mermaid="pending"><pre class="marks-mermaid-src" hidden>${escapeHtml(
          code,
        )}</pre><div class="marks-mermaid-out"></div></div>`;
      }
      const highlighted = features.highlightCode?.(code, language) ?? null;
      const body = highlighted ?? escapeHtml(code);
      const languageClass = language ? ` language-${escapeHtml(language)}` : '';
      return `<pre class="marks-code"><code class="hljs${languageClass}">${body}</code></pre>`;
    },
  });

  // markdown-it 14 dropped `utils.assign`; markdown-it-multimd-table still
  // calls it to merge its options. The original was Object.assign semantics.
  const utils = md.utils as typeof md.utils & { assign?: typeof Object.assign };
  utils.assign ??= Object.assign;

  md.use(interop(footnote))
    .use(interop(deflist))
    .use(interop(abbr))
    .use(interop(sub))
    .use(interop(sup))
    .use(interop(mark))
    .use(interop(ins))
    .use(interop(emoji))
    .use(taskLists)
    .use(interop(multimdTable), { multiline: true, rowspan: true, headerless: true });

  if (features.katex) {
    md.use(interop(features.katex), { throwOnError: false, errorColor: 'var(--danger)' });
  }

  md.use(interop(anchor), {
      slugify,
      permalink: anchor.permalink.linkInsideHeader({
        symbol: '#',
        placement: 'after',
        class: 'marks-anchor',
        ariaHidden: true,
      }),
    });

  for (const kind of CALLOUTS) {
    md.use(interop(container), kind, {
      render(tokens: Token[], index: number) {
        const token = tokens[index];
        if (token.nesting !== 1) return '</div>\n';
        const title = token.info.trim().slice(kind.length).trim();
        const heading = title ? `<p class="marks-callout-title">${escapeHtml(title)}</p>` : '';
        return `<div class="marks-callout marks-callout-${kind}">${heading}`;
      },
    });
  }

  // Links to elsewhere open in a new tab; in-document anchors do not.
  const defaultLinkOpen =
    md.renderer.rules.link_open ??
    ((tokens, index, options, _env, self) => self.renderToken(tokens, index, options));
  md.renderer.rules.link_open = (tokens, index, options, env, self) => {
    const href = String(tokens[index].attrGet('href') ?? '');
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith('#')) {
      tokens[index].attrSet('target', '_blank');
      tokens[index].attrSet('rel', 'noopener noreferrer');
    }
    return defaultLinkOpen(tokens, index, options, env, self);
  };

  return md;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
