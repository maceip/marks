import { redo, undo } from '@codemirror/commands';
import { openSearchPanel } from '@codemirror/search';
import type { EditorView } from '@codemirror/view';
import { readClipboardMarkdown, writeClipboard } from '../browser';
import { inspectEditorContext } from './context';
import {
  insertGenerated,
  insertHtmlImage,
  replaceRange,
  type ShapeKind,
} from './commands';

export function runUndo(view: EditorView): boolean {
  return undo(view);
}

export function runRedo(view: EditorView): boolean {
  return redo(view);
}

export function openFind(view: EditorView): boolean {
  return openSearchPanel(view);
}

export async function copySelection(view: EditorView): Promise<boolean> {
  const range = view.state.selection.main;
  if (range.empty) return false;
  const text = view.state.sliceDoc(range.from, range.to);
  return writeClipboard({ text, markdown: text });
}

export async function cutSelection(view: EditorView): Promise<boolean> {
  const range = view.state.selection.main;
  if (range.empty) return false;
  const text = view.state.sliceDoc(range.from, range.to);
  if (!(await writeClipboard({ text, markdown: text }))) return false;
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: '' },
    userEvent: 'delete.cut',
  });
  return true;
}

export async function pasteMarkdown(view: EditorView): Promise<boolean> {
  const text = await readClipboardMarkdown();
  if (text == null) return false;
  const range = view.state.selection.main;
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: text },
    selection: { anchor: range.from + text.length },
    userEvent: 'input.paste',
  });
  return true;
}

export function imageMarkup(url: string, alt: string, width?: number, align?: 'left' | 'center' | 'right'): string {
  if (!width && !align) return `![${alt}](${url})`;
  return `<img src="${url}" alt="${alt}" class="marks-figure"${width ? ` width="${width}"` : ''} data-align="${align ?? 'center'}" />`;
}

export function updateImageAtCursor(
  view: EditorView,
  patch: { alt?: string; url?: string; width?: number; align?: 'left' | 'center' | 'right' },
): boolean {
  const range = view.state.selection.main;
  const context = inspectEditorContext(view.state.doc.toString(), range.from, range.to);
  if (!context.image) return false;
  const next = imageMarkup(
    patch.url ?? context.image.url,
    patch.alt ?? context.image.alt,
    patch.width ?? context.image.width,
    patch.align ?? context.image.align,
  );
  return replaceRange(context.image.from, context.image.to, next)(view);
}

export function insertImageFile(view: EditorView, file: File): Promise<boolean> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = typeof reader.result === 'string' ? reader.result : '';
      if (!url) {
        resolve(false);
        return;
      }
      resolve(insertHtmlImage(url, file.name.replace(/\.[^.]+$/, ''), 480, 'center')(view));
    };
    reader.onerror = () => resolve(false);
    reader.readAsDataURL(file);
  });
}

export function applyShapeLabel(view: EditorView, kind: ShapeKind, label: string): boolean {
  const range = view.state.selection.main;
  const context = inspectEditorContext(view.state.doc.toString(), range.from, range.to);
  if (!context.shape) return false;
  const next = context.shape;
  void kind;
  void label;
  void next;
  return false;
}

export function insertAiResult(view: EditorView, markdown: string, replace: boolean): boolean {
  return insertGenerated(markdown, replace)(view);
}
