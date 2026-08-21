import { useEffect, useState } from 'react';
import { readDocumentMeta, writeDocumentMeta } from '../browser/catalog-cache';
import type { EngineName } from '../collab/types';
import { getDocument, type DocumentMeta } from '../lib/api';

export interface DocumentMetaState {
  meta: DocumentMeta | null;
  engine: EngineName;
  resolved: boolean;
}

/**
 * Resolve a document's engine before opening a session.
 *
 * The two CRDTs have incompatible binary formats, so a document is opened with
 * the engine it was created with. Unknown ids default to Loro and are created
 * on first connect.
 */
export function useDocumentMeta(docId: string | null): DocumentMetaState {
  const [meta, setMeta] = useState<DocumentMeta | null>(null);
  const [resolved, setResolved] = useState(false);

  useEffect(() => {
    if (!docId) {
      setMeta(null);
      setResolved(false);
      return;
    }

    let active = true;
    setResolved(false);

    void readDocumentMeta(docId).then((cached) => {
      if (!active || !cached) return;
      setMeta(cached);
      setResolved(true);
    });

    getDocument(docId)
      .then(({ document }) => {
        if (!active) return;
        setMeta(document);
        void writeDocumentMeta(document);
      })
      .catch(() => {
        // Keep a cached engine so an offline Yjs document is not opened as Loro.
        if (active) {
          /* meta already set from cache, or stays null for a true unknown id */
        }
      })
      .finally(() => {
        if (active) setResolved(true);
      });

    return () => {
      active = false;
    };
  }, [docId]);

  return { meta, engine: meta?.engine ?? 'loro', resolved };
}
