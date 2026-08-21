/**
 * HTML → markdown for paste.
 *
 * This is not a general-purpose converter. It exists so pasting from a
 * browser, Google Docs, or another marks tab becomes readable markdown
 * instead of a soup of `<span style="…">`. Unknown tags are dropped; their
 * text is kept. The output is always plain markdown, never HTML.
 */

const VOID = new Set(['br', 'hr', 'img', 'input']);

const ENTITY: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

export function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (match, name: string) => ENTITY[name.toLowerCase()] ?? match);
}

interface Token {
  type: 'open' | 'close' | 'void' | 'text';
  name: string;
  attrs: Record<string, string>;
  text: string;
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const pattern = /([:@\w-]+)\s*=\s*("([^"]*)"|'([^']*)'|(\S+))/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw))) {
    attrs[match[1].toLowerCase()] = decodeEntities(match[3] ?? match[4] ?? match[5] ?? '');
  }
  return attrs;
}

function tokenize(html: string): Token[] {
  const tokens: Token[] = [];
  const source = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<head[\s\S]*?<\/head>/gi, '');

  const pattern = /<\/?([a-zA-Z][\w:-]*)([^>]*)>|([^<]+)/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(source))) {
    if (match[1]) {
      const name = match[1].toLowerCase();
      const raw = match[2] ?? '';
      const selfClosing = VOID.has(name) || /\/\s*$/.test(raw);
      tokens.push({
        type: selfClosing ? 'void' : raw.trimStart().startsWith('/') || match[0].startsWith('</') ? 'close' : 'open',
        name,
        attrs: parseAttrs(raw),
        text: '',
      });
    } else if (match[3]) {
      tokens.push({ type: 'text', name: '', attrs: {}, text: decodeEntities(match[3]) });
    }
  }

  return tokens;
}

function fenceLanguage(className: string): string {
  const match = /(?:language|lang)-([\w+-]+)/i.exec(className);
  return match?.[1] ?? '';
}

/**
 * Convert an HTML fragment to markdown.
 *
 * Whitespace is collapsed the way a browser would display it, except inside
 * `<pre>` / `<code>` blocks, which keep their source.
 */
export function htmlToMarkdown(html: string): string {
  if (!html) return '';

  const tokens = tokenize(html);
  let out = '';
  let listDepth = 0;
  let listKind: Array<'ul' | 'ol'> = [];
  let olIndex: number[] = [];
  let inPre = 0;
  let inCode = 0;
  let pendingHref: string[] = [];

  const push = (value: string) => {
    out += value;
  };

  const blockBreak = () => {
    if (!out || out.endsWith('\n\n')) return;
    push(out.endsWith('\n') ? '\n' : '\n\n');
  };

  for (const token of tokens) {
    if (token.type === 'text') {
      const text = inPre || inCode ? token.text : token.text.replace(/\s+/g, ' ');
      if (text) push(text);
      continue;
    }

    const { name, attrs } = token;

    if (token.type === 'void') {
      if (name === 'br') push(inPre ? '\n' : '  \n');
      else if (name === 'hr') {
        blockBreak();
        push('---\n\n');
      } else if (name === 'img') {
        const alt = attrs.alt ?? '';
        const src = attrs.src ?? '';
        if (src) push(`![${alt}](${src})`);
      }
      continue;
    }

    if (token.type === 'open') {
      switch (name) {
        case 'h1':
        case 'h2':
        case 'h3':
        case 'h4':
        case 'h5':
        case 'h6':
          blockBreak();
          push(`${'#'.repeat(Number(name[1]))} `);
          break;
        case 'p':
        case 'div':
        case 'section':
        case 'article':
          blockBreak();
          break;
        case 'blockquote':
          blockBreak();
          push('> ');
          break;
        case 'ul':
          blockBreak();
          listDepth += 1;
          listKind.push('ul');
          break;
        case 'ol':
          blockBreak();
          listDepth += 1;
          listKind.push('ol');
          olIndex.push(0);
          break;
        case 'li': {
          const kind = listKind[listKind.length - 1] ?? 'ul';
          const indent = '  '.repeat(Math.max(0, listDepth - 1));
          if (kind === 'ol') {
            const last = olIndex.length - 1;
            olIndex[last] = (olIndex[last] ?? 0) + 1;
            push(`${indent}${olIndex[last]}. `);
          } else {
            push(`${indent}- `);
          }
          break;
        }
        case 'pre':
          inPre += 1;
          blockBreak();
          push('```' + fenceLanguage(attrs.class ?? '') + '\n');
          break;
        case 'code':
          if (inPre) {
            const lang = fenceLanguage(attrs.class ?? '');
            if (lang && out.endsWith('```\n')) {
              out = `${out.slice(0, -1)}${lang}\n`;
            }
          } else {
            inCode += 1;
            push('`');
          }
          break;
        case 'strong':
        case 'b':
          push('**');
          break;
        case 'em':
        case 'i':
          push('*');
          break;
        case 's':
        case 'del':
        case 'strike':
          push('~~');
          break;
        case 'mark':
          push('==');
          break;
        case 'a':
          push('[');
          pendingHref.push(attrs.href ?? '');
          break;
        default:
          break;
      }
      continue;
    }

    // close
    switch (name) {
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6':
      case 'p':
      case 'div':
      case 'section':
      case 'article':
      case 'blockquote':
        push('\n\n');
        break;
      case 'ul':
        listDepth = Math.max(0, listDepth - 1);
        listKind.pop();
        push('\n');
        break;
      case 'ol':
        listDepth = Math.max(0, listDepth - 1);
        listKind.pop();
        olIndex.pop();
        push('\n');
        break;
      case 'li':
        push('\n');
        break;
      case 'pre':
        inPre = Math.max(0, inPre - 1);
        if (!out.endsWith('\n')) push('\n');
        push('```\n\n');
        break;
      case 'code':
        if (!inPre && inCode > 0) {
          inCode -= 1;
          push('`');
        }
        break;
      case 'strong':
      case 'b':
        push('**');
        break;
      case 'em':
      case 'i':
        push('*');
        break;
      case 's':
      case 'del':
      case 'strike':
        push('~~');
        break;
      case 'mark':
        push('==');
        break;
      case 'a': {
        const href = pendingHref.pop() ?? '';
        push(href ? `](${href})` : ']()');
        break;
      }
      default:
        break;
    }
  }

  return out
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const RICH_TAG = /<(p|div|h[1-6]|ul|ol|li|table|blockquote|pre|strong|em|b|i|a|br)\b/i;

/**
 * True when the HTML carries structure worth converting. A CodeMirror copy
 * is usually a `<div>` wrapping the same characters as `text/plain`; those
 * we leave alone so we do not rewrite the user's own markdown.
 */
export function htmlLooksRich(html: string, plain: string): boolean {
  if (!html || !RICH_TAG.test(html)) return false;
  const stripped = decodeEntities(html.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
  const normalised = plain.replace(/\s+/g, ' ').trim();
  const unwrapped = html.replace(/^\s*<(div|p)[^>]*>\s*/i, '').replace(/\s*<\/(div|p)>\s*$/i, '');
  if (!/<[a-z]/i.test(unwrapped) && stripped === normalised) return false;
  return true;
}
