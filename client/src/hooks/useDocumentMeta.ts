import { useEffect, useState } from 'react';
import { readDocumentMeta, writeDocumentMeta } from '../browser/catalog-cache';
import { documentIsOpenable } from '../browser/document-support';
import { getDocument, type DocumentMeta } from '../lib/api';

export interface DocumentMetaState {
  meta: DocumentMeta | null;
  /** The engine tag to display; `esbt` for anything this client can open. */
  engine: string;
  /** False for rows created by the retired Loro/Yjs engines. */
  supported: boolean;
  resolved: boolean;
}

/**
 * Resolve a document's metadata before opening a session.
 *
 * Unknown ids are created as ESBT documents on first connect. Rows created
 * by the retired engines are refused rather than opened: their stored bytes
 * are in a binary format marks no longer ships a runtime for, and connecting
 * an ESBT replica to them would overwrite good state with an empty document.
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
        // Keep a cached engine so an offline legacy document is not opened
        // as ESBT; meta stays null only for a truly unknown id.
      })
      .finally(() => {
        if (active) setResolved(true);
      });

    return () => {
      active = false;
    };
  }, [docId]);

  return {
    meta,
    engine: meta?.engine ?? 'esbt',
    supported: documentIsOpenable(meta),
    resolved,
  };
}
