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
  shapePath,
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

export async function replaceImageFileAtCursor(
  view: EditorView,
  session: CollabSession,
  file: File,
): Promise<boolean> {
  const selection = view.state.selection.main;
  const context = inspectEditorContext(view.state.doc.toString(), selection.from, selection.to);
  if (!context.image) throw new Error('Select an image before choosing a replacement.');
  const expected = view.state.sliceDoc(context.image.from, context.image.to);
  const stableRange = session.captureTextRange(context.image.from, context.image.to);
  const asset = await assetRepository.upload(session.docId, file);
  if (!session.capabilities().edit) throw new Error('Edit access changed before the upload completed.');
  const resolved = session.resolveTextRange(stableRange);
  const current = session.getText().slice(resolved.from, resolved.to);
  if (current !== expected) {
    throw new Error('The selected image changed while its replacement was uploading. Select it and try again.');
  }
  session.replaceRange(
    resolved.from,
    resolved.to,
    imageMarkup(
      asset.url,
      context.image.alt || file.name.replace(/\.[^.]+$/, ''),
      context.image.width,
      context.image.align,
    ),
  );
  return true;
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
  const source = view.state.sliceDoc(context.shape.from, context.shape.to);
  const withKind = /data-shape=["'][^"']*["']/i.test(source)
    ? source.replace(/data-shape=["'][^"']*["']/i, `data-shape="${kind}"`)
    : source.replace(/<figure\b/i, `<figure data-shape="${kind}"`);
  const withPath = withKind.replace(
    /(<svg\b[^>]*>)[\s\S]*?(<\/svg>)/i,
    `$1${shapePath(kind)}$2`,
  );
  const next = label === context.shape.label
    ? withPath
    : withPath.replace(
      /(<figcaption>)[\s\S]*?(<\/figcaption>)/i,
      `$1${escapeHtml(label)}$2`,
    );
  return replaceRange(context.shape.from, context.shape.to, next)(view);
}

export interface MarkdownFormatSample {
  inline: string[];
  linePrefix?: string;
}

const INLINE_MARKERS = ['**', '~~', '++', '==', '`', '*'] as const;

export function captureMarkdownFormatting(view: EditorView): MarkdownFormatSample | null {
  const range = view.state.selection.main;
  if (range.empty) return null;
  const selected = view.state.sliceDoc(range.from, range.to);
  const inline: string[] = [];
  for (const marker of INLINE_MARKERS) {
    const wrappedSelection = selected.startsWith(marker) && selected.endsWith(marker) && selected.length > marker.length * 2;
    const wrappedOutside = view.state.sliceDoc(Math.max(0, range.from - marker.length), range.from) === marker &&
      view.state.sliceDoc(range.to, Math.min(view.state.doc.length, range.to + marker.length)) === marker;
    if (wrappedSelection || wrappedOutside) inline.push(marker);
  }
  const line = view.state.doc.lineAt(range.from);
  const linePrefix = /^(\s{0,3}(?:#{1,6}\s+|>\s+|(?:[-*+] |\d+\. )(?:\[[ xX]\] )?))/.exec(line.text)?.[1];
  return inline.length || linePrefix ? { inline, linePrefix } : { inline: [] };
}

export function applyMarkdownFormatting(view: EditorView, sample: MarkdownFormatSample): boolean {
  const range = view.state.selection.main;
  if (range.empty) return false;
  const changes: Array<{ from: number; to: number; insert: string }> = [];
  const prefix = sample.inline.join('');
  const suffix = [...sample.inline].reverse().join('');
  if (prefix || suffix) {
    changes.push({ from: range.from, to: range.from, insert: prefix });
    changes.push({ from: range.to, to: range.to, insert: suffix });
  }
  if (sample.linePrefix) {
    let position = view.state.doc.lineAt(range.from).from;
    const endLine = view.state.doc.lineAt(range.to).number;
    while (position <= view.state.doc.length) {
      const line = view.state.doc.lineAt(position);
      const existing = /^(\s{0,3}(?:#{1,6}\s+|>\s+|(?:[-*+] |\d+\. )(?:\[[ xX]\] )?))/.exec(line.text)?.[1];
      changes.push({ from: line.from, to: line.from + (existing?.length ?? 0), insert: sample.linePrefix });
      if (line.number >= endLine || line.to >= view.state.doc.length) break;
      position = line.to + 1;
    }
  }
  if (changes.length === 0) return false;
  view.dispatch({ changes, userEvent: 'input.format-painter' });
  view.focus();
  return true;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function insertDraftToolResult(view: EditorView, markdown: string, replace: boolean): boolean {
  return insertGenerated(markdown, replace)(view);
}
