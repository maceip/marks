import type { Token } from 'markdown-it';

/**
 * cyrb53 — a fast, well-distributed 53-bit string hash.
 *
 * Block identity is a pure function of block source, so an edit inside one
 * paragraph leaves every other block's key untouched and the DOM for those
 * blocks is never rebuilt.
 */
export function hashString(input: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export interface TokenGroup {
  tokens: Token[];
  /** First source line of the group, or -1 when the group has no source map. */
  line: number;
  /** Source text of the group, or null when it is generated (e.g. footnotes). */
  source: string | null;
}

/**
 * Split a token stream into top-level groups.
 *
 * markdown-it emits a flat list with `nesting` markers; a group runs from an
 * opening token at depth 0 until its matching close, so nested lists and
 * blockquotes stay whole.
 */
export function groupTokens(tokens: Token[], lines: string[]): TokenGroup[] {
  const groups: TokenGroup[] = [];
  let index = 0;

  while (index < tokens.length) {
    const start = index;
    if (tokens[index].nesting === 1) {
      let depth = 0;
      do {
        depth += tokens[index].nesting;
        index += 1;
      } while (index < tokens.length && depth > 0);
    } else {
      index += 1;
    }

    const group = tokens.slice(start, index);
    const map = group.find((token) => token.map)?.map ?? null;
    groups.push({
      tokens: group,
      line: map ? map[0] : -1,
      source: map ? lines.slice(map[0], map[1]).join('\n') : null,
    });
  }

  return groups;
}

/**
 * Anything markdown-it resolves document-wide — link reference definitions,
 * footnotes, abbreviations — invalidates the whole cache when it changes,
 * because a block's rendering can depend on a definition far away from it.
 */
export function envSignature(env: Record<string, unknown>): string {
  const references = env.references ? JSON.stringify(env.references) : '';
  const footnotes = env.footnotes as { list?: unknown[] } | undefined;
  const abbreviations = env.abbreviations ? JSON.stringify(env.abbreviations) : '';
  return `${hashString(references)}:${footnotes?.list?.length ?? 0}:${hashString(abbreviations)}`;
}

/**
 * Plain text of an inline token, for use as a label.
 *
 * Reading `token.content` would return the markdown source, markers and all;
 * the parsed children carry the text itself. Nothing is escaped here — this is
 * rendered by React, which does the escaping.
 */
function inlineText(inline: Token): string {
  if (!inline.children?.length) return (inline.content ?? '').trim();

  let text = '';
  for (const child of inline.children) {
    switch (child.type) {
      case 'text':
      case 'code_inline':
      case 'emoji':
      case 'image': // `content` holds the alt text
        text += child.content;
        break;
      case 'softbreak':
      case 'hardbreak':
        text += ' ';
        break;
      default:
        break; // opening and closing markup tokens carry no text
    }
  }

  return text.trim();
}

export function collectHeadings(
  tokens: Token[],
): Array<{ level: number; text: string; slug: string; line: number }> {
  const headings: Array<{ level: number; text: string; slug: string; line: number }> = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type !== 'heading_open') continue;
    const inline = tokens[i + 1];
    if (!inline || inline.type !== 'inline') continue;

    headings.push({
      level: Number(token.tag.slice(1)) || 1,
      text: inlineText(inline),
      slug: String(token.attrGet('id') ?? ''),
      line: token.map ? token.map[0] : 0,
    });
  }

  return headings;
}
