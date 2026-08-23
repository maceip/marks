import { isMap, parseDocument, type Document, type Node } from 'yaml';
import type { IntelligenceFrontMatter, SourceRange } from './types.ts';

const MAX_FRONT_MATTER_CHARS = 64 * 1024;

export interface FrontMatterPatch {
  title?: string | null;
  description?: string | null;
  audience?: string | null;
  status?: string | null;
  tags?: string[] | null;
  publishProfile?: 'web' | 'print' | 'readme' | 'slides' | null;
  canonicalUrl?: string | null;
  draft?: boolean | null;
  privacyMode?: 'standard' | 'strict' | null;
  readingGrade?: number | null;
  maxSentenceWords?: number | null;
}

interface FrontMatterEnvelope {
  exists: boolean;
  closed: boolean;
  from: number;
  to: number;
  yamlFrom: number;
  yamlTo: number;
  bodyFrom: number;
  yaml: string;
}

function lineRange(text: string, from: number, to: number): SourceRange {
  const prefix = text.slice(0, from);
  const lineStart = prefix.lastIndexOf('\n') + 1;
  return {
    from,
    to,
    line: prefix.split('\n').length,
    column: from - lineStart + 1,
  };
}

function envelope(text: string): FrontMatterEnvelope {
  if (!(text.startsWith('---\n') || text.startsWith('---\r\n'))) {
    return { exists: false, closed: true, from: 0, to: 0, yamlFrom: 0, yamlTo: 0, bodyFrom: 0, yaml: '' };
  }
  const openingBytes = text.startsWith('---\r\n') ? 5 : 4;
  if (text.length > MAX_FRONT_MATTER_CHARS && text.slice(0, MAX_FRONT_MATTER_CHARS).indexOf('\n---') < 0) {
    return {
      exists: true,
      closed: false,
      from: 0,
      to: Math.min(text.length, MAX_FRONT_MATTER_CHARS),
      yamlFrom: openingBytes,
      yamlTo: Math.min(text.length, MAX_FRONT_MATTER_CHARS),
      bodyFrom: Math.min(text.length, MAX_FRONT_MATTER_CHARS),
      yaml: text.slice(openingBytes, MAX_FRONT_MATTER_CHARS),
    };
  }
  const closing = /\r?\n---(?:\r?\n|$)/g;
  closing.lastIndex = openingBytes;
  const match = closing.exec(text);
  if (!match) {
    return {
      exists: true,
      closed: false,
      from: 0,
      to: Math.min(text.length, MAX_FRONT_MATTER_CHARS),
      yamlFrom: openingBytes,
      yamlTo: Math.min(text.length, MAX_FRONT_MATTER_CHARS),
      bodyFrom: Math.min(text.length, MAX_FRONT_MATTER_CHARS),
      yaml: text.slice(openingBytes, MAX_FRONT_MATTER_CHARS),
    };
  }
  const yamlTo = match.index;
  const to = match.index + match[0].length;
  return {
    exists: true,
    closed: true,
    from: 0,
    to,
    yamlFrom: openingBytes,
    yamlTo,
    bodyFrom: to,
    yaml: text.slice(openingBytes, yamlTo),
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function numberValue(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(min, Math.min(max, value))
    : fallback;
}

function parseYaml(source: string): { document: Document<Node, true>; errors: string[]; value: Record<string, unknown> } {
  const document = parseDocument(source, {
    strict: true,
    uniqueKeys: true,
    maxAliasCount: 20,
    prettyErrors: false,
  }) as Document<Node, true>;
  const errors = document.errors.map((error) => error.message.split('\n')[0].slice(0, 240));
  let value: Record<string, unknown> = {};
  if (errors.length === 0) {
    try {
      value = record(document.toJS({ maxAliasCount: 20 }));
    } catch (error) {
      errors.push(error instanceof Error ? error.message.slice(0, 240) : 'Front matter could not be expanded safely.');
    }
  }
  if (document.contents && !isMap(document.contents)) {
    errors.push('Front matter must be a YAML mapping.');
  }
  return { document, errors, value };
}

export function inspectFrontMatter(text: string): IntelligenceFrontMatter {
  const found = envelope(text);
  const errors: string[] = [];
  if (found.exists && !found.closed) {
    errors.push('Front matter is not closed within 64 KiB.');
  }
  const parsed = parseYaml(found.yaml);
  if (found.exists) errors.push(...parsed.errors);
  const value = found.exists ? parsed.value : {};
  const marks = record(value.marks);
  const publish = record(marks.publish);
  const privacy = record(marks.privacy);
  const quality = record(marks.quality);
  const profile = stringValue(publish.profile, 'web');
  const privacyMode = stringValue(privacy.mode, 'standard');
  const rawTags = value.tags;
  return {
    exists: found.exists,
    range: found.exists ? lineRange(text, found.from, found.to) : null,
    bodyFrom: found.bodyFrom,
    valid: errors.length === 0,
    errors,
    value,
    known: {
      title: stringValue(value.title),
      description: stringValue(value.description),
      audience: stringValue(value.audience),
      status: stringValue(value.status),
      tags: Array.isArray(rawTags) ? rawTags.filter((item): item is string => typeof item === 'string').slice(0, 64) : [],
      publishProfile: profile === 'print' || profile === 'readme' || profile === 'slides' ? profile : 'web',
      canonicalUrl: stringValue(publish.canonical),
      draft: booleanValue(publish.draft, true),
      privacyMode: privacyMode === 'strict' ? 'strict' : 'standard',
      readingGrade: numberValue(quality.readingGrade, 10, 1, 20),
      maxSentenceWords: numberValue(quality.maxSentenceWords, 28, 8, 80),
    },
  };
}

function setPath(document: Document<Node, true>, path: readonly string[], value: unknown): void {
  if (value === null) document.deleteIn(path);
  else if (value !== undefined) document.setIn(path, value);
}

/** Round-trip known Marks fields while preserving unknown keys and comments. */
export function updateFrontMatter(text: string, patch: FrontMatterPatch): string {
  const found = envelope(text);
  if (found.exists && !found.closed) {
    throw new Error('Close the front matter before changing its schema.');
  }
  const parsed = parseYaml(found.yaml);
  if (found.exists && parsed.errors.length > 0) {
    throw new Error(`Fix front matter first: ${parsed.errors[0]}`);
  }
  const document = parsed.document;
  if (!document.contents) document.contents = document.createNode({}) as Node;
  if (!isMap(document.contents)) throw new Error('Front matter must be a YAML mapping.');

  setPath(document, ['title'], patch.title);
  setPath(document, ['description'], patch.description);
  setPath(document, ['audience'], patch.audience);
  setPath(document, ['status'], patch.status);
  setPath(document, ['tags'], patch.tags);
  setPath(document, ['marks', 'publish', 'profile'], patch.publishProfile);
  setPath(document, ['marks', 'publish', 'canonical'], patch.canonicalUrl);
  setPath(document, ['marks', 'publish', 'draft'], patch.draft);
  setPath(document, ['marks', 'privacy', 'mode'], patch.privacyMode);
  setPath(document, ['marks', 'quality', 'readingGrade'], patch.readingGrade);
  setPath(document, ['marks', 'quality', 'maxSentenceWords'], patch.maxSentenceWords);

  const yaml = document.toString({ lineWidth: 0 }).trimEnd();
  const block = `---\n${yaml}\n---\n`;
  if (!found.exists) return `${block}${text}`;
  return `${block}${text.slice(found.bodyFrom).replace(/^\r?\n/, '')}`;
}
