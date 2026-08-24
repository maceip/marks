import { UI_DATA_MODE } from '../lib/product';
import type { DocumentAssetDto } from '../lib/api';
import { LOCAL_ASSET_PREFIX } from '../lib/asset-links';
import { sniffImageType } from '../lib/asset-sniff';
import { createPortableBundle } from '../lib/portable-bundle.ts';
import { loadServiceApi } from '../lib/service-api.ts';

const DATABASE = 'marks-local-assets';
const STORE = 'assets';
const VERSION = 1;
const MAX_ASSET_BYTES = 10 * 1024 * 1024;
const MAX_DOCUMENT_ASSET_BYTES = 128 * 1024 * 1024;
const MAX_DOCUMENT_ASSETS = 1_000;

export interface LocalAssetRecord extends DocumentAssetDto {
  documentId: string;
  hash: string;
  createdAt: number;
  blob: Blob;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, VERSION);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE, { keyPath: 'id' });
      store.createIndex('documentId', 'documentId', { unique: false });
      store.createIndex('documentHash', ['documentId', 'hash'], { unique: true });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('asset database unavailable'));
  });
}

function requested<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('asset request failed'));
  });
}

function completed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('asset transaction aborted'));
    transaction.onerror = () => reject(transaction.error ?? new Error('asset transaction failed'));
  });
}

function extension(mediaType: string): string {
  return { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }[mediaType]
    ?? 'bin';
}

async function digestHex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function uploadLocalAsset(documentId: string, file: File): Promise<DocumentAssetDto> {
  if (file.size <= 0 || file.size > MAX_ASSET_BYTES) {
    throw new Error('Image must be between 1 byte and 10 MiB.');
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mediaType = sniffImageType(bytes);
  if (!mediaType) throw new Error('Use a valid PNG, JPEG, GIF, or WebP image.');
  const hash = await digestHex(bytes);
  const database = await openDatabase();
  const transaction = database.transaction(STORE, 'readwrite');
  const store = transaction.objectStore(STORE);
  const existing = await requested<LocalAssetRecord | undefined>(
    store.index('documentHash').get([documentId, hash]),
  );
  if (existing) {
    await completed(transaction);
    database.close();
    return {
      id: existing.id,
      url: existing.url,
      filename: existing.filename,
      mediaType: existing.mediaType,
      bytes: existing.bytes,
    };
  }
  const records = await requested<LocalAssetRecord[]>(store.index('documentId').getAll(documentId));
  const storedBytes = records.reduce((sum, record) => sum + record.bytes, 0);
  if (records.length >= MAX_DOCUMENT_ASSETS || storedBytes + bytes.byteLength > MAX_DOCUMENT_ASSET_BYTES) {
    transaction.abort();
    database.close();
    throw new Error('This document reached its local asset quota.');
  }
  const id = `local-asset-${crypto.randomUUID()}`;
  const filename = file.name.trim().slice(0, 160) || `image.${extension(mediaType)}`;
  const record: LocalAssetRecord = {
    id,
    documentId,
    hash,
    url: `${LOCAL_ASSET_PREFIX}${id}`,
    filename,
    mediaType,
    bytes: bytes.byteLength,
    createdAt: Date.now(),
    blob: new Blob([bytes], { type: mediaType }),
  };
  store.put(record);
  await completed(transaction);
  database.close();
  return { id, url: record.url, filename, mediaType, bytes: record.bytes };
}

export async function getLocalAsset(id: string): Promise<LocalAssetRecord | null> {
  const database = await openDatabase();
  const transaction = database.transaction(STORE, 'readonly');
  const record = await requested<LocalAssetRecord | undefined>(transaction.objectStore(STORE).get(id));
  await completed(transaction);
  database.close();
  return record ?? null;
}

export async function listLocalAssets(documentId: string): Promise<LocalAssetRecord[]> {
  const database = await openDatabase();
  const transaction = database.transaction(STORE, 'readonly');
  const records = await requested<LocalAssetRecord[]>(
    transaction.objectStore(STORE).index('documentId').getAll(documentId),
  );
  await completed(transaction);
  database.close();
  return records.sort((a, b) => a.createdAt - b.createdAt);
}

export async function createLocalPortableBundle(
  documentId: string,
  markdown: string,
): Promise<Blob> {
  const assets = await listLocalAssets(documentId);
  return createPortableBundle(
    documentId,
    markdown,
    assets.map((asset) => ({
      id: asset.id,
      url: asset.url,
      filename: asset.filename,
      mediaType: asset.mediaType,
      bytes: asset.bytes,
      sha256: asset.hash,
      blob: asset.blob,
    })),
  );
}

export async function purgeLocalDocumentAssets(documentId: string): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(STORE, 'readwrite');
  const store = transaction.objectStore(STORE);
  const keys = await requested<IDBValidKey[]>(store.index('documentId').getAllKeys(documentId));
  for (const key of keys) store.delete(key);
  await completed(transaction);
  database.close();
}

export async function hydrateLocalAssetImages(root: ParentNode): Promise<void> {
  const images = [...root.querySelectorAll<HTMLImageElement>('img[data-marks-local-asset]')];
  await Promise.all(images.map(async (image) => {
    const id = image.dataset.marksLocalAsset;
    if (!id || image.dataset.marksObjectUrl) return;
    const asset = await getLocalAsset(id);
    if (!asset || !image.isConnected) return;
    const url = URL.createObjectURL(asset.blob);
    image.dataset.marksObjectUrl = url;
    image.src = url;
  }));
}

export function revokeLocalAssetImages(root: ParentNode): void {
  for (const image of root.querySelectorAll<HTMLImageElement>('img[data-marks-object-url]')) {
    const url = image.dataset.marksObjectUrl;
    if (url) URL.revokeObjectURL(url);
    delete image.dataset.marksObjectUrl;
  }
}

export const assetRepository = {
  mode: UI_DATA_MODE,
  async upload(documentId: string, file: File): Promise<DocumentAssetDto> {
    if (UI_DATA_MODE === 'service') {
      return (await (await loadServiceApi()).uploadDocumentAsset(documentId, file)).asset;
    }
    return uploadLocalAsset(documentId, file);
  },
};
