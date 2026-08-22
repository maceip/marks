/**
 * Browser-only review chrome for the local prototype.
 *
 * This is not the product comment or history plane. Those return through
 * authenticated Marks metadata after ACL admission exists. Nothing here is
 * written into ESBT snapshots or sent as MSG_UPDATE.
 */

export interface ReviewComment {
  id: string;
  documentId: string;
  author: string;
  body: string;
  createdAt: number;
  resolved: boolean;
}

export interface DocumentVersion {
  id: string;
  documentId: string;
  label: string;
  author: string;
  createdAt: number;
  markdown: string;
}

const COMMENT_KEY = 'marks:review-comments:v1';
const VERSION_KEY = 'marks:review-versions:v1';
const REVIEW_EVENT = 'marks:review-change';

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    localStorage.removeItem(key);
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  localStorage.setItem(key, JSON.stringify(value));
  window.dispatchEvent(new CustomEvent(REVIEW_EVENT));
}

function comments(): ReviewComment[] {
  return readJson<ReviewComment[]>(COMMENT_KEY, []);
}

function versions(): DocumentVersion[] {
  return readJson<DocumentVersion[]>(VERSION_KEY, []);
}

export const reviewRepository = {
  async listComments(documentId: string): Promise<ReviewComment[]> {
    return comments()
      .filter((item) => item.documentId === documentId)
      .sort((a, b) => b.createdAt - a.createdAt);
  },

  async addComment(documentId: string, author: string, body: string): Promise<ReviewComment> {
    const item: ReviewComment = {
      id: `comment-${crypto.randomUUID()}`,
      documentId,
      author,
      body: body.trim(),
      createdAt: Date.now(),
      resolved: false,
    };
    writeJson(COMMENT_KEY, [item, ...comments()]);
    return item;
  },

  async setCommentResolved(id: string, resolved: boolean): Promise<void> {
    writeJson(
      COMMENT_KEY,
      comments().map((item) => (item.id === id ? { ...item, resolved } : item)),
    );
  },

  async listVersions(documentId: string, currentText: string): Promise<DocumentVersion[]> {
    const current: DocumentVersion = {
      id: `current-${documentId}`,
      documentId,
      label: 'Current document',
      author: 'This browser',
      createdAt: Date.now(),
      markdown: currentText,
    };
    return [
      current,
      ...versions()
        .filter((item) => item.documentId === documentId)
        .sort((a, b) => b.createdAt - a.createdAt),
    ];
  },

  async createVersion(
    documentId: string,
    author: string,
    label: string,
    markdown: string,
  ): Promise<DocumentVersion> {
    const version: DocumentVersion = {
      id: `version-${crypto.randomUUID()}`,
      documentId,
      label: label.trim() || 'Untitled version',
      author,
      createdAt: Date.now(),
      markdown,
    };
    writeJson(VERSION_KEY, [version, ...versions()]);
    return version;
  },

  subscribe(listener: () => void): () => void {
    const onChange = () => listener();
    window.addEventListener(REVIEW_EVENT, onChange);
    return () => window.removeEventListener(REVIEW_EVENT, onChange);
  },
};
