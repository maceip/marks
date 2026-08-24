/**
 * Deterministic local Markdown drafting tools.
 *
 * These are deliberately not presented as AI: each transformation is a
 * small, inspectable rule with no model call, network request, or probabilistic
 * output. A future model integration should be a separate capability.
 */

export const DRAFT_TOOL_MODES = [
  'compose',
  'rewrite',
  'shorten',
  'expand',
  'summarize',
  'outline',
  'continue',
] as const;

export type DraftToolMode = (typeof DRAFT_TOOL_MODES)[number];

export interface DraftToolRequest {
  mode: DraftToolMode;
  source: string;
  instruction?: string;
  title?: string;
}

export interface DraftToolResult {
  markdown: string;
  replace: boolean;
  note: string;
}

const SENTENCE = /[^.!?]+[.!?]+|[^.!?]+$/g;

export function applyDraftTool({ mode, source, instruction, title }: DraftToolRequest): DraftToolResult {
  const text = source.trim();
  const hint = instruction?.trim();

  switch (mode) {
    case 'summarize':
      return {
        markdown: summarize(text, title),
        replace: false,
        note: 'Local summary of headings and opening sentences.',
      };
    case 'outline':
      return {
        markdown: outline(text, title),
        replace: false,
        note: 'Local outline extracted from the current page.',
      };
    case 'shorten':
      return {
        markdown: shorten(text || hint || ''),
        replace: Boolean(text),
        note: 'Kept the opening sentences. No model was called.',
      };
    case 'expand':
      return {
        markdown: expand(text || hint || title || 'Untitled'),
        replace: Boolean(text),
        note: 'Expanded into a structured stub you can rewrite.',
      };
    case 'rewrite':
      return {
        markdown: rewrite(text || hint || ''),
        replace: Boolean(text),
        note: 'Tidied locally: spacing, emphasis, and list markers.',
      };
    case 'continue':
      return {
        markdown: continueDraft(text, title),
        replace: false,
        note: 'A next-step paragraph based on the last section.',
      };
    default:
      return {
        markdown: composeDraft(hint || title || 'Untitled thought'),
        replace: false,
        note: 'A local draft skeleton. Connect a model later to fill it.',
      };
  }
}

function sentences(text: string): string[] {
  return (text.match(SENTENCE) ?? []).map((part) => part.trim()).filter(Boolean);
}

function headings(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => /^#{1,6}\s+\S/.test(line))
    .map((line) => line.replace(/^#{1,6}\s+/, '').trim());
}

function summarize(text: string, title?: string): string {
  const names = headings(text);
  const opens = sentences(text.replace(/^#{1,6}\s+.+$/gm, '')).slice(0, 4);
  const lines = [
    `## Summary${title ? ` — ${title}` : ''}`,
    '',
    ...(names.length ? names.map((name) => `- ${name}`) : []),
    ...(names.length && opens.length ? [''] : []),
    ...opens,
  ];
  return `${lines.join('\n').trim()}\n`;
}

function outline(text: string, title?: string): string {
  const names = headings(text);
  if (names.length) {
    return `## Outline\n\n${names.map((name, index) => `${index + 1}. ${name}`).join('\n')}\n`;
  }
  const points = sentences(text)
    .slice(0, 6)
    .map((sentence) => sentence.replace(/[.!?]$/, ''));
  const seed = points.length ? points : [title || 'Opening', 'Evidence', 'Decision'];
  return `## Outline\n\n${seed.map((item, index) => `${index + 1}. ${item}`).join('\n')}\n`;
}

function shorten(text: string): string {
  const parts = sentences(text);
  if (parts.length <= 2) return text;
  return `${parts.slice(0, Math.max(2, Math.ceil(parts.length * 0.4))).join(' ')}\n`;
}

function expand(seed: string): string {
  const title = seed.split('\n')[0].replace(/^#+\s*/, '').slice(0, 80) || 'Untitled';
  return `# ${title}

## Why this matters

${seed}

## What we know

- The current draft is a starting point
- The next pass should add evidence and a decision

## Open questions

- What would change our mind?
- What is the smallest complete version?

## Next step

Write the paragraph a collaborator could act on.
`;
}

function rewrite(text: string): string {
  return `${text
    .replace(/\t/g, '  ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^(\s*)[-*]\s+/gm, '$1- ')
    .replace(/\b(i)\b/g, 'I')
    .trim()}\n`;
}

function continueDraft(text: string, title?: string): string {
  const last = sentences(text).at(-1) || title || 'the current thought';
  return `\nThe next move is to make “${last.replace(/[.!?]$/, '')}” concrete: name the owner, the proof, and the first thing a reader can do.\n`;
}

function composeDraft(topic: string): string {
  return `# ${topic}

## Intent

What should be true after someone reads this.

## Notes

- 
- 

## Draft

Write here. Draft tools can clean spacing, shorten sentences, or extract an outline locally.
`;
}
