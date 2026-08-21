/**
 * Comments anchored to a source range.
 *
 * The CRDT is the source of truth — comments live in a map on the same
 * document as the markdown, so they sync, work offline, and survive a
 * merge. Offsets still drift when people edit around them; we store a
 * quote plus optional engine-specific cursors so a comment can find its
 * way back after an edit.
 */

export const COMMENTS_MAP = 'comments';
export const COMMENT_ORIGIN = 'comments';

export interface CommentRecord {
  id: string;
  body: string;
  author: string;
  colorIndex: number;
  createdAt: number;
  resolved: boolean;
  /** Source offsets last known to be correct. */
  from: number;
  to: number;
  /** Selected markdown at creation, used to re-find the range. */
  quote: string;
  /** Engine-encoded start cursor (Loro Cursor / Yjs relative position). */
  startCursor?: string;
  endCursor?: string;
}

export function createCommentId(): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `c_${Date.now().toString(36)}_${rand}`;
}

export function parseComment(value: unknown): CommentRecord | null {
  if (!value) return null;

  let raw: unknown = value;
  if (typeof value === 'string') {
    try {
      raw = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  if (!raw || typeof raw !== 'object') return null;

  const record = raw as Partial<CommentRecord>;
  if (typeof record.id !== 'string' || typeof record.body !== 'string') return null;
  if (typeof record.author !== 'string') return null;

  return {
    id: record.id,
    body: record.body,
    author: record.author,
    colorIndex: typeof record.colorIndex === 'number' ? record.colorIndex : 1,
    createdAt: typeof record.createdAt === 'number' ? record.createdAt : 0,
    resolved: Boolean(record.resolved),
    from: typeof record.from === 'number' ? record.from : 0,
    to: typeof record.to === 'number' ? record.to : 0,
    quote: typeof record.quote === 'string' ? record.quote : '',
    startCursor: typeof record.startCursor === 'string' ? record.startCursor : undefined,
    endCursor: typeof record.endCursor === 'string' ? record.endCursor : undefined,
  };
}

export function serializeComment(comment: CommentRecord): string {
  return JSON.stringify(comment);
}

export function readCommentMap(values: Iterable<[string, unknown]>): CommentRecord[] {
  const comments: CommentRecord[] = [];
  for (const [key, value] of values) {
    const parsed = parseComment(value);
    if (parsed) comments.push({ ...parsed, id: parsed.id || key });
  }
  comments.sort((a, b) => a.createdAt - b.createdAt || a.from - b.from);
  return comments;
}

/**
 * Re-attach a comment to the current source.
 *
 * 1. Trust the stored offsets if the quote still sits there.
 * 2. Otherwise search for the quote.
 * 3. Otherwise clamp to the document so a highlight does not throw.
 *
 * Returns `null` only when the document is empty.
 */
export function resolveCommentRange(
  comment: Pick<CommentRecord, 'from' | 'to' | 'quote'>,
  text: string,
): { from: number; to: number } | null {
  if (text.length === 0) return null;

  const from = Math.max(0, Math.min(comment.from, text.length));
  const to = Math.max(from, Math.min(comment.to, text.length));

  if (comment.quote && from < to && text.slice(from, to) === comment.quote) {
    return { from, to };
  }

  if (comment.quote) {
    const index = text.indexOf(comment.quote);
    if (index >= 0) return { from: index, to: index + comment.quote.length };
  }

  if (from < text.length) return { from, to: Math.max(from + 1, to) };
  return { from: Math.max(0, text.length - 1), to: text.length };
}

export function encodeBytes(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeBytes(value: string): Uint8Array | null {
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

export function openComments(comments: CommentRecord[]): CommentRecord[] {
  return comments.filter((comment) => !comment.resolved);
}
