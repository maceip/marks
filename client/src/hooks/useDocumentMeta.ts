import { useEffect, useState } from 'react';
import { readDocumentMeta, writeDocumentMeta } from '../browser/catalog-cache';
import { documentIsOpenable } from '../browser/document-support';
import { aboutDocumentMeta, isAboutDocument } from '../content/about';
import { runWithTimeout } from '../browser/network.ts';
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
  error: string | null;
}

const CATALOG_READ_TIMEOUT_MS = 2_000;

/**
 * Resolve a document's metadata before opening a session.
 *
 * Unknown, deleted, or inaccessible ids remain closed. Document creation is a
 * separate authorized operation. Non-ESBT engine tags stay closed.
 */
export function useDocumentMeta(docId: string | null): DocumentMetaState {
  const [meta, setMeta] = useState<DocumentMeta | null>(null);
  const [resolved, setResolved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!docId) {
      setMeta(null);
      setResolved(false);
      setError(null);
      return;
    }

    let active = true;
    setResolved(false);
    setError(null);

    // The public marketing document is built-in Markdown. Do not wait on the
    // catalog or a server row — /welcome must open the editor immediately.
    if (isAboutDocument(docId)) {
      seedAboutDocumentText();
      const about = aboutDocumentMeta();
      setMeta(about);
      setResolved(true);
      if (documentRepository.mode === 'service') void writeDocumentMeta(about).catch(() => undefined);
      return;
    }

    void (async () => {
      const lookup = documentRepository.get(docId).then(
        (document) => ({ document, failed: false as const }),
        () => ({ document: null, failed: true as const }),
      );
      const cached = documentRepository.mode === 'service'
        ? await runWithTimeout(() => readDocumentMeta(docId), CATALOG_READ_TIMEOUT_MS)
            .catch(() => null)
        : null;
      if (active && cached) {
        setMeta(cached);
        setResolved(true);
      }

      const result = await lookup;
      if (!active) return;
      if (result.failed) {
        // Keep a cached engine so an offline legacy document is not opened as
        // ESBT. With no local proof, distinguish transport failure from an
        // authoritative missing/unauthorized response and offer a retry.
        if (!cached) setError('Marks could not reach the document service in time.');
      } else {
        setMeta(result.document);
        setError(null);
        if (result.document && documentRepository.mode === 'service') {
          void writeDocumentMeta(result.document).catch(() => undefined);
        }
      }
      setResolved(true);
    })();

    const unsubscribe = documentRepository.subscribe(() => {
      void documentRepository
        .get(docId)
        .then((document) => {
          if (active) setMeta(document);
        })
        .catch(() => {
          // A refresh transport failure does not invalidate cached identity.
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
    error,
  };
}
