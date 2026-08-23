import { readLocalDocumentText } from '../demo/workspace.ts';
import { UI_DATA_MODE } from '../lib/product.ts';
import { loadServiceApi } from '../lib/service-api.ts';

const cache = new Map<string, { expires: number; value: Promise<string> }>();

function loadMarkdown(documentId: string): Promise<string> {
  const current = cache.get(documentId);
  if (current && current.expires > Date.now()) return current.value;
  const value = UI_DATA_MODE === 'service'
    ? loadServiceApi().then((api) => api.downloadDocumentMarkdown(documentId))
    : Promise.resolve(readLocalDocumentText(documentId));
  cache.set(documentId, { expires: Date.now() + 5_000, value });
  value.catch(() => cache.delete(documentId));
  return value;
}

function headingMatch(line: string): { level: number; text: string } | null {
  const match = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line);
  return match ? { level: match[1].length, text: match[2].trim() } : null;
}

export function extractDocumentSection(markdown: string, requestedHeading: string): string | null {
  if (!requestedHeading) return markdown;
  const lines = markdown.split('\n');
  const normalized = requestedHeading.trim().toLocaleLowerCase();
  let start = -1;
  let level = 0;
  let fence: { marker: '`' | '~'; length: number } | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(lines[index]);
    if (marker) {
      const kind = marker[1][0] as '`' | '~';
      if (!fence) fence = { marker: kind, length: marker[1].length };
      else if (fence.marker === kind && marker[1].length >= fence.length) fence = null;
      continue;
    }
    if (fence) continue;
    const heading = headingMatch(lines[index]);
    if (!heading || heading.text.toLocaleLowerCase() !== normalized) continue;
    start = index;
    level = heading.level;
    break;
  }
  if (start < 0) return null;
  let end = lines.length;
  fence = null;
  for (let index = start + 1; index < lines.length; index += 1) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(lines[index]);
    if (marker) {
      const kind = marker[1][0] as '`' | '~';
      if (!fence) fence = { marker: kind, length: marker[1].length };
      else if (fence.marker === kind && marker[1].length >= fence.length) fence = null;
      continue;
    }
    if (fence) continue;
    const heading = headingMatch(lines[index]);
    if (heading && heading.level <= level) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

function paintPlainMarkdown(container: HTMLElement, source: string): void {
  const fragment = document.createDocumentFragment();
  let emitted = 0;
  for (const line of source.split('\n')) {
    if (emitted >= 48) break;
    const value = line.trim();
    if (!value || /^---$/.test(value) || /^ {0,3}(?:```|~~~)/.test(line)) continue;
    const heading = headingMatch(line);
    const element = document.createElement(heading ? 'h4' : 'p');
    element.textContent = heading?.text ?? value.replace(/^\s*(?:[-+*>]|\d+[.)])\s+/, '');
    fragment.append(element);
    emitted += 1;
  }
  if (!emitted) {
    const empty = document.createElement('p');
    empty.textContent = 'The linked section is empty.';
    fragment.append(empty);
  }
  container.replaceChildren(fragment);
}

export async function hydrateCrossDocumentBlocks(root: ParentNode): Promise<void> {
  const blocks = [...root.querySelectorAll<HTMLElement>('.marks-document-block[data-marks-document-block]')];
  await Promise.all(blocks.map(async (block) => {
    if (block.dataset.marksHydrated === 'true') return;
    block.dataset.marksHydrated = 'pending';
    const documentId = block.dataset.marksDocumentBlock;
    const content = block.querySelector<HTMLElement>('.marks-document-block-content');
    if (!documentId || !content) return;
    const hostDocument = block.closest<HTMLElement>('.app[data-doc]')?.dataset.doc;
    if (hostDocument === documentId) {
      content.textContent = 'Circular self-reference withheld.';
      block.dataset.marksHydrated = 'error';
      return;
    }
    try {
      const markdown = await loadMarkdown(documentId);
      if (!block.isConnected) return;
      const section = extractDocumentSection(markdown, block.dataset.marksHeading ?? '');
      if (section === null) {
        content.textContent = 'The linked heading no longer exists.';
        block.dataset.marksHydrated = 'missing';
      } else {
        paintPlainMarkdown(content, section);
        block.dataset.marksHydrated = 'true';
      }
    } catch {
      if (!block.isConnected) return;
      content.textContent = 'This linked section is unavailable to the current workspace.';
      block.dataset.marksHydrated = 'error';
    }
  }));
}
