import type { ProjectedCommand } from '../commands/types.ts';

export interface AgentPlanStep {
  id: string;
  commandId: string;
  input: Record<string, unknown>;
  reason: string;
}

export interface AgentPlan {
  request: string;
  steps: AgentPlanStep[];
  message: string;
}

interface Pattern {
  commandId: string;
  expressions: RegExp[];
  reason: string;
}

const PATTERNS: Pattern[] = [
  { commandId: 'view.preview', expressions: [/\b(?:rendered?|preview|reading)\s+(?:view|mode)\b/i, /\bshow (?:me )?(?:the )?(?:rendered?|preview)\b/i], reason: 'Switch to the compiled rendering.' },
  { commandId: 'view.split', expressions: [/\bsplit\s+(?:view|mode)\b/i, /\bshow (?:source|markdown).*(?:and|with).*(?:preview|render)/i], reason: 'Show source and rendering together.' },
  { commandId: 'view.editor', expressions: [/\b(?:raw|source|editor|markdown)\s+(?:view|mode)\b/i, /\bshow (?:me )?(?:the )?(?:raw )?(?:source|markdown)\b/i], reason: 'Switch to the raw Markdown editor.' },
  { commandId: 'format.bold', expressions: [/\bbold(?:face)?\b/i, /\bstrong emphasis\b/i], reason: 'Apply strong emphasis to the selection.' },
  { commandId: 'format.italic', expressions: [/\bitalic(?:ize)?\b/i, /\bemphasi[sz]e\b/i], reason: 'Apply emphasis to the selection.' },
  { commandId: 'format.underline', expressions: [/\bunderline\b/i], reason: 'Apply the underline extension.' },
  { commandId: 'format.strikethrough', expressions: [/\bstrike(?:through| out)?\b/i], reason: 'Apply strikethrough.' },
  { commandId: 'format.highlight', expressions: [/\bhighlight\b/i, /\bmark this\b/i], reason: 'Highlight the selection.' },
  { commandId: 'format.inline-code', expressions: [/\binline code\b/i, /\bcode formatting\b/i], reason: 'Format the selection as inline code.' },
  { commandId: 'format.heading-1', expressions: [/\b(?:heading|h)\s*1\b/i, /\btop[- ]level heading\b/i], reason: 'Apply Heading 1.' },
  { commandId: 'format.heading-2', expressions: [/\b(?:heading|h)\s*2\b/i, /\bmake (?:this|it) a heading\b/i], reason: 'Apply Heading 2.' },
  { commandId: 'format.heading-3', expressions: [/\b(?:heading|h)\s*3\b/i], reason: 'Apply Heading 3.' },
  { commandId: 'format.heading-4', expressions: [/\b(?:heading|h)\s*4\b/i], reason: 'Apply Heading 4.' },
  { commandId: 'paragraph.bullets', expressions: [/\b(?:bullet|unordered) list\b/i], reason: 'Convert the active lines to a bulleted list.' },
  { commandId: 'paragraph.numbered', expressions: [/\b(?:numbered|ordered) list\b/i], reason: 'Convert the active lines to a numbered list.' },
  { commandId: 'paragraph.tasks', expressions: [/\b(?:task|check(?:box|list))\s*(?:list)?\b/i], reason: 'Convert the active lines to tasks.' },
  { commandId: 'paragraph.quote', expressions: [/\b(?:block )?quote\b/i], reason: 'Format the active lines as a quote.' },
  { commandId: 'insert.table', expressions: [/\b(?:insert|add|create|make) (?:a )?table\b/i], reason: 'Insert a Markdown table.' },
  { commandId: 'insert.link', expressions: [/\b(?:insert|add|create|make) (?:a )?link\b/i, /\blink (?:this|the selection)\b/i], reason: 'Insert or wrap a Markdown link.' },
  { commandId: 'insert.picture-url', expressions: [/\b(?:insert|add) (?:an? )?(?:image|picture)(?: from)? (?:https?:\/\/|url)/i], reason: 'Insert an image URL.' },
  { commandId: 'insert.picture-file', expressions: [/\b(?:upload|choose) (?:an? )?(?:image|picture|photo)\b/i], reason: 'Open the image picker.' },
  { commandId: 'insert.code-block', expressions: [/\b(?:insert|add|create) (?:a )?(?:code block|fence)\b/i], reason: 'Insert a fenced code block.' },
  { commandId: 'insert.math', expressions: [/\b(?:insert|add) (?:a )?(?:math|latex|equation)\b/i], reason: 'Insert a display-math block.' },
  { commandId: 'insert.mermaid', expressions: [/\b(?:insert|add|create) (?:a )?(?:mermaid|diagram|flowchart)\b/i], reason: 'Insert a Mermaid diagram.' },
  { commandId: 'insert.callout-info', expressions: [/\b(?:insert|add|create) (?:an? )?(?:info )?(?:callout|admonition)\b/i], reason: 'Insert an informational callout.' },
  { commandId: 'review.comments', expressions: [/\b(?:open|show|view) comments?\b/i], reason: 'Open anchored review comments.' },
  { commandId: 'review.history', expressions: [/\b(?:open|show|view) (?:version )?history\b/i], reason: 'Open version history.' },
  { commandId: 'view.outline', expressions: [/\b(?:open|show|toggle) (?:the )?outline\b/i], reason: 'Toggle the document outline.' },
  { commandId: 'view.focus', expressions: [/\b(?:enter|toggle|use) focus(?: mode)?\b/i], reason: 'Toggle focus mode.' },
  { commandId: 'document.export-bundle', expressions: [/\b(?:download|export).*(?:bundle|zip|assets?)\b/i], reason: 'Export Markdown with referenced assets.' },
  { commandId: 'document.export-markdown', expressions: [/\b(?:download|export).*(?:markdown|\.md|source)\b/i], reason: 'Export the Markdown source.' },
  { commandId: 'document.print', expressions: [/\b(?:print|save as pdf)\b/i], reason: 'Open the print/PDF surface.' },
  { commandId: 'document.share', expressions: [/\b(?:open|show|manage|create).*(?:share|access|viewer link)\b/i, /\bshare (?:this|the) document\b/i], reason: 'Open document access controls.' },
  { commandId: 'identity.pairing', expressions: [/\b(?:pair|link|confirm).*(?:phone|device)\b/i, /\bqr code\b/i], reason: 'Open phone confirmation.' },
  { commandId: 'document.delete', expressions: [/\b(?:delete|trash|remove) (?:this|the) document\b/i], reason: 'Move the document to recoverable trash.' },
  { commandId: 'edit.find', expressions: [/\b(?:find|search for)\b/i], reason: 'Open source search.' },
];

