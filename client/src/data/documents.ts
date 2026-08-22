import {
  createLocalDocument,
  deleteLocalDocument,
  duplicateLocalDocument,
  getLocalDocument,
  loadLocalDocuments,
  renameLocalDocument,
  WORKSPACE_EVENT,
  type LocalDocumentDraft,
} from '../demo/workspace';
import {
  createDocument as createRemoteDocument,
  deleteDocument,
  duplicateDocument,
  getDocument,
  listDocuments,
  renameDocument,
  type DocumentMeta,
} from '../lib/api';
import { UI_DATA_MODE } from '../lib/product';

export type { LocalDocumentDraft };

export interface DocumentRepository {
  readonly mode: 'local' | 'service';
  list(): Promise<DocumentMeta[]>;
  get(id: string): Promise<DocumentMeta | null>;
  create(draft?: LocalDocumentDraft): Promise<DocumentMeta>;
  rename(id: string, title: string): Promise<DocumentMeta | null>;
  duplicate(id: string, markdown?: string): Promise<DocumentMeta | null>;
  remove(id: string): Promise<void>;
  subscribe(listener: () => void): () => void;
}

/**
 * One document index for the product. Local mode uses the browser workspace.
 * Service mode talks to the Rust `/v1` API. There is no Node adapter.
 */
function createDocumentRepository(): DocumentRepository {
  if (UI_DATA_MODE === 'local') {
    return {
      mode: 'local',
      async list() {
        return loadLocalDocuments();
      },
      async get(id) {
        return getLocalDocument(id);
      },
      async create(draft) {
        return createLocalDocument(draft);
      },
      async rename(id, title) {
        return renameLocalDocument(id, title);
      },
      async duplicate(id, markdown) {
        return duplicateLocalDocument(id, markdown);
      },
      async remove(id) {
        deleteLocalDocument(id);
      },
      subscribe(listener) {
        const onChange = () => listener();
        window.addEventListener(WORKSPACE_EVENT, onChange);
        return () => window.removeEventListener(WORKSPACE_EVENT, onChange);
      },
    };
  }

  return {
    mode: 'service',
    async list() {
      const { documents } = await listDocuments();
      return documents;
    },
    async get(id) {
      try {
        const { document } = await getDocument(id);
        return document;
      } catch {
        return null;
      }
    },
    async create(draft) {
      const { document } = await createRemoteDocument({ title: draft?.title });
      return document;
    },
    async rename(id, title) {
      try {
        const { document } = await renameDocument(id, title);
        return document;
      } catch {
        return null;
      }
    },
    async duplicate(id) {
      try {
        const { document } = await duplicateDocument(id);
        return document;
      } catch {
        return null;
      }
    },
    async remove(id) {
      await deleteDocument(id);
    },
    subscribe() {
      return () => {};
    },
  };
}

export const documentRepository = createDocumentRepository();
