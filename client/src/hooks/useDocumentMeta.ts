import { useEffect, useState } from 'react';
import { readDocumentMeta, writeDocumentMeta } from '../browser/catalog-cache';
import { documentIsOpenable } from '../browser/document-support';
import { aboutDocumentMeta, isAboutDocument } from '../content/about';
import { documentRepository } from '../data/documents';
import { seedAboutDocumentText } from '../demo/workspace';
import type { DocumentMeta } from '../lib/api';

export interface DocumentMetaState {
  meta: DocumentMeta | null;
  /** The engine tag to display; `esbt` for anything this client can open. */
  engine: string;
  /** False for missing/inaccessible documents and retired engine rows. */
  supported: boolean;
  resolved: boolean;
}

/**
 * Resolve a document's metadata before opening a session.
 *
 * Unknown, deleted, or inaccessible ids remain closed. Document creation is a
 * separate authorized operation. Non-ESBT engine tags stay closed.
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

    // The public marketing document is built-in Markdown. Do not wait on the
    // catalog or a server row — /welcome must open the editor immediately.
    if (isAboutDocument(docId)) {
      seedAboutDocumentText();
      const about = aboutDocumentMeta();
      setMeta(about);
      setResolved(true);
      if (documentRepository.mode === 'service') void writeDocumentMeta(about);
      return;
    }

    if (documentRepository.mode === 'service') {
      void readDocumentMeta(docId).then((cached) => {
        if (!active || !cached) return;
        setMeta(cached);
        setResolved(true);
      });
    }

    documentRepository
      .get(docId)
      .then((document) => {
        if (!active) return;
        setMeta(document);
        if (document && documentRepository.mode === 'service') void writeDocumentMeta(document);
      })
      .catch(() => {
        // Keep a cached engine so an offline legacy document is not opened
        // as ESBT; meta stays null only for a truly unknown id.
      })
      .finally(() => {
        if (active) setResolved(true);
      });

    const unsubscribe = documentRepository.subscribe(() => {
      void documentRepository.get(docId).then((document) => {
        if (active) setMeta(document);
      });
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [docId]);

  return {
    meta,
    engine: meta?.engine ?? 'esbt',
    supported: documentIsOpenable(meta),
    resolved,
  };
}
