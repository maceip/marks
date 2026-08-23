import type { CommandDefinition, CommandReceipt } from '../commands/types.ts';
import type { DocumentIntelligence, SourceRange } from '../intelligence/types.ts';
import type {
  ConsequenceLane,
  ContextSignal,
  ContextSignalKind,
  CounterfactualPatch,
  IntentCandidate,
  SourceDelta,
} from './types.ts';

const DAY_MS = 24 * 60 * 60 * 1_000;
const MAX_CONTEXT_SCAN_CHARS = 2 * 1024 * 1024;
const CONTEXT_WINDOW = 80;

function fingerprint(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const character of value) {
    hash ^= BigInt(character.codePointAt(0) ?? 0);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(36);
}

export async function digestText(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function sourceLineStarts(text: string): number[] {
  const starts = [0];
  for (let index = text.indexOf('\n'); index >= 0; index = text.indexOf('\n', index + 1)) {
    starts.push(index + 1);
  }
  return starts;
}

function rangeAt(lineStarts: readonly number[], from: number, to: number): SourceRange {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (lineStarts[middle] <= from) low = middle;
    else high = middle - 1;
  }
  const lineStart = lineStarts[low] ?? 0;
  return {
    from,
    to,
    line: low + 1,
    column: from - lineStart + 1,
  };
}

function addContextSignal(
  signals: ContextSignal[],
  documentId: string,
  source: string,
  lineStarts: readonly number[],
  kind: ContextSignalKind,
  label: string,
  detail: string,
  from: number,
  to: number,
  ttlMs: number,
  now: number,
): void {
  if (signals.length >= 200 || from < 0 || to <= from) return;
  const expected = source.slice(from, to);
  const identity = `${kind}:${expected.toLocaleLowerCase()}:${source.slice(Math.max(0, from - 32), Math.min(source.length, to + 32)).replace(/\s+/g, ' ')}`;
  signals.push({
    id: `context:${documentId}:${fingerprint(identity)}`,
    documentId,
    kind,
    label,
    detail,
    expected,
    range: rangeAt(lineStarts, from, to),
    firstSeenAt: now,
    lastSeenAt: now,
    reviewedAt: null,
    ttlMs,
    active: true,
    dismissed: false,
  });
}

