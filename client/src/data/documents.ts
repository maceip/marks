import { aboutDocumentMeta, isAboutDocument } from '../content/about';
import {
  createLocalDocument,
  deleteLocalDocument,
  duplicateLocalDocument,
  getLocalDocument,
  loadLocalDocuments,
  loadLocalTrash,
  purgeLocalDocument,
  renameLocalDocument,
  restoreLocalDocument,
  seedAboutDocumentText,
  WORKSPACE_EVENT,
  type LocalDocumentDraft,
} from '../demo/workspace';
import type { DocumentMeta } from '../lib/api';
import { UI_DATA_MODE } from '../lib/product';
import { ServiceError } from '../lib/service-errors';
import { loadServiceApi } from '../lib/service-api.ts';

const DOCUMENT_REPOSITORY_EVENT = 'marks:document-repository-change';

export function signalDocumentRepositoryChange(): void {
  window.dispatchEvent(new CustomEvent(DOCUMENT_REPOSITORY_EVENT));
}

export type { LocalDocumentDraft };

export interface DocumentRepository {
  readonly mode: 'local' | 'service';
  list(): Promise<DocumentMeta[]>;
  get(id: string): Promise<DocumentMeta | null>;
  create(draft?: LocalDocumentDraft): Promise<DocumentMeta>;
  rename(id: string, title: string): Promise<DocumentMeta | null>;
  duplicate(id: string, markdown?: string): Promise<DocumentMeta | null>;
  remove(id: string): Promise<void>;
  listTrash(): Promise<DocumentMeta[]>;
  restore(id: string): Promise<DocumentMeta | null>;
  purge(id: string): Promise<void>;
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
        if (isAboutDocument(id)) throw new Error('the built-in About document cannot be trashed');
        deleteLocalDocument(id);
      },
      async listTrash() {
        return loadLocalTrash();
      },
      async restore(id) {
        return restoreLocalDocument(id);
      },
      async purge(id) {
        const [{ purgeLocalReviewMetadata }, { purgeLocalDocumentAssets }] = await Promise.all([
          import('./review'),
          import('./assets'),
        ]);
        await Promise.all([
          purgeLocalReviewMetadata(id),
          purgeLocalDocumentAssets(id),
        ]);
        purgeLocalDocument(id);
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
      const { documents } = await (await loadServiceApi()).listDocuments();
      seedAboutDocumentText();
      const about = aboutDocumentMeta();
      return [about, ...documents.filter((document) => !isAboutDocument(document.id))];
    },
    async get(id) {
      if (isAboutDocument(id)) {
        seedAboutDocumentText();
        return aboutDocumentMeta();
      }
      try {
        const { document } = await (await loadServiceApi()).getDocument(id);
        return document;
      } catch (error) {
        // A server 404 deliberately conflates missing/deleted/unauthorized and
        // is authoritative. Network and 5xx failures are not absence: let the
        // metadata hook preserve its IndexedDB proof so the CRDT can open
        // offline instead of racing a valid cache to `null`.
        if (error instanceof ServiceError && error.status === 404) return null;
        throw error;
      }
    },
    async create(draft) {
      const { document } = await (await loadServiceApi()).createDocument({
        title: draft?.title,
        markdown: draft?.content,
      });
      signalDocumentRepositoryChange();
      return document;
    },
    async rename(id, title) {
      try {
        const { document } = await (await loadServiceApi()).renameDocument(id, title);
        signalDocumentRepositoryChange();
        return document;
      } catch (error) {
        if (error instanceof ServiceError && error.status === 404) return null;
        throw error;
      }
    },
    async duplicate(id) {
      try {
        const { document } = await (await loadServiceApi()).duplicateDocument(id);
        signalDocumentRepositoryChange();
        return document;
      } catch (error) {
        if (error instanceof ServiceError && error.status === 404) return null;
        throw error;
      }
    },
    async remove(id) {
      if (isAboutDocument(id)) throw new Error('the built-in About document cannot be trashed');
      await (await loadServiceApi()).deleteDocument(id);
      signalDocumentRepositoryChange();
    },
    async listTrash() {
      return (await (await loadServiceApi()).listTrash()).documents;
    },
    async restore(id) {
      try {
        const { document } = await (await loadServiceApi()).restoreDocument(id);
        signalDocumentRepositoryChange();
        return document;
      } catch (error) {
        if (error instanceof ServiceError && error.status === 404) return null;
        throw error;
      }
    },
    async purge(id) {
      await (await loadServiceApi()).purgeDocument(id);
      signalDocumentRepositoryChange();
    },
    subscribe(listener) {
      const onChange = () => listener();
      window.addEventListener(DOCUMENT_REPOSITORY_EVENT, onChange);
      return () => window.removeEventListener(DOCUMENT_REPOSITORY_EVENT, onChange);
    },
  };
}

export const documentRepository = createDocumentRepository();
