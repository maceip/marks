import { ABOUT_DOCUMENT } from './marketing-markdown.ts';

export { ABOUT_DOCUMENT } from './marketing-markdown.ts';

/** Canonical built-in route. `/welcome/` opens this page in the real editor. */
export const ABOUT_DOCUMENT_ID = 'about-marks';

export const ABOUT_DOCUMENT_TITLE = 'Google Docs for Markdown';

export function isAboutDocument(id: string | null | undefined): boolean {
  return id === ABOUT_DOCUMENT_ID;
}

/** True when the stored replica is empty or still the old About Marks copy. */
export function aboutMarkdownNeedsRefresh(text: string | null | undefined): boolean {
  const value = text?.trim() ?? '';
  if (value.length === 0) return true;
  if (value.includes(ABOUT_DOCUMENT_TITLE)) return false;
  return /^# About Marks\b/m.test(value) || /```mermaid\s+timeline/.test(value);
}

export function aboutDocumentMeta(now = Date.now()): {
  id: string;
  title: string;
  engine: 'esbt';
  chars: number;
  created_at: number;
  updated_at: number;
} {
  return {
    id: ABOUT_DOCUMENT_ID,
    title: ABOUT_DOCUMENT_TITLE,
    engine: 'esbt',
    chars: ABOUT_DOCUMENT.length,
    created_at: now,
    updated_at: now,
  };
}
