import { htmlLooksRich, htmlToMarkdown } from './html-to-markdown.ts';
import { hasClipboardRead, hasClipboardWrite } from './platform.ts';

export interface ClipboardPayload {
  text: string;
  markdown?: string;
  html?: string;
}

/**
 * Prefer the richest representation the clipboard actually holds.
 *
 * Order matters: another marks tab writes `text/markdown` first; a browser
 * or Google Docs write `text/html`; everything else is plain text. Returning
 * `null` means "let the native paste path run".
 */
export function markdownFromClipboard(data: DataTransfer): string | null {
  const markdown = data.getData('text/markdown') || data.getData('text/x-markdown');
  if (markdown) return markdown;

  const plain = data.getData('text/plain');
  const html = data.getData('text/html');
  if (html && htmlLooksRich(html, plain)) {
    const converted = htmlToMarkdown(html);
    if (converted) return converted;
  }

  return plain || null;
}

export function isPlainUrl(value: string): boolean {
  return /^https?:\/\/\S+$/i.test(value.trim()) && !value.includes('\n');
}

/**
 * Write several representations. `text/plain` is the compatibility floor;
 * `text/markdown` lets another marks tab paste losslessly; `text/html` is
 * what other editors (and the OS) preview.
 */
export async function writeClipboard(payload: ClipboardPayload): Promise<boolean> {
  if (typeof navigator === 'undefined') return false;

  try {
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
      const items: Record<string, Blob> = {
        'text/plain': new Blob([payload.text], { type: 'text/plain' }),
      };
      if (payload.markdown) {
        items['text/markdown'] = new Blob([payload.markdown], { type: 'text/markdown' });
      }
      if (payload.html) {
        items['text/html'] = new Blob([payload.html], { type: 'text/html' });
      }
      await navigator.clipboard.write([new ClipboardItem(items)]);
      return true;
    }
  } catch {
    // Fall through to writeText. Safari rejects mixed MIME types; Firefox
    // rejects `text/markdown` on some versions.
  }

  if (hasClipboardWrite()) {
    try {
      await navigator.clipboard.writeText(payload.markdown ?? payload.text);
      return true;
    } catch {
      return false;
    }
  }

  return false;
}

/**
 * Synchronous write used from `copy`/`cut` events. The Clipboard API is
 * async and can lose the user-gesture token; `clipboardData.setData` is
 * the reliable path inside those events.
 */
export function writeClipboardEvent(event: ClipboardEvent, payload: ClipboardPayload): boolean {
  const data = event.clipboardData;
  if (!data) return false;
  try {
    data.setData('text/plain', payload.text);
    if (payload.markdown) data.setData('text/markdown', payload.markdown);
    if (payload.html) data.setData('text/html', payload.html);
    event.preventDefault();
    return true;
  } catch {
    return false;
  }
}

export async function readClipboardText(): Promise<string> {
  if (!hasClipboardRead()) return '';
  try {
    return (await navigator.clipboard.readText()) ?? '';
  } catch {
    return '';
  }
}

/** Best-effort markdown from the async Clipboard API (context-menu Paste). */
export async function readClipboardMarkdown(): Promise<string> {
  const clipboard = navigator.clipboard;
  if (!clipboard) return '';

  try {
    if (clipboard.read) {
      const items = await clipboard.read();
      for (const item of items) {
        if (item.types.includes('text/markdown')) {
          return await (await item.getType('text/markdown')).text();
        }
      }
      for (const item of items) {
        if (item.types.includes('text/html')) {
          const html = await (await item.getType('text/html')).text();
          const converted = htmlToMarkdown(html);
          if (converted) return converted;
        }
      }
    }
  } catch {
    // Permission or unsupported type — try plain text.
  }

  return readClipboardText();
}
