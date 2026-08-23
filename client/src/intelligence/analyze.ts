import { slugify } from '../markdown/md.ts';
import { inspectFrontMatter } from './frontmatter.ts';
import type {
  DocumentIntelligence,
  FindingSeverity,
  IntelligenceBlockReference,
  IntelligenceCitation,
  IntelligenceDecision,
  IntelligenceFinding,
  IntelligenceHeading,
  IntelligenceImage,
  IntelligenceLink,
  IntelligenceTask,
  LinkKind,
  PracticalCapability,
  ReaderMetrics,
  SourceFix,
  SourceRange,
} from './types.ts';

const MAX_ANALYZED_CHARS = 8 * 1024 * 1024;
const MAX_FINDINGS = 600;
const MAX_ITEMS = 2_000;
const GENERIC_LINK_LABELS = new Set(['click here', 'here', 'link', 'learn more', 'read more', 'more']);
const SEVERITY_ORDER: Record<FindingSeverity, number> = {
  error: 0,
  warning: 1,
  suggestion: 2,
  info: 3,
};

interface LineRecord {
  number: number;
  from: number;
  to: number;
  text: string;
  code: boolean;
}

function scanLines(text: string): LineRecord[] {
  const records: LineRecord[] = [];
  let from = 0;
  let line = 1;
  let fence: { marker: '`' | '~'; length: number } | null = null;
  while (from <= text.length) {
    const newline = text.indexOf('\n', from);
    const to = newline < 0 ? text.length : newline;
    const value = text.slice(from, to).replace(/\r$/, '');
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(value);
    const wasCode = fence !== null;
    if (marker) {
      const kind = marker[1][0] as '`' | '~';
      if (!fence) fence = { marker: kind, length: marker[1].length };
      else if (fence.marker === kind && marker[1].length >= fence.length) fence = null;
    }
    records.push({ number: line, from, to, text: value, code: wasCode || Boolean(marker) });
    if (newline < 0) break;
    from = newline + 1;
    line += 1;
  }
  return records;
}

function sourceRange(line: LineRecord, localFrom: number, localTo: number): SourceRange {
  return {
    from: line.from + localFrom,
    to: line.from + localTo,
    line: line.number,
    column: localFrom + 1,
  };
}

function globalRange(text: string, from: number, to: number): SourceRange {
  const prefix = text.slice(0, from);
  const lineStart = prefix.lastIndexOf('\n') + 1;
  return {
    from,
    to,
    line: prefix.split('\n').length,
    column: from - lineStart + 1,
  };
}

