import { useEffect, useState } from 'react';
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

    getDocument(docId)
      .then(({ document }) => {
        if (active) setMeta(document);
      })
      .catch(() => {
        if (active) setMeta(null);
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
