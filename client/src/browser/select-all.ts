/**
 * Scoped Select All.
 *
 * The browser's default Ctrl/Cmd-A selects the whole page, chrome included.
 * Inside the editor CodeMirror already owns the binding. Inside the preview
 * (and when focus is on a toolbar button) we select only the document.
 */

export type Surface = 'editor' | 'preview' | 'chrome';

export function surfaceForEvent(target: EventTarget | null): Surface {
  if (typeof Element === 'undefined' || !(target instanceof Element)) return 'chrome';
  if (target.closest('.cm-editor, .editor-host, .editor-pane')) return 'editor';
  if (target.closest('.marks-preview, .preview-pane')) return 'preview';
  if (target.closest('input, textarea, [contenteditable="true"]')) return 'chrome';
  return 'chrome';
}

export function selectElementContents(element: HTMLElement): boolean {
  const selection = document.getSelection();
  if (!selection) return false;
  const range = document.createRange();
  range.selectNodeContents(element);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

export function previewHasSelection(preview: HTMLElement | null): boolean {
  if (!preview) return false;
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
  const node = selection.anchorNode;
  return Boolean(node && preview.contains(node));
}

/**
 * True when this keydown should be handled as a document-scoped Select All
 * rather than left to the browser.
 */
export interface SelectAllKey {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  target: EventTarget | null;
}

export function shouldHandleSelectAll(event: SelectAllKey, lastSurface: Surface): boolean {
  const mod = event.metaKey || event.ctrlKey;
  if (!mod || event.altKey || event.shiftKey) return false;
  if (event.key.toLowerCase() !== 'a') return false;

  const surface = surfaceForEvent(event.target);
  if (surface === 'editor') return false;
  if (surface === 'preview') return true;
  return lastSurface === 'preview';
}
