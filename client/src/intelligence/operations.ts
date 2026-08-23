import type { IntelligenceHeading } from './types.ts';

export type StructureDirection = 'up' | 'down';

export interface LineDiffChunk {
  kind: 'equal' | 'added' | 'removed';
  lines: string[];
}

function headingLine(text: string, heading: IntelligenceHeading): { from: number; to: number; source: string } {
  const from = heading.sectionFrom;
  const newline = text.indexOf('\n', from);
  const to = newline < 0 ? text.length : newline;
  return { from, to, source: text.slice(from, to) };
}

function replaceRange(text: string, from: number, to: number, replacement: string): string {
  if (from < 0 || to < from || to > text.length) throw new Error('The source range is no longer valid.');
  return `${text.slice(0, from)}${replacement}${text.slice(to)}`;
}

export function renameHeading(text: string, heading: IntelligenceHeading, title: string): string {
  const nextTitle = title.replace(/[\r\n]+/g, ' ').trim();
  if (!nextTitle || nextTitle.length > 240) throw new Error('Use a heading between 1 and 240 characters.');
  const line = headingLine(text, heading);
  const match = /^( {0,3}#{1,6})[ \t]+(.+?)([ \t]+#*[ \t]*)?$/.exec(line.source);
  if (!match) throw new Error('The heading changed; refresh the structure report.');
  return replaceRange(text, line.from, line.to, `${match[1]} ${nextTitle}${match[3] ?? ''}`);
}

export function shiftHeadingDepth(
  text: string,
  heading: IntelligenceHeading,
  direction: 'promote' | 'demote',
): string {
  if (direction === 'promote' && heading.level === 1) throw new Error('A level-one heading cannot be promoted.');
  const section = text.slice(heading.sectionFrom, heading.sectionTo);
  const delta = direction === 'promote' ? -1 : 1;
  const depths = [...section.matchAll(/^ {0,3}(#{1,6})[ \t]+/gm)].map((match) => match[1].length);
  if (depths.length === 0 || depths.some((depth) => depth + delta < 1 || depth + delta > 6)) {
    throw new Error(`This section contains a heading that cannot be ${direction === 'promote' ? 'promoted' : 'demoted'} safely.`);
  }
  let changed = false;
  const replacement = section.replace(/^( {0,3})(#{1,6})([ \t]+)/gm, (source, indent: string, hashes: string, spacing: string) => {
    const next = hashes.length + delta;
    if (next < 1 || next > 6) return source;
    changed = true;
    return `${indent}${'#'.repeat(next)}${spacing}`;
  });
  if (!changed) throw new Error('No headings in this section can move to that level.');
  return replaceRange(text, heading.sectionFrom, heading.sectionTo, replacement);
}

export function moveHeadingSection(
  text: string,
  headings: readonly IntelligenceHeading[],
  selected: IntelligenceHeading,
  direction: StructureDirection,
): string {
  const parent = [...headings]
    .reverse()
    .find((candidate) => candidate.sectionFrom < selected.sectionFrom
      && candidate.sectionTo >= selected.sectionTo
      && candidate.level < selected.level);
  const scopeFrom = parent?.sectionFrom ?? 0;
  const scopeTo = parent?.sectionTo ?? text.length;
  const siblings = headings.filter((candidate) =>
    candidate.level === selected.level
      && candidate.sectionFrom >= scopeFrom
      && candidate.sectionTo <= scopeTo);
  const position = siblings.findIndex((candidate) => candidate.sectionFrom === selected.sectionFrom);
  const neighbor = direction === 'up' ? siblings[position - 1] : siblings[position + 1];
  if (!neighbor) throw new Error(`This section is already the ${direction === 'up' ? 'first' : 'last'} at its level.`);
  if (direction === 'up') {
    const before = text.slice(neighbor.sectionFrom, selected.sectionFrom);
    const current = text.slice(selected.sectionFrom, selected.sectionTo);
    return replaceRange(text, neighbor.sectionFrom, selected.sectionTo, `${current}${before}`);
  }
  const current = text.slice(selected.sectionFrom, selected.sectionTo);
  const after = text.slice(neighbor.sectionFrom, neighbor.sectionTo);
  return replaceRange(text, selected.sectionFrom, neighbor.sectionTo, `${after}${current}`);
}

export function extractHeadingSection(
  text: string,
  heading: IntelligenceHeading,
  targetDocumentId: string,
  targetTitle: string,
): { source: string; remaining: string } {
  const source = text.slice(heading.sectionFrom, heading.sectionTo).trimEnd() + '\n';
  const label = targetTitle.replace(/[\]|\r\n]/g, ' ').trim() || heading.text;
  const replacement = `![[${targetDocumentId}|${label}]]\n`;
  return {
    source,
    remaining: replaceRange(text, heading.sectionFrom, heading.sectionTo, replacement),
  };
}

export function insertCitationFootnote(text: string, from: number, to: number, source: string): string {
  const compactSource = source.replace(/[\r\n]+/g, ' ').trim();
  if (!compactSource || compactSource.length > 2_000) throw new Error('Use a source note between 1 and 2,000 characters.');
  const identifiers = [...text.matchAll(/\[\^source-(\d+)\]/g)].map((match) => Number(match[1]));
  const next = Math.max(0, ...identifiers) + 1;
  const marker = `[^source-${next}]`;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > text.length) {
    throw new Error('The citation insertion range is invalid.');
  }
  const selectedText = text.slice(from, to);
  const withMarker = replaceRange(text, from, to, `${selectedText}${marker}`);
  const separator = withMarker.endsWith('\n') ? '\n' : '\n\n';
  return `${withMarker}${separator}${marker}: ${compactSource}\n`;
}

export function normalizeDoi(value: string): string | null {
  const match = /(?:https?:\/\/(?:dx\.)?doi\.org\/)?(10\.\d{4,9}\/[-._;()/:A-Z0-9]+)/i.exec(value.trim());
  return match?.[1].replace(/[.,;]+$/, '') ?? null;
}

export function crossDocumentBlock(documentId: string, heading?: string, label?: string): string {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(documentId)) throw new Error('The document identifier is invalid.');
  const cleanHeading = heading?.replace(/[\]|\r\n]/g, ' ').trim().slice(0, 200);
  const cleanLabel = label?.replace(/[\]|\r\n]/g, ' ').trim().slice(0, 200);
  return `![[${documentId}${cleanHeading ? `#${cleanHeading}` : ''}${cleanLabel ? `|${cleanLabel}` : ''}]]`;
}

