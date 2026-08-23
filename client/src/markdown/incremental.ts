import { hashString } from './blocks.ts';

export interface SourceBlock {
  start: number;
  end: number;
  source: string;
  key: string;
}

const GLOBAL_DEF = /^(?:\s{0,3}(?:\[[^\]]+\]:|\*\[.+?\]:|\[\^.+?\]:))/;

function isFence(line: string): { close: string } | null {
  const match = /^( {0,3})(`{3,}|~{3,})/.exec(line);
  if (!match) return null;
  return { close: match[2][0].repeat(match[2].length) };
}

function isListStart(line: string): boolean {
  return /^( {0,3})(?:[-+*] |\d+[.)] )/.test(line);
}

/**
 * Split markdown into top-level source blocks without parsing.
 *
 * Fences, lists, and blank-line paragraphs stay whole so a one-word edit
 * dirties one block. This is the incremental-parse unit; document-global
 * definitions still force a full markdown-it pass.
 */
export function splitSourceBlocks(text: string): SourceBlock[] {
  const lines = text.split('\n');
  const blocks: SourceBlock[] = [];
  let index = 0;
  const seen = new Map<string, number>();

  const push = (start: number, end: number): void => {
    const source = lines.slice(start, end).join('\n');
    if (start === end && source.length === 0 && blocks.length > 0) return;
    const base = hashString(source);
    const occurrence = (seen.get(base) ?? 0) + 1;
    seen.set(base, occurrence);
    blocks.push({
      start,
      end,
      source,
      key: occurrence === 1 ? base : `${base}~${occurrence}`,
    });
  };

  while (index < lines.length) {
    const line = lines[index];
    if (line.trim() === '') {
      index += 1;
      continue;
    }

    const start = index;
    const fence = isFence(line);
    if (fence) {
      index += 1;
      while (index < lines.length && !new RegExp(`^ {0,3}${fence.close}`).test(lines[index])) {
        index += 1;
      }
      if (index < lines.length) index += 1;
      push(start, index);
      continue;
    }

    if (isListStart(line)) {
      index += 1;
      while (index < lines.length) {
        const next = lines[index];
        if (next.trim() === '') {
          const ahead = lines[index + 1] ?? '';
          if (isListStart(ahead) || /^( {1,}|$)/.test(ahead)) {
            index += 1;
            continue;
          }
          break;
        }
        if (isFence(next) || /^( {0,3}#{1,6} )/.test(next)) break;
        index += 1;
      }
      push(start, index);
      continue;
    }

    index += 1;
    while (index < lines.length) {
      const next = lines[index];
      if (next.trim() === '' || isFence(next) || isListStart(next) || /^( {0,3}#{1,6} )/.test(next)) {
        break;
      }
      index += 1;
    }
    push(start, index);
  }

  if (blocks.length === 0 && text.length > 0) {
    push(0, lines.length);
  }

  return blocks;
}

export function globalDefinitionSignature(text: string): string {
  const defs = text
    .split('\n')
    .filter((line) => GLOBAL_DEF.test(line))
    .join('\n');
  return hashString(defs);
}

export function headingSources(text: string): string[] {
  return text.split('\n').filter((line) => /^ {0,3}#{1,6}\s+\S/.test(line));
}

export function incrementalParseSafe(
  previous: string,
  next: string,
  dirtyRatioLimit = 0.35,
): { dirty: SourceBlock[]; previousBlocks: SourceBlock[]; nextBlocks: SourceBlock[]; safe: boolean } {
  const previousBlocks = splitSourceBlocks(previous);
  const nextBlocks = splitSourceBlocks(next);
  const previousKeys = new Set(previousBlocks.map((block) => block.key));
  const dirty = nextBlocks.filter((block) => !previousKeys.has(block.key));
  const globalsUnchanged = globalDefinitionSignature(previous) === globalDefinitionSignature(next);
  const headingsUnchanged =
    headingSources(previous).join('\0') === headingSources(next).join('\0');
  const dirtyRatio = nextBlocks.length === 0 ? 0 : dirty.length / nextBlocks.length;
  return {
    dirty,
    previousBlocks,
    nextBlocks,
    safe: globalsUnchanged && headingsUnchanged && dirtyRatio <= dirtyRatioLimit && dirty.length > 0,
  };
}
