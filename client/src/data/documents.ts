import { aboutDocumentMeta, isAboutDocument } from '../content/about';
import { runWithTimeout, SERVICE_REQUEST_TIMEOUT_MS } from '../browser/network.ts';
import type { LocalDocumentDraft } from '../demo/workspace';
import type { DocumentMeta } from '../lib/api';
import { UI_DATA_MODE } from '../lib/product';
import { ServiceError } from '../lib/service-errors';
import { loadServiceApi } from '../lib/service-api.ts';

const DOCUMENT_REPOSITORY_EVENT = 'marks:document-repository-change';
const LOCAL_WORKSPACE_EVENT = 'marks:workspace-change';

function loadWorkspace(): Promise<typeof import('../demo/workspace')> {
  return runWithTimeout(() => import('../demo/workspace'), SERVICE_REQUEST_TIMEOUT_MS);
}

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
  duplicate(id: string, markdown?: string, requestId?: string): Promise<DocumentMeta | null>;
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
        return (await loadWorkspace()).loadLocalDocuments();
      },
      async get(id) {
        return (await loadWorkspace()).getLocalDocument(id);
      },
      async create(draft) {
        return (await loadWorkspace()).createLocalDocument(draft);
      },
      async rename(id, title) {
        return (await loadWorkspace()).renameLocalDocument(id, title);
      },
      async duplicate(id, markdown) {
        return (await loadWorkspace()).duplicateLocalDocument(id, markdown);
      },
      async remove(id) {
        if (isAboutDocument(id)) throw new Error('the built-in About document cannot be trashed');
        (await loadWorkspace()).deleteLocalDocument(id);
      },
      async listTrash() {
        return (await loadWorkspace()).loadLocalTrash();
      },
      async restore(id) {
        return (await loadWorkspace()).restoreLocalDocument(id);
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
        (await loadWorkspace()).purgeLocalDocument(id);
      },
      subscribe(listener) {
        const onChange = () => listener();
        window.addEventListener(LOCAL_WORKSPACE_EVENT, onChange);
        return () => window.removeEventListener(LOCAL_WORKSPACE_EVENT, onChange);
      },
    };
  }

  return {
    mode: 'service',
    async list() {
      const { documents } = await (await loadServiceApi()).listDocuments();
      const about = aboutDocumentMeta();
      return [about, ...documents.filter((document) => !isAboutDocument(document.id))];
    },
    async get(id) {
      if (isAboutDocument(id)) {
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
      const materialized = (await loadWorkspace()).materializeDocumentDraft(draft);
      const { document } = await (await loadServiceApi()).createDocument({
        title: materialized.title,
        markdown: materialized.content,
        requestId: draft?.requestId,
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
    async duplicate(id, _markdown, requestId) {
      try {
        const { document } = await (await loadServiceApi()).duplicateDocument(id, requestId);
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
