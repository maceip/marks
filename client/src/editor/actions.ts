import { redo, undo } from '@codemirror/commands';
import { openSearchPanel } from '@codemirror/search';
import type { EditorView } from '@codemirror/view';
import type { CollabSession, StableTextRange } from '../collab/types';
import { readClipboardMarkdown, writeClipboard } from '../browser';
import { inspectEditorContext } from './context';
import { assetRepository } from '../data/assets';
import {
  insertGenerated,
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

export async function insertImageFile(
  view: EditorView,
  session: CollabSession,
  file: File,
): Promise<boolean> {
  const range = view.state.selection.main;
  return insertImageFilesAtRange(session, [file], session.captureTextRange(range.from, range.to));
}

export async function insertImageFilesAtRange(
  session: CollabSession,
  files: readonly File[],
  stableRange: StableTextRange,
): Promise<boolean> {
  if (!session.capabilities().edit) throw new Error('Your current role cannot insert images.');
  const bounded = files.slice(0, 8);
  if (bounded.length === 0) return false;
  const results = await Promise.allSettled(
    bounded.map((file) => assetRepository.upload(session.docId, file)),
  );
  const markup = results.flatMap((result, index) => {
    if (result.status !== 'fulfilled') return [];
    const alt = bounded[index].name
      .replace(/\.[^.]+$/, '')
      .replace(/[\\\]]/gu, '\\$&');
    return [imageMarkup(result.value.url, alt)];
  });
  if (markup.length === 0) {
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    throw failure?.reason instanceof Error ? failure.reason : new Error('No supported image was uploaded.');
  }
  if (!session.capabilities().edit) throw new Error('Edit access changed before the upload completed.');
  const current = session.resolveTextRange(stableRange);
  session.replaceRange(current.from, current.to, markup.join('\n\n'));
  if (markup.length !== bounded.length) {
    throw new Error(`${markup.length} of ${bounded.length} images were inserted; the others were refused.`);
  }
  return true;
}

export function imageFilesFromTransfer(transfer: DataTransfer | null): File[] {
  if (!transfer) return [];
  return [...transfer.files].filter((file) =>
    file.type.startsWith('image/') || /\.(?:png|jpe?g|gif|webp)$/iu.test(file.name),
  );
}

export function handleImageTransfer(
  event: ClipboardEvent | DragEvent,
  view: EditorView,
  session: CollabSession,
  onError?: (error: Error) => void,
): boolean {
  const transfer = event instanceof ClipboardEvent ? event.clipboardData : event.dataTransfer;
  const files = imageFilesFromTransfer(transfer);
  if (files.length === 0) return false;
  const selection = view.state.selection.main;
  const dropPosition = event instanceof DragEvent
    ? view.posAtCoords({ x: event.clientX, y: event.clientY })
    : null;
  const from = dropPosition ?? selection.from;
  const to = dropPosition == null ? selection.to : from;
  const range = session.captureTextRange(from, to);
  event.preventDefault();
  void insertImageFilesAtRange(session, files, range).catch((error) => {
    onError?.(error instanceof Error ? error : new Error('The image upload failed.'));
  });
  return true;
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

export function insertDraftToolResult(view: EditorView, markdown: string, replace: boolean): boolean {
  return insertGenerated(markdown, replace)(view);
}