/** Lightweight, bounded discovery used even while the full intelligence drawer is closed. */
export function deriveContextSignals(documentId: string, markdown: string, now = Date.now()): ContextSignal[] {
  const source = markdown.slice(0, MAX_CONTEXT_SCAN_CHARS);
  const lineStarts = sourceLineStarts(source);
  const signals: ContextSignal[] = [];
  const patterns: Array<{
    kind: ContextSignalKind;
    regex: RegExp;
    label: (value: string) => string;
    detail: string;
    ttl: (value: string) => number;
  }> = [
    {
      kind: 'relative-time',
      regex: /\b(?:today|tomorrow|yesterday|currently|right now|this (?:week|month|quarter)|soon)\b/gi,
      label: (value) => `Relative claim: “${value}”`,
      detail: 'Relative language changes meaning as the reading date moves.',
      ttl: () => DAY_MS,
    },
    {
      kind: 'relative-time',
      regex: /\b(?:latest|newest|recent(?:ly)?|state[- ]of[- ]the[- ]art|current version)\b/gi,
      label: (value) => `Freshness claim: “${value}”`,
      detail: 'Superlative or freshness language should be periodically re-evidenced.',
      ttl: () => 7 * DAY_MS,
    },
    {
      kind: 'as-of-date',
      regex: /\bas of\s+(\d{4}-\d{2}-\d{2}|[A-Z][a-z]+\s+\d{1,2},?\s+\d{4})\b/gi,
      label: (value) => `Dated context: “${value}”`,
      detail: 'The claim declares its observation date; review it on a deliberate cadence.',
      ttl: () => 30 * DAY_MS,
    },
    {
      kind: 'version-claim',
      regex: /\b(?:version|release|API|schema|protocol)\s+v?\d+(?:\.\d+){0,3}\b/gi,
      label: (value) => `Version-bound claim: “${value}”`,
      detail: 'This statement may stop applying when the named interface advances.',
      ttl: () => 30 * DAY_MS,
    },
    {
      kind: 'deadline',
      regex: /\bdue:(\d{4}-\d{2}-\d{2})\b/gi,
      label: (value) => `Deadline: ${value.slice(4)}`,
      detail: 'A dated task loses operational value after its due date without review.',
      ttl: (value) => {
        const due = Date.parse(`${value.slice(4)}T23:59:59Z`);
        return Number.isFinite(due) ? Math.max(DAY_MS, due - now) : 7 * DAY_MS;
      },
    },
    {
      kind: 'external-dependency',
      regex: /https?:\/\/[^\s<>)\]]+/gi,
      label: () => 'External dependency',
      detail: 'The meaning or availability of linked material can change independently.',
      ttl: () => 30 * DAY_MS,
    },
  ];

  // Fenced examples should not age the surrounding document's assertions.
  const fencedRanges: Array<[number, number]> = [];
  let open: { marker: string; from: number } | null = null;
  for (const match of source.matchAll(/^ {0,3}(`{3,}|~{3,}).*$/gm)) {
    const marker = match[1];
    const from = match.index ?? 0;
    if (!open) open = { marker, from };
    else if (open.marker[0] === marker[0] && marker.length >= open.marker.length) {
      fencedRanges.push([open.from, from + match[0].length]);
      open = null;
    }
  }
  if (open) fencedRanges.push([open.from, source.length]);
  const insideFence = (offset: number) => fencedRanges.some(([from, to]) => offset >= from && offset < to);

  for (const pattern of patterns) {
    pattern.regex.lastIndex = 0;
    for (let match = pattern.regex.exec(source); match; match = pattern.regex.exec(source)) {
      const from = match.index;
      if (!insideFence(from)) {
        addContextSignal(signals, documentId, source, lineStarts, pattern.kind, pattern.label(match[0]), pattern.detail, from, from + match[0].length, pattern.ttl(match[0]), now);
      }
      if (!match[0]) break;
    }
  }
  return signals;
}

function candidate(
  id: string,
  label: string,
  detail: string,
  commandIds: string[],
  confidence: number,
  urgency: IntentCandidate['urgency'],
): IntentCandidate {
  return { id, label, detail, commandIds, basis: 'document', confidence, urgency };
}

export function deriveIntentions(
  report: DocumentIntelligence,
  receipts: readonly CommandReceipt[],
): IntentCandidate[] {
  const result: IntentCandidate[] = [];
  const codes = new Set(report.findings.map((finding) => finding.code));
  const errors = report.findings.filter((finding) => finding.severity === 'error').length;
  const missingCitations = report.citations.filter((citation) => !citation.defined).length;
  const openTasks = report.tasks.filter((task) => !task.checked).length;

  if (errors > 0) result.push(candidate('repair-health', 'Stabilize the document', `${errors} error${errors === 1 ? '' : 's'} can change the rendered or published outcome.`, ['review.document-health'], .96, 'now'));
  if (report.findings.some((finding) => finding.capability === 'privacy')) result.push(candidate('review-exposure', 'Review exposure before sharing', 'Sensitive-looking values are present in the current source.', ['review.privacy-exposure', 'document.share'], .94, 'now'));
  if (missingCitations > 0) result.push(candidate('reconcile-evidence', 'Reconcile evidence', `${missingCitations} citation marker${missingCitations === 1 ? '' : 's'} lack a local source record.`, ['review.citation-ledger'], .88, 'next'));
  if (openTasks > 0) result.push(candidate('close-loop', 'Close the action loop', `${openTasks} open task${openTasks === 1 ? '' : 's'} remain in Markdown.`, ['review.task-decision-ledger'], .83, 'next'));
  if (!report.frontMatter.exists || !report.frontMatter.known.audience) result.push(candidate('declare-contract', 'Declare the reader contract', 'Audience or portable document intent is still implicit.', ['tools.front-matter', 'review.quality-contract'], .78, 'next'));
  if (report.frontMatter.known.draft && report.healthScore >= 80) result.push(candidate('prepare-release', 'Prepare a publishable artifact', 'This draft is healthy enough to inspect an output profile.', ['document.publish-profile', 'view.reader-simulation'], .72, 'later'));
  if (codes.has('link.anchor-missing') || report.links.some((link) => link.kind === 'external')) result.push(candidate('verify-links', 'Verify destinations', 'The document contains unresolved or independently changing destinations.', ['review.link-intelligence'], .7, 'later'));

  const recent = receipts.slice(-8);
  if (recent.filter((receipt) => receipt.commandId.startsWith('format.')).length >= 3) {
    result.push({
      id: 'activity-review-render',
      label: 'Inspect the compiled result',
      detail: 'Recent activity concentrated on source formatting; a rendered pass may reveal second-order effects.',
      commandIds: ['view.preview', 'review.render-diagnostics'],
      basis: 'activity',
      confidence: .68,
      urgency: 'next',
    });
  }
  return result.slice(0, 7);
}

const MUTATING_EDITOR_OPERATIONS = new Set([
  'paste', 'cut', 'paragraph', 'heading-1', 'heading-2', 'heading-3', 'heading-4',
  'bold', 'italic', 'underline', 'strikethrough', 'highlight', 'inline-code',
  'grow-heading', 'shrink-heading', 'clear-formatting', 'bullet-list', 'numbered-list',
  'task-list', 'quote', 'indent', 'outdent', 'insert-image-url', 'insert-image-file',
  'insert-shape-rect', 'insert-shape-ellipse', 'insert-shape-diamond', 'insert-shape-arrow',
  'insert-shape-bubble', 'insert-table', 'add-table-row', 'add-table-column', 'insert-link',
  'insert-footnote', 'insert-code-block', 'insert-math', 'insert-mermaid',
  'insert-callout-info', 'insert-callout-warning', 'insert-callout-danger',
  'insert-horizontal-rule', 'insert-toc', 'image-small', 'image-medium', 'image-full',
  'image-left', 'image-center', 'image-right', 'replace-image-url', 'replace-image-file',
  'change-shape-rect', 'change-shape-ellipse', 'change-shape-diamond', 'change-shape-arrow',
  'change-shape-bubble',
]);

export function predictConsequences(command: CommandDefinition): ConsequenceLane[] {
  const sourceChange = command.operation.kind === 'editor' && MUTATING_EDITOR_OPERATIONS.has(command.operation.operation);
  const renderChange = sourceChange || command.operation.kind === 'mode';
  const external = command.risk === 'external' || command.risk === 'destructive';
  return [
    {
      id: 'source',
      label: 'Markdown source',
      impact: sourceChange ? 'change' : 'observe',
      detail: sourceChange ? 'The canonical Markdown can change at the active range.' : 'The canonical Markdown is not expected to change.',
    },
    {
      id: 'render',
      label: 'Compiled rendering',
      impact: renderChange ? 'change' : 'observe',
      detail: sourceChange ? 'Affected blocks will be recompiled from source.' : command.operation.kind === 'mode' ? 'The presentation mode changes without rewriting Markdown.' : 'Existing rendered blocks remain authoritative.',
    },
    {
      id: 'collaboration',
      label: 'Collaborators',
      impact: sourceChange ? 'boundary' : 'none',
      detail: sourceChange ? 'An authorized ESBT update can become visible to live peers.' : 'No text operation is expected on the collaboration channel.',
    },
    {
      id: 'durability',
      label: 'Durability',
      impact: sourceChange ? 'boundary' : 'none',
      detail: sourceChange ? 'Completion waits for the existing durable command receipt.' : 'No new source durability receipt is expected.',
    },
    {
      id: 'external',
      label: 'Outside boundary',
      impact: external ? 'boundary' : 'none',
      detail: external ? 'This command can invoke a browser, network, sharing, download, print, or destructive boundary.' : 'The command stays within the current Marks surface.',
    },
  ];
}

function lineCount(value: string): number {
  return value ? value.split('\n').length : 0;
}

export function minimalSourceDelta(before: string, after: string): SourceDelta | null {
  if (before === after) return null;
  let from = 0;
  const limit = Math.min(before.length, after.length);
  while (from < limit && before.charCodeAt(from) === after.charCodeAt(from)) from += 1;
  let suffix = 0;
  while (
    suffix < before.length - from
      && suffix < after.length - from
      && before.charCodeAt(before.length - suffix - 1) === after.charCodeAt(after.length - suffix - 1)
  ) suffix += 1;
  const beforeSegment = before.slice(from, before.length - suffix);
  const afterSegment = after.slice(from, after.length - suffix);
  return {
    from,
    beforeChars: beforeSegment.length,
    afterChars: afterSegment.length,
    beforeLines: lineCount(beforeSegment),
    afterLines: lineCount(afterSegment),
  };
}

export async function reverseCounterfactual(
  documentId: string,
  label: string,
  commandId: string,
  source: CounterfactualPatch['source'],
  before: string,
  after: string,
  now = Date.now(),
): Promise<CounterfactualPatch | null> {
  const delta = minimalSourceDelta(before, after);
  if (!delta) return null;
  const suffixLength = after.length - delta.from - delta.afterChars;
  const expected = after.slice(delta.from, delta.from + delta.afterChars);
  const replacement = before.slice(delta.from, before.length - suffixLength);
  if (expected.length + replacement.length > 512 * 1024) return null;
  return {
    id: `counterfactual:${crypto.randomUUID()}`,
    documentId,
    label: label.slice(0, 160),
    note: 'Automatically captured before a completed source-changing command.',
    createdAt: now,
    updatedAt: now,
    source,
    commandId,
    baseDigest: await digestText(after),
    from: delta.from,
    expected,
    replacement,
    prefix: after.slice(Math.max(0, delta.from - CONTEXT_WINDOW), delta.from),
    suffix: after.slice(delta.from + expected.length, delta.from + expected.length + CONTEXT_WINDOW),
    archived: false,
    appliedAt: null,
  };
}

export async function createCounterfactual(
  documentId: string,
  label: string,
  note: string,
  current: string,
  from: number,
  to: number,
  replacement: string,
  now = Date.now(),
): Promise<CounterfactualPatch> {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > current.length) {
    throw new Error('Select a valid source range for this alternative.');
  }
  if (!label.trim() || label.trim().length > 160) throw new Error('Use a label between 1 and 160 characters.');
  const expected = current.slice(from, to);
  if (expected === replacement) throw new Error('The alternative is identical to the current source.');
  if (expected.length + replacement.length > 512 * 1024) throw new Error('Keep one counterfactual patch under 512 KiB.');
  return {
    id: `counterfactual:${crypto.randomUUID()}`,
    documentId,
    label: label.trim(),
    note: note.trim().slice(0, 1_000),
    createdAt: now,
    updatedAt: now,
    source: 'human',
    commandId: null,
    baseDigest: await digestText(current),
    from,
    expected,
    replacement,
    prefix: current.slice(Math.max(0, from - CONTEXT_WINDOW), from),
    suffix: current.slice(to, to + CONTEXT_WINDOW),
    archived: false,
    appliedAt: null,
  };
}

function uniqueIndex(haystack: string, needle: string): number | null {
  const first = haystack.indexOf(needle);
  if (first < 0 || haystack.indexOf(needle, first + 1) >= 0) return null;
  return first;
}

export function applyCounterfactual(current: string, patch: CounterfactualPatch): { text: string; from: number; rebased: boolean } {
  let from = patch.from;
  const exact = current.slice(from, from + patch.expected.length) === patch.expected;
  if (!exact) {
    if (patch.expected) {
      const candidates: number[] = [];
      let offset = current.indexOf(patch.expected);
      while (offset >= 0 && candidates.length < 3) {
        const prefixMatches = !patch.prefix || current.slice(Math.max(0, offset - patch.prefix.length), offset) === patch.prefix;
        const suffixFrom = offset + patch.expected.length;
        const suffixMatches = !patch.suffix || current.slice(suffixFrom, suffixFrom + patch.suffix.length) === patch.suffix;
        if (prefixMatches && suffixMatches) candidates.push(offset);
        offset = current.indexOf(patch.expected, offset + Math.max(1, patch.expected.length));
      }
      if (candidates.length !== 1) throw new Error('This alternative is stale and has no unique safe source anchor.');
      [from] = candidates;
    } else {
      const context = `${patch.prefix}${patch.suffix}`;
      const contextFrom = context ? uniqueIndex(current, context) : null;
      if (contextFrom === null) throw new Error('This insertion is stale and has no unique safe source anchor.');
      from = contextFrom + patch.prefix.length;
    }
  }
  return {
    text: `${current.slice(0, from)}${patch.replacement}${current.slice(from + patch.expected.length)}`,
    from,
    rebased: from !== patch.from,
  };
}
