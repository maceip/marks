/**
 * Cursor context for contextual ribbon tabs.
 *
 * Word's most useful ribbon mechanic is not density — it is that Picture,
 * Table, and Shape tools appear only when the caret is in those objects.
 */

export type EditorContextKind = 'text' | 'heading' | 'image' | 'table' | 'shape' | 'code';

export interface ImageContext {
  from: number;
  to: number;
  alt: string;
  url: string;
  width?: number;
  align?: 'left' | 'center' | 'right';
  html: boolean;
}

export interface TableContext {
  from: number;
  to: number;
  rows: number;
  cols: number;
}

export interface ShapeContext {
  from: number;
  to: number;
  shape: string;
  label: string;
}

export interface EditorContext {
  kind: EditorContextKind;
  headingLevel?: number;
  image?: ImageContext;
  table?: TableContext;
  shape?: ShapeContext;
}

const IMAGE_MD = /!\[([^\]]*)\]\(([^)]+)\)/;
const IMAGE_HTML =
  /<img\b([^>]*?)\/?>/i;
const SHAPE = /<figure\b[^>]*class="[^"]*marks-shape[^"]*"[^>]*>[\s\S]*?<\/figure>/i;
const ATTR = /([\w-]+)=["']([^"']*)["']/g;

export function inspectEditorContext(doc: string, from: number, to = from): EditorContext {
  const pos = Math.max(0, Math.min(doc.length, from));
  const line = lineAt(doc, pos);
  const heading = /^(#{1,6})\s+\S/.exec(line.text);
  if (heading) {
    return { kind: 'heading', headingLevel: heading[1].length };
  }

  const fence = fenceAt(doc, pos);
  if (fence) {
    if (/^```(?:mermaid|shape)/i.test(fence.open)) return { kind: 'shape' };
    return { kind: 'code' };
  }

  const nearby = doc.slice(Math.max(0, line.from - 80), Math.min(doc.length, line.to + 80));
  const htmlImg = IMAGE_HTML.exec(nearby);
  if (htmlImg) {
    const abs = nearby.indexOf(htmlImg[0]) + Math.max(0, line.from - 80);
    return {
      kind: 'image',
      image: readHtmlImage(htmlImg[0], htmlImg[1] ?? '', abs, abs + htmlImg[0].length),
    };
  }

  const mdImg = IMAGE_MD.exec(line.text);
  if (mdImg) {
    return {
      kind: 'image',
      image: {
        from: line.from + (mdImg.index ?? 0),
        to: line.from + (mdImg.index ?? 0) + mdImg[0].length,
        alt: mdImg[1],
        url: mdImg[2],
        html: false,
      },
    };
  }

  const shapeMatch = SHAPE.exec(doc.slice(Math.max(0, pos - 400), Math.min(doc.length, pos + 800)));
  if (shapeMatch) {
    const abs = doc.indexOf(shapeMatch[0], Math.max(0, pos - 400));
    const attrs = attributes(shapeMatch[0]);
    const caption = /<figcaption>([\s\S]*?)<\/figcaption>/i.exec(shapeMatch[0]);
    return {
      kind: 'shape',
      shape: {
        from: abs,
        to: abs + shapeMatch[0].length,
        shape: attrs['data-shape'] || 'rect',
        label: caption?.[1]?.trim() || attrs['aria-label'] || 'Shape',
      },
    };
  }

  const table = tableAt(doc, pos);
  if (table) return { kind: 'table', table };

  void to;
  return { kind: 'text' };
}

function lineAt(doc: string, pos: number): { from: number; to: number; text: string } {
  const from = doc.lastIndexOf('\n', pos - 1) + 1;
  const to = doc.indexOf('\n', pos);
  const end = to === -1 ? doc.length : to;
  return { from, to: end, text: doc.slice(from, end) };
}

function fenceAt(doc: string, pos: number): { open: string } | null {
  const before = doc.slice(0, pos);
  const openIndex = before.lastIndexOf('```');
  if (openIndex === -1) return null;
  const afterOpen = doc.slice(openIndex + 3);
  const close = afterOpen.indexOf('```');
  if (close === -1 || openIndex + 3 + close < pos) return null;
  const openLine = doc.slice(openIndex, doc.indexOf('\n', openIndex));
  return { open: openLine };
}

function tableAt(doc: string, pos: number): TableContext | null {
  const line = lineAt(doc, pos);
  if (!/^\s*\|/.test(line.text) || !line.text.includes('|')) return null;

  let start = line.from;
  let end = line.to;
  while (start > 0) {
    const previous = lineAt(doc, start - 1);
    if (!/^\s*\|/.test(previous.text)) break;
    start = previous.from;
  }
  while (end < doc.length) {
    const next = lineAt(doc, end + 1);
    if (!/^\s*\|/.test(next.text)) break;
    end = next.to;
  }

  const rows = doc
    .slice(start, end)
    .split('\n')
    .filter((row) => /^\s*\|/.test(row) && !/^\s*\|[\s:|-]+\|/.test(row));
  const cols = Math.max(0, (rows[0]?.split('|').length ?? 2) - 2);
  if (rows.length === 0 || cols === 0) return null;
  return { from: start, to: end, rows: rows.length, cols };
}

function attributes(source: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const match of source.matchAll(ATTR)) {
    found[match[1]] = match[2];
  }
  return found;
}

function readHtmlImage(raw: string, attrs: string, from: number, to: number): ImageContext {
  const parsed = attributes(attrs || raw);
  const align = parsed['data-align'];
  const width = Number(parsed.width);
  return {
    from,
    to,
    alt: parsed.alt ?? '',
    url: parsed.src ?? '',
    width: Number.isFinite(width) && width > 0 ? width : undefined,
    align: align === 'left' || align === 'center' || align === 'right' ? align : undefined,
    html: true,
  };
}