export function pasteWithIntent(
  clipboard: string,
  intent: 'preserve' | 'plain' | 'quote' | 'code',
  provenance?: string,
): string {
  let inserted = clipboard.replace(/\r\n?/g, '\n');
  if (intent === 'plain') {
    inserted = inserted
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/[*_~`#>|]/g, '')
      .replace(/\n{3,}/g, '\n\n');
  } else if (intent === 'quote') {
    inserted = inserted.split('\n').map((line) => `> ${line}`).join('\n');
  } else if (intent === 'code') {
    const fenceLength = Math.max(3, ...[...inserted.matchAll(/`+/g)].map((match) => match[0].length + 1));
    const fence = '`'.repeat(fenceLength);
    inserted = `${fence}\n${inserted}\n${fence}`;
  }
  const source = provenance?.replace(/-->/g, '→').replace(/[\r\n]+/g, ' ').trim().slice(0, 500);
  return source ? `${inserted}\n<!-- marks:source ${source} -->` : inserted;
}

function pushChunk(chunks: LineDiffChunk[], kind: LineDiffChunk['kind'], line: string): void {
  const last = chunks.at(-1);
  if (last?.kind === kind) last.lines.push(line);
  else chunks.push({ kind, lines: [line] });
}

/** Bounded line LCS. Very large snapshots use a stable prefix/suffix diff. */
export function lineDiff(before: string, after: string): LineDiffChunk[] {
  const left = before.split('\n');
  const right = after.split('\n');
  if (left.length * right.length > 1_500_000) {
    let prefix = 0;
    while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix += 1;
    let suffix = 0;
    while (
      suffix < left.length - prefix &&
      suffix < right.length - prefix &&
      left[left.length - suffix - 1] === right[right.length - suffix - 1]
    ) suffix += 1;
    const chunks: LineDiffChunk[] = [];
    for (const line of left.slice(0, prefix)) pushChunk(chunks, 'equal', line);
    for (const line of left.slice(prefix, left.length - suffix)) pushChunk(chunks, 'removed', line);
    for (const line of right.slice(prefix, right.length - suffix)) pushChunk(chunks, 'added', line);
    for (const line of left.slice(left.length - suffix)) pushChunk(chunks, 'equal', line);
    return chunks;
  }
  const rows = Array.from({ length: left.length + 1 }, () => new Uint32Array(right.length + 1));
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      rows[i][j] = left[i] === right[j] ? rows[i + 1][j + 1] + 1 : Math.max(rows[i + 1][j], rows[i][j + 1]);
    }
  }
  const chunks: LineDiffChunk[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      pushChunk(chunks, 'equal', left[i]);
      i += 1;
      j += 1;
    } else if (j < right.length && (i >= left.length || rows[i][j + 1] >= rows[i + 1][j])) {
      pushChunk(chunks, 'added', right[j]);
      j += 1;
    } else {
      pushChunk(chunks, 'removed', left[i]);
      i += 1;
    }
  }
  return chunks;
}