function classifyLink(destination: string): LinkKind {
  if (destination.startsWith('#')) return 'anchor';
  if (/^marks:\/\/document\//i.test(destination) || /^\/d\//.test(destination)) return 'document';
  if (/^mailto:/i.test(destination)) return 'email';
  if (/^(?:\/a\/|marks-asset:)/i.test(destination)) return 'asset';
  if (/^https?:\/\//i.test(destination)) return 'external';
  return 'relative';
}

function normalizeDestination(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('<') && trimmed.endsWith('>')) return trimmed.slice(1, -1);
  return trimmed.split(/\s+["']/)[0];
}

function localAssetId(destination: string): string | null {
  const direct = /^marks-asset:([A-Za-z0-9_-]+)$/.exec(destination);
  if (direct) return direct[1];
  const service = /^\/a\/[^/]+\/([A-Za-z0-9_-]+)$/.exec(destination);
  return service?.[1] ?? null;
}

function stripMarkdownForReading(text: string): string {
  return text
    .replace(/^---[\s\S]*?^---\s*$/m, '')
    .replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[\^?[^\]]+\]/g, ' ')
    .replace(/[#>*_~`|{}()[\]-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function syllables(word: string): number {
  const normalized = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!normalized) return 0;
  if (normalized.length <= 3) return 1;
  const stripped = normalized.replace(/(?:es|ed|e)$/, '').replace(/^y/, '');
  return Math.max(1, stripped.match(/[aeiouy]{1,2}/g)?.length ?? 1);
}

function readerMetrics(text: string): ReaderMetrics {
  const plain = stripMarkdownForReading(text);
  const words = plain.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? [];
  const sentences = Math.max(plain ? 1 : 0, plain.match(/[.!?]+(?:\s|$)/g)?.length ?? 0);
  const paragraphs = Math.max(plain ? 1 : 0, text.split(/\n\s*\n/).filter((part) => stripMarkdownForReading(part)).length);
  const totalSyllables = words.reduce((sum, word) => sum + syllables(word), 0);
  const averageSentenceWords = sentences ? words.length / sentences : 0;
  const ease = words.length && sentences
    ? 206.835 - 1.015 * averageSentenceWords - 84.6 * (totalSyllables / words.length)
    : 100;
  const grade = words.length && sentences
    ? 0.39 * averageSentenceWords + 11.8 * (totalSyllables / words.length) - 15.59
    : 0;
  return {
    words: words.length,
    sentences,
    paragraphs,
    readingMinutes: words.length / 220,
    speakingMinutes: words.length / 145,
    averageSentenceWords,
    fleschReadingEase: Math.max(0, Math.min(100, ease)),
    estimatedGrade: Math.max(0, Math.min(20, grade)),
  };
}

function validCanonicalUrl(value: string): boolean {
  if (!value) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

function decodedAnchor(value: string): string {
  try {
    return decodeURIComponent(value).toLowerCase();
  } catch {
    return value.toLowerCase();
  }
}

export function analyzeDocument(markdown: string, revision = 0): DocumentIntelligence {
  const truncated = markdown.length > MAX_ANALYZED_CHARS;
  const text = truncated ? markdown.slice(0, MAX_ANALYZED_CHARS) : markdown;
  const lines = scanLines(text);
  const frontMatter = inspectFrontMatter(text);
  const headings: IntelligenceHeading[] = [];
  const links: IntelligenceLink[] = [];
  const images: IntelligenceImage[] = [];
  const citations: IntelligenceCitation[] = [];
  const tasks: IntelligenceTask[] = [];
  const decisions: IntelligenceDecision[] = [];
  const blockReferences: IntelligenceBlockReference[] = [];
  const findings: IntelligenceFinding[] = [];
  const references = new Map<string, { destination: string; range: SourceRange }>();
  const referenceUses: Array<{ id: string; label: string; range: SourceRange }> = [];
  const footnoteDefinitions = new Map<string, SourceRange>();
  const citationUses: Array<{ key: string; style: 'pandoc' | 'footnote'; range: SourceRange }> = [];
  const duplicateDestinations = new Map<string, IntelligenceLink[]>();
  let findingSequence = 0;
  let openFence: { line: LineRecord; marker: string } | null = null;
  let displayMathOpen: LineRecord | null = null;

  const addFinding = (
    capability: PracticalCapability,
    severity: FindingSeverity,
    code: string,
    title: string,
    detail: string,
    range?: SourceRange,
    fix?: SourceFix,
  ) => {
    if (findings.length >= MAX_FINDINGS) return;
    findings.push({
      id: `${code}:${range?.from ?? 0}:${findingSequence++}`,
      capability,
      severity,
      code,
      title,
      detail,
      range,
      fix,
    });
  };

  if (truncated) {
    addFinding('health', 'warning', 'analysis.truncated', 'Analysis limit reached', 'The first 8 MiB were inspected; later source is not represented in this report.');
  }
  for (const error of frontMatter.errors) {
    addFinding('schema', 'error', 'frontmatter.invalid', 'Front matter is invalid', error, frontMatter.range ?? undefined);
  }

  for (const line of lines) {
    const value = line.text;
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(value);
    if (fence) {
      if (!openFence) openFence = { line, marker: fence[1] };
      else if (openFence.marker[0] === fence[1][0] && fence[1].length >= openFence.marker.length) openFence = null;
      continue;
    }

    if (!line.code) {
      const heading = /^( {0,3})(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(value);
      if (heading && headings.length < MAX_ITEMS) {
        const textValue = heading[3].trim();
        const localFrom = heading[1].length;
        headings.push({
          level: heading[2].length,
          text: textValue,
          slug: slugify(textValue),
          range: sourceRange(line, localFrom, value.length),
          sectionFrom: line.from,
          sectionTo: text.length,
        });
      }

      const definition = /^ {0,3}\[([^\]^][^\]]*)\]:\s*(\S.*)$/.exec(value);
      if (definition) {
        const key = definition[1].trim().toLowerCase();
        const prior = references.get(key);
        const range = sourceRange(line, value.indexOf(definition[1]), value.length);
        if (prior) addFinding('render', 'warning', 'link-definition.duplicate', 'Duplicate link definition', `“${definition[1]}” is already defined on line ${prior.range.line}.`, range);
        else references.set(key, { destination: normalizeDestination(definition[2]), range });
      }
      const footnote = /^ {0,3}\[\^([^\]]+)\]:\s*(.*)$/.exec(value);
      if (footnote) {
        const key = footnote[1].trim().toLowerCase();
        const range = sourceRange(line, value.indexOf(footnote[1]), value.length);
        if (footnoteDefinitions.has(key)) addFinding('citations', 'warning', 'footnote.duplicate', 'Duplicate footnote definition', `Footnote “${key}” has more than one definition.`, range);
        else footnoteDefinitions.set(key, range);
      }

      const task = /^(\s*(?:[-+*]|\d+[.)])\s+)\[([ xX])\]\s+(.+)$/.exec(value);
      if (task && tasks.length < MAX_ITEMS) {
        const markerFrom = value.indexOf(`[${task[2]}]`);
        const owner = /(?:^|\s)@([\p{L}\p{N}_.-]+)/u.exec(task[3])?.[1] ?? null;
        const due = /(?:^|\s)due:([^\s]+)/i.exec(task[3])?.[1] ?? null;
        tasks.push({
          id: `task:${line.from + markerFrom}`,
          text: task[3].trim(),
          checked: task[2].toLowerCase() === 'x',
          range: sourceRange(line, 0, value.length),
          markerRange: sourceRange(line, markerFrom, markerFrom + 3),
          owner,
          due,
        });
      }

      const decision = /^\s*(?:[-+*]\s+)?(?:\*\*)?(?:decision|decided)(?:\*\*)?\s*:\s*(.+)$/i.exec(value);
      if (decision && decisions.length < MAX_ITEMS) {
        decisions.push({ id: `decision:${line.from}`, text: decision[1].trim(), range: sourceRange(line, 0, value.length) });
      }

      if (/^\s*\$\$\s*$/.test(value)) {
        if (displayMathOpen) displayMathOpen = null;
        else displayMathOpen = line;
      }

      const crossBlock = /!\[\[([A-Za-z0-9_-]{1,160})(?:#([^\]|\n]{1,200}))?(?:\|([^\]\n]{1,200}))?\]\]/g;
      for (const match of value.matchAll(crossBlock)) {
        if (blockReferences.length >= MAX_ITEMS) break;
        blockReferences.push({
          id: `block:${line.from + (match.index ?? 0)}`,
          documentId: match[1],
          heading: match[2]?.trim() || null,
          label: match[3]?.trim() || null,
          range: sourceRange(line, match.index ?? 0, (match.index ?? 0) + match[0].length),
        });
      }

      const inlineLink = /(!?)\[([^\]\n]*)\]\(([^)\n]+)\)/g;
      for (const match of value.matchAll(inlineLink)) {
        const image = match[1] === '!';
        const index = match.index ?? 0;
        const destination = normalizeDestination(match[3]);
        const destinationLocal = index + match[0].indexOf(match[3]);
        const range = sourceRange(line, index, index + match[0].length);
        const destinationRange = sourceRange(line, destinationLocal, destinationLocal + match[3].length);
        const kind = classifyLink(destination);
        const item: IntelligenceLink = {
          id: `${image ? 'image' : 'link'}:${line.from + index}`,
          label: match[2],
          destination,
          kind,
          range,
          destinationRange,
          status: 'unchecked',
          statusDetail: kind === 'external' ? 'External checks run only when requested.' : 'Resolved from the current source.',
        };
        if (image) {
          if (images.length < MAX_ITEMS) images.push({ ...item, alt: match[2], localAssetId: localAssetId(destination) });
        } else if (links.length < MAX_ITEMS) {
          links.push(item);
        }
      }

      const referenceLink = /(?<!!)\[([^\]\n]+)\]\[([^\]\n]*)\]/g;
      for (const match of value.matchAll(referenceLink)) {
        const index = match.index ?? 0;
        referenceUses.push({
          id: (match[2] || match[1]).trim().toLowerCase(),
          label: match[1],
          range: sourceRange(line, index, index + match[0].length),
        });
      }

      const footnoteUse = /\[\^([^\]\n]+)\]/g;
      for (const match of value.matchAll(footnoteUse)) {
        if (/^ {0,3}\[\^/.test(value) && value.indexOf(']:') >= 0) continue;
        citationUses.push({
          key: match[1].trim().toLowerCase(),
          style: 'footnote',
          range: sourceRange(line, match.index ?? 0, (match.index ?? 0) + match[0].length),
        });
      }
      const pandocUse = /\[@([A-Za-z0-9_.:/-]{1,200})(?:[^\]]*)\]/g;
      for (const match of value.matchAll(pandocUse)) {
        citationUses.push({
          key: match[1],
          style: 'pandoc',
          range: sourceRange(line, match.index ?? 0, (match.index ?? 0) + match[0].length),
        });
      }
    }

    const privacyPatterns: Array<{ code: string; title: string; regex: RegExp; replacement: string }> = [
      { code: 'privacy.secret', title: 'Possible credential', regex: /\b(?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*["']?([A-Za-z0-9_./+:-]{8,})/gi, replacement: '[redacted credential]' },
      { code: 'privacy.aws-key', title: 'Possible AWS access key', regex: /\bAKIA[0-9A-Z]{16}\b/g, replacement: '[redacted AWS key]' },
      { code: 'privacy.email', title: 'Email address', regex: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, replacement: '[redacted email]' },
      { code: 'privacy.ip', title: 'IPv4 address', regex: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, replacement: '[redacted IP]' },
    ];
    for (const pattern of privacyPatterns) {
      pattern.regex.lastIndex = 0;
      for (let match = pattern.regex.exec(value); match; match = pattern.regex.exec(value)) {
        const matched = match[0];
        const range = sourceRange(line, match.index, match.index + matched.length);
        addFinding('privacy', pattern.code.includes('secret') || pattern.code.includes('aws') ? 'error' : 'warning', pattern.code, pattern.title, 'Review this value before publishing or sharing outside the current audience.', range, {
          label: 'Redact value',
          from: range.from,
          to: range.to,
          expected: matched,
          replacement: pattern.replacement,
        });
        if (matched.length === 0) break;
      }
    }
  }

  if (openFence) {
    const range = sourceRange(openFence.line, 0, openFence.line.text.length);
    addFinding('render', 'error', 'fence.unclosed', 'Unclosed code fence', 'Add a matching fence so later content is rendered normally.', range, {
      label: 'Close fence at document end',
      from: text.length,
      to: text.length,
      expected: '',
      replacement: `\n${openFence.marker}\n`,
    });
  }
  if (displayMathOpen) {
    const range = sourceRange(displayMathOpen, 0, displayMathOpen.text.length);
    addFinding('render', 'error', 'math.unclosed', 'Unclosed display math', 'Add a closing $$ delimiter.', range, {
      label: 'Close display math',
      from: text.length,
      to: text.length,
      expected: '',
      replacement: '\n$$\n',
    });
  }

  const slugCounts = new Map<string, number>();
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index];
    const occurrence = (slugCounts.get(heading.slug) ?? 0) + 1;
    slugCounts.set(heading.slug, occurrence);
    if (occurrence > 1) heading.slug = `${heading.slug}-${occurrence}`;
    heading.sectionTo = headings.slice(index + 1).find((candidate) => candidate.level <= heading.level)?.sectionFrom ?? text.length;
    const previous = headings[index - 1];
    if (previous && heading.level > previous.level + 1) {
      addFinding('accessibility', 'warning', 'heading.level-jump', 'Heading level is skipped', `Heading level ${previous.level} is followed by level ${heading.level}.`, heading.range);
    }
  }
  if (!headings.some((heading) => heading.level === 1)) {
    addFinding('health', 'warning', 'heading.missing-title', 'No top-level heading', 'A single H1 gives the document and assistive technology a clear title.');
  }
  if (headings.filter((heading) => heading.level === 1).length > 1) {
    for (const heading of headings.filter((candidate) => candidate.level === 1).slice(1)) {
      addFinding('accessibility', 'suggestion', 'heading.multiple-title', 'Additional top-level heading', 'Consider one document title and level-two headings for its major sections.', heading.range);
    }
  }

  const headingSlugs = new Set(headings.map((heading) => heading.slug));
  for (const item of [...links, ...images]) {
    if (item.kind === 'anchor') {
      const slug = decodedAnchor(item.destination.slice(1));
      if (headingSlugs.has(slug)) {
        item.status = 'valid';
        item.statusDetail = 'The target heading exists.';
      } else {
        item.status = 'broken';
        item.statusDetail = 'No matching heading exists.';
        addFinding('links', 'error', 'link.anchor-missing', 'Broken heading link', `No heading resolves “${item.destination}”.`, item.destinationRange);
      }
    } else if (item.kind === 'asset' || item.kind === 'document') {
      item.status = 'valid';
      item.statusDetail = 'The destination has valid Marks syntax; access is checked when opened.';
    }
    const bucket = duplicateDestinations.get(item.destination) ?? [];
    bucket.push(item);
    duplicateDestinations.set(item.destination, bucket);
  }

  for (const item of images) {
    if (!item.alt.trim()) {
      const source = text.slice(item.range.from, item.range.to);
      const fixed = source.replace(/^!\[[^\]]*\]/, '![Describe this image]');
      addFinding('accessibility', 'error', 'image.alt-missing', 'Image has no alternative text', 'Describe the information conveyed by this image.', item.range, {
        label: 'Insert alt-text placeholder',
        from: item.range.from,
        to: item.range.to,
        expected: source,
        replacement: fixed,
      });
    } else if (item.alt.trim().length > 160) {
      addFinding('accessibility', 'suggestion', 'image.alt-long', 'Alternative text is long', 'Keep alt text concise and move extended explanation into nearby prose.', item.range);
    }
  }
  for (const item of links) {
    if (GENERIC_LINK_LABELS.has(item.label.trim().toLowerCase())) {
      addFinding('accessibility', 'warning', 'link.label-generic', 'Link text lacks context', 'Name the destination or action instead of using generic link text.', item.range);
    }
    if (item.destination.toLowerCase().startsWith('http://')) {
      addFinding('links', 'warning', 'link.http', 'Link does not use HTTPS', 'Confirm that this destination is intentionally sent over plaintext HTTP.', item.destinationRange);
    }
  }
  for (const [destination, occurrences] of duplicateDestinations) {
    if (destination && occurrences.length >= 4) {
      addFinding('links', 'suggestion', 'link.repeated', 'Repeated destination', `“${destination}” appears ${occurrences.length} times; a reference link may be easier to maintain.`, occurrences[0].range);
    }
  }

  for (const use of referenceUses) {
    const definition = references.get(use.id);
    const destination = definition?.destination ?? '';
    const kind = destination ? classifyLink(destination) : 'relative';
    const item: IntelligenceLink = {
      id: `reference:${use.range.from}`,
      label: use.label,
      destination,
      kind,
      range: use.range,
      destinationRange: definition?.range ?? use.range,
      status: definition ? 'valid' : 'broken',
      statusDetail: definition ? `Defined on line ${definition.range.line}.` : 'Reference definition is missing.',
    };
    if (links.length < MAX_ITEMS) links.push(item);
    if (!definition) addFinding('render', 'error', 'link-reference.missing', 'Missing link definition', `Add a [${use.id}]: destination definition.`, use.range);
  }

  const citationDefinitions = new Set<string>();
  const bibliography = frontMatter.value.bibliography;
  const hasBibliography = typeof bibliography === 'string' || (Array.isArray(bibliography) && bibliography.some((item) => typeof item === 'string'));
  const inlineReferences = frontMatter.value.references;
  if (Array.isArray(inlineReferences)) {
    for (const reference of inlineReferences) {
      if (reference && typeof reference === 'object' && typeof (reference as { id?: unknown }).id === 'string') {
        citationDefinitions.add((reference as { id: string }).id.toLowerCase());
      }
    }
  }
  for (const use of citationUses) {
    const definition = use.style === 'footnote' ? footnoteDefinitions.get(use.key) : undefined;
    const defined = use.style === 'footnote' ? Boolean(definition) : hasBibliography || citationDefinitions.has(use.key.toLowerCase());
    const item: IntelligenceCitation = {
      id: `citation:${use.range.from}`,
      key: use.key,
      style: use.style,
      range: use.range,
      defined,
      definitionRange: definition,
    };
    if (citations.length < MAX_ITEMS) citations.push(item);
    if (!defined) {
      addFinding('citations', use.style === 'footnote' ? 'error' : 'warning', 'citation.undefined', 'Citation has no local source record', use.style === 'footnote'
        ? `Footnote “${use.key}” has no definition.`
        : `Citation “${use.key}” is not represented by local bibliography metadata.`, use.range);
    }
  }
  for (const [key, range] of footnoteDefinitions) {
    if (!citationUses.some((use) => use.style === 'footnote' && use.key === key)) {
      addFinding('citations', 'suggestion', 'footnote.unused', 'Unused footnote definition', `Footnote “${key}” is never referenced.`, range);
    }
  }

  const tableLines = lines.filter((line) => !line.code && line.text.includes('|'));
  for (let index = 0; index < tableLines.length; index += 1) {
    const line = tableLines[index];
    const next = lines[line.number];
    if (!next || !/^\s*\|?\s*:?-{3,}/.test(next.text)) continue;
    const rawTable = line.text.trim().replace(/^\|/, '').replace(/\|$/, '');
    const cells = rawTable.split('|').map((cell) => cell.trim());
    if (cells.length > 0 && cells.some((cell) => !cell)) {
      addFinding('accessibility', 'warning', 'table.header-empty', 'Table has an empty header', 'Give every column a meaningful header.', sourceRange(line, 0, line.text.length));
    }
  }

  const metrics = readerMetrics(text.slice(frontMatter.bodyFrom));
  const quality = frontMatter.known;
  if (metrics.estimatedGrade > quality.readingGrade + 1) {
    addFinding('quality', 'warning', 'quality.reading-grade', 'Reading level exceeds the contract', `Estimated grade ${metrics.estimatedGrade.toFixed(1)} is above the target of ${quality.readingGrade}.`);
  }
  const longSentence = lines.find((line) => {
    if (line.code) return false;
    return stripMarkdownForReading(line.text).split(/\s+/).filter(Boolean).length > quality.maxSentenceWords;
  });
  if (longSentence) {
    addFinding('quality', 'suggestion', 'quality.long-sentence', 'Sentence may be hard to scan', `This line exceeds the ${quality.maxSentenceWords}-word quality contract.`, sourceRange(longSentence, 0, longSentence.text.length));
  }
  if (!frontMatter.exists) {
    addFinding('schema', 'suggestion', 'frontmatter.missing', 'No document schema', 'Add portable front matter for audience, publishing, privacy, and quality intent.');
  } else {
    if (!frontMatter.known.title) addFinding('schema', 'suggestion', 'frontmatter.title-missing', 'Schema title is empty', 'Add a portable title without changing the catalog name.', frontMatter.range ?? undefined);
    if (!frontMatter.known.audience) addFinding('quality', 'suggestion', 'quality.audience-missing', 'Audience is not declared', 'Name the intended reader so quality checks have useful context.', frontMatter.range ?? undefined);
    if (!validCanonicalUrl(frontMatter.known.canonicalUrl)) addFinding('publish', 'error', 'publish.canonical-invalid', 'Canonical URL is invalid', 'Use an absolute HTTPS URL without credentials or a fragment.', frontMatter.range ?? undefined);
  }
  if (frontMatter.known.publishProfile === 'slides' && headings.filter((heading) => heading.level <= 2).length < 2) {
    addFinding('publish', 'warning', 'publish.slides-structure', 'Slides need section breaks', 'Use level-one or level-two headings to define multiple slides.');
  }
  if (frontMatter.known.privacyMode === 'strict' && links.some((link) => link.kind === 'external')) {
    addFinding('privacy', 'warning', 'privacy.external-links', 'Strict document links externally', 'External navigation can disclose the reader through destination logs.');
  }
  for (const task of tasks) {
    if (task.due && !/^\d{4}-\d{2}-\d{2}$/.test(task.due)) {
      addFinding('ledger', 'warning', 'task.due-invalid', 'Task due date is invalid', 'Use due:YYYY-MM-DD.', task.range);
    }
  }
  if (tasks.length > 0 && tasks.every((task) => !task.owner)) {
    addFinding('ledger', 'suggestion', 'task.owner-missing', 'Tasks have no owners', 'Add @owner to make responsibility visible.');
  }
  if (blockReferences.some((reference) => reference.documentId === '')) {
    addFinding('blocks', 'error', 'block.target-missing', 'Cross-document block has no target', 'Choose a readable document target.');
  }

  findings.sort((left, right) => {
    const severity = SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity];
    return severity || (left.range?.from ?? Number.MAX_SAFE_INTEGER) - (right.range?.from ?? Number.MAX_SAFE_INTEGER);
  });
  const penalty = findings.reduce((sum, finding) => sum + ({ error: 12, warning: 5, suggestion: 2, info: 0 }[finding.severity]), 0);
  const healthScore = Math.max(0, Math.min(100, 100 - penalty));
  return {
    revision,
    truncated,
    healthScore,
    stats: {
      chars: markdown.length,
      bytes: new TextEncoder().encode(markdown).byteLength,
      lines: lines.length,
      headings: headings.length,
      links: links.length,
      images: images.length,
      citations: citations.length,
      tasks: tasks.length,
      completedTasks: tasks.filter((task) => task.checked).length,
      decisions: decisions.length,
      blockReferences: blockReferences.length,
    },
    reader: metrics,
    frontMatter,
    headings,
    links,
    images,
    citations,
    tasks,
    decisions,
    blockReferences,
    findings,
  };
}

export function findingCounts(findings: readonly IntelligenceFinding[]): Record<FindingSeverity, number> {
  return findings.reduce<Record<FindingSeverity, number>>((counts, finding) => {
    counts[finding.severity] += 1;
    return counts;
  }, { error: 0, warning: 0, suggestion: 0, info: 0 });
}

export function applySourceFix(text: string, fix: SourceFix): string {
  if (!Number.isInteger(fix.from) || !Number.isInteger(fix.to) || fix.from < 0 || fix.to < fix.from || fix.to > text.length) {
    throw new Error('The suggested source range is no longer valid.');
  }
  if (text.slice(fix.from, fix.to) !== fix.expected) {
    throw new Error('The document changed; refresh the finding before applying it.');
  }
  return `${text.slice(0, fix.from)}${fix.replacement}${text.slice(fix.to)}`;
}

export function rangeForOffsets(text: string, from: number, to: number): SourceRange {
  return globalRange(text, from, to);
}