export function planAgentRequest(request: string, commands: readonly ProjectedCommand[]): AgentPlan {
  const available = new Map(commands.map((command) => [command.id, command]));
  const candidates: Array<{ index: number; pattern: Pattern; match: RegExpExecArray }> = [];
  for (const pattern of PATTERNS) {
    for (const expression of pattern.expressions) {
      const match = expression.exec(request);
      if (match) {
        candidates.push({ index: match.index, pattern, match });
        break;
      }
    }
  }
  candidates.sort((a, b) => a.index - b.index);
  const seen = new Set<string>();
  const steps = candidates.flatMap(({ pattern }) => {
    if (seen.has(pattern.commandId)) return [];
    const command = available.get(pattern.commandId);
    if (!command) return [];
    seen.add(pattern.commandId);
    const input: Record<string, unknown> = {};
    if (pattern.commandId === 'insert.picture-url') {
      const url = request.match(/https?:\/\/[^\s<>)\]]+/i)?.[0];
      if (url) input.url = url;
      const alt = /(?:alt|called|described as)\s+["“]([^"”]+)["”]/i.exec(request)?.[1];
      if (alt) input.alt = alt;
    }
    return [{
      id: `${pattern.commandId}:${seen.size}`,
      commandId: pattern.commandId,
      input,
      reason: pattern.reason,
    }];
  });

  if (steps.length === 0) {
    const fuzzy = fuzzyCommand(request, commands);
    if (fuzzy) {
      steps.push({ id: `${fuzzy.id}:1`, commandId: fuzzy.id, input: {}, reason: fuzzy.description });
    }
  }

  return {
    request,
    steps,
    message: steps.length
      ? `${steps.length} ribbon command${steps.length === 1 ? '' : 's'} matched. Watch the relevant controls as they run.`
      : 'I could not map that request to a safe Marks command. Try naming a view, format, insert, review, export, or identity action.',
  };
}

function fuzzyCommand(request: string, commands: readonly ProjectedCommand[]): ProjectedCommand | null {
  const words = new Set(request.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  if (words.size === 0 || /\b(?:help|what can|how do|explain)\b/i.test(request)) return null;
  let best: { command: ProjectedCommand; score: number } | null = null;
  for (const command of commands) {
    const haystack = `${command.id} ${command.label} ${command.description} ${(command.aliases ?? []).join(' ')}`.toLowerCase();
    let score = 0;
    for (const word of words) {
      if (word.length >= 3 && haystack.includes(word)) score += word.length;
    }
    if (score >= 6 && (!best || score > best.score)) best = { command, score };
  }
  return best?.command ?? null;
}
