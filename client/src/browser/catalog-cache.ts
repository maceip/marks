import { get as idbGet, set as idbSet, del as idbDel } from 'idb-keyval';
import type { DocumentMeta } from '../lib/api';

const CATALOG_KEY = 'marks:catalog';
const metaKey = (id: string) => `marks:meta:${id}`;

/**
 * Last-known document list and per-id metadata.
 *
 * Offline catalog for service mode. The network is always authoritative when
 * it answers; the cache is never shown as fresher than it is. Non-ESBT engine
 * tags stay closed through `documentIsOpenable`.
 */
export async function readCatalog(): Promise<DocumentMeta[] | null> {
  try {
    const cached = await idbGet<DocumentMeta[]>(CATALOG_KEY);
    return Array.isArray(cached) ? cached : null;
  } catch {
    return null;
  }
}

export async function writeCatalog(documents: DocumentMeta[]): Promise<void> {
  try {
    await idbSet(CATALOG_KEY, documents);
    await Promise.all(documents.map((doc) => idbSet(metaKey(doc.id), doc)));
  } catch {
    // Private mode or quota: opening will just wait on the network.
  }
}

export async function readDocumentMeta(id: string): Promise<DocumentMeta | null> {
  try {
    const cached = await idbGet<DocumentMeta>(metaKey(id));
    return cached && cached.id === id ? cached : null;
  } catch {
    return null;
  }
}

export async function writeDocumentMeta(doc: DocumentMeta): Promise<void> {
  try {
    await idbSet(metaKey(doc.id), doc);
  } catch {
    // ignore
  }
}

export async function forgetDocumentMeta(id: string): Promise<void> {
  try {
    await idbDel(metaKey(id));
    const catalog = await readCatalog();
    if (catalog) await writeCatalog(catalog.filter((doc) => doc.id !== id));
  } catch {
    // ignore
  }
}
