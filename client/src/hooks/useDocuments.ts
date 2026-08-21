import { useCallback, useEffect, useRef, useState } from 'react';
import type { EngineName } from '../collab/types';
import * as api from '../lib/api';

const POLL_INTERVAL_MS = 8_000;

export interface DocumentsState {
  documents: api.DocumentMeta[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  create: (engine: EngineName) => Promise<api.DocumentMeta>;
  remove: (id: string) => Promise<void>;
}

/**
 * The document index, kept fresh by polling.
 *
 * Titles are derived server-side from each document's first heading, so the
 * list updates a beat after someone edits a heading — no client coordination.
 */
export function useDocuments(): DocumentsState {
  const [documents, setDocuments] = useState<api.DocumentMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const { documents: next } = await api.listDocuments();
      if (!mounted.current) return;
      setDocuments(next);
      setError(null);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : 'Request failed');
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();

    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, POLL_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      mounted.current = false;
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  const create = useCallback(
    async (engine: EngineName) => {
      const { document: created } = await api.createDocument(engine);
      await refresh();
      return created;
    },
    [refresh],
  );

  const remove = useCallback(
    async (id: string) => {
      await api.deleteDocument(id);
      await refresh();
    },
    [refresh],
  );

  return { documents, loading, error, refresh, create, remove };
}
