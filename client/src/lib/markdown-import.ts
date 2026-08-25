import { MARKS_MAX_DOCUMENT_UNITS } from '../collab/profile.ts';

export interface MarkdownImportFile {
  name: string;
  size: number;
  text(): Promise<string>;
}

export interface MarkdownImport {
  title: string;
  content: string;
}

export class MarkdownImportError extends Error {
  override name = 'MarkdownImportError';
}

/** Validate before and after decoding: byte size bounds allocation while the
 * shared UTF-16 unit limit is the actual native/Wasm document contract. */
export async function readMarkdownImport(file: MarkdownImportFile): Promise<MarkdownImport> {
  if (!/\.(?:md|markdown)$/iu.test(file.name)) {
    throw new MarkdownImportError('Choose a .md or .markdown file.');
  }
  if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > MARKS_MAX_DOCUMENT_UNITS * 4) {
    throw new MarkdownImportError('The file exceeds the shared document-size policy.');
  }
  const content = (await file.text()).replace(/\r\n?/gu, '\n');
  if (content.length > MARKS_MAX_DOCUMENT_UNITS) {
    throw new MarkdownImportError('The decoded Markdown exceeds the shared document-size policy.');
  }
  const title = file.name.replace(/\.(?:md|markdown)$/iu, '').trim().slice(0, 90)
    || 'Imported Markdown';
  return { title, content };
}
