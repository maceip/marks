import { useCallback, useEffect, useRef, useState } from 'react';
import { forgetDocumentMeta, readCatalog, writeCatalog } from '../browser/catalog-cache';
import { documentRepository, type LocalDocumentDraft } from '../data/documents';
import type { DocumentMeta } from '../lib/api';
import { copyForUnknownFailure, ServiceError } from '../lib/service-errors';

const POLL_INTERVAL_MS = 8_000;

export interface DocumentsState {
  documents: DocumentMeta[];
  loading: boolean;
  error: string | null;
  stale: boolean;
  refresh: () => Promise<void>;
  create: (draft?: LocalDocumentDraft) => Promise<DocumentMeta>;
  rename: (id: string, title: string) => Promise<DocumentMeta | null>;
  duplicate: (id: string, markdown?: string, requestId?: string) => Promise<DocumentMeta | null>;
  remove: (id: string) => Promise<void>;
}

/**
 * The document index, kept fresh by polling.
 *
 * Local mode reads the browser workspace. Service mode polls the Rust `/v1`
 * index. There is no Node document store.
 */
export function useDocuments(enabled = true): DocumentsState {
  const [documents, setDocuments] = useState<DocumentMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const next = await documentRepository.list();
      if (!mounted.current) return;
      setDocuments(next);
      setError(null);
      setStale(false);
      if (documentRepository.mode === 'service') void writeCatalog(next);
    } catch (cause) {
      if (mounted.current) {
        const copy = cause instanceof ServiceError ? cause.copy : copyForUnknownFailure();
        setError(copy.detail);
      }
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    if (!enabled) {
      setLoading(false);
      return () => {
        mounted.current = false;
      };
    }

    setLoading(true);
    if (documentRepository.mode === 'service') {
      void readCatalog().then((cached) => {
        if (!mounted.current || !cached || cached.length === 0) return;
        setDocuments(cached);
        setStale(true);
        setLoading(false);
      });
    }
    void refresh();

    const unsubscribe = documentRepository.subscribe(() => void refresh());

    const interval =
      documentRepository.mode === 'service'
        ? window.setInterval(() => {
            if (document.visibilityState === 'visible') void refresh();
          }, POLL_INTERVAL_MS)
        : null;
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    if (documentRepository.mode === 'service') {
      document.addEventListener('visibilitychange', onVisible);
    }

    return () => {
      mounted.current = false;
      unsubscribe();
      if (interval !== null) clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, refresh]);

  // Repository mutations emit the subscribed change event themselves. Their
  // returned object is the committed result and must not be held behind a
  // secondary catalog refresh: that read is best-effort UI freshness, and a
  // stalled read after a successful POST must never hide the new slug or turn
  // a committed mutation into an apparent failure.
  const create = useCallback(
    (draft?: LocalDocumentDraft) => documentRepository.create(draft),
    [],
  );

  const rename = useCallback(
    (id: string, title: string) => documentRepository.rename(id, title),
    [],
  );

  const duplicate = useCallback(
    (id: string, markdown?: string, requestId?: string) =>
      documentRepository.duplicate(id, markdown, requestId),
    [],
  );

  const remove = useCallback(
    async (id: string) => {
      await documentRepository.remove(id);
      if (documentRepository.mode === 'service') void forgetDocumentMeta(id);
    },
    [],
  );

  return { documents, loading, error, stale, refresh, create, rename, duplicate, remove };
}
