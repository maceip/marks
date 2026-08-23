import { buildStoredZip } from './stored-zip.ts';

export interface PortableBundleAsset {
  id: string;
  url: string;
  filename: string;
  mediaType: string;
  bytes: number;
  sha256: string;
  blob: Blob;
}

function extension(mediaType: string): string {
  return {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
  }[mediaType] ?? 'bin';
}

interface UrlTrieNode {
  children: Map<string, UrlTrieNode>;
  assetIndex?: number;
}

function rewriteKnownAssetUrls(
  source: string,
  assets: ReadonlyArray<PortableBundleAsset & { path: string }>,
): { markdown: string; used: boolean[] } {
  const root: UrlTrieNode = { children: new Map() };
  for (let assetIndex = 0; assetIndex < assets.length; assetIndex += 1) {
    let node = root;
    const url = assets[assetIndex].url;
    for (let index = 0; index < url.length; index += 1) {
      const character = url[index];
      let child = node.children.get(character);
      if (!child) {
        child = { children: new Map() };
        node.children.set(character, child);
      }
      node = child;
    }
    if (url.length > 0) node.assetIndex = assetIndex;
  }

  const used = Array.from({ length: assets.length }, () => false);
  const output: string[] = [];
  let copiedThrough = 0;
  let cursor = 0;
  while (cursor < source.length) {
    let node = root;
    let probe = cursor;
    let matched: { assetIndex: number; end: number } | undefined;
    while (probe < source.length) {
      const child = node.children.get(source[probe]);
      if (!child) break;
      node = child;
      probe += 1;
      if (node.assetIndex !== undefined) {
        matched = { assetIndex: node.assetIndex, end: probe };
      }
    }
    if (!matched) {
      cursor += 1;
      continue;
    }
    output.push(source.slice(copiedThrough, cursor), assets[matched.assetIndex].path);
    used[matched.assetIndex] = true;
    cursor = matched.end;
    copiedThrough = matched.end;
  }
  output.push(source.slice(copiedThrough));
  return { markdown: output.join(''), used };
}

/** Rewrites only referenced, known assets and emits one self-contained ZIP. */
export async function createPortableBundle(
  documentId: string,
  sourceMarkdown: string,
  assets: readonly PortableBundleAsset[],
): Promise<Blob> {
  const candidates = assets.map((asset) => ({
    ...asset,
    path: `assets/${asset.id}.${extension(asset.mediaType)}`,
  }));
  const rewritten = rewriteKnownAssetUrls(sourceMarkdown, candidates);
  const markdown = rewritten.markdown;
  const included = candidates.filter((_, index) => rewritten.used[index]);

  const manifest = {
    schema: 'marks-portable-bundle',
    version: 1,
    documentId,
    assets: included.map((asset) => ({
      id: asset.id,
      path: asset.path,
      filename: asset.filename,
      mediaType: asset.mediaType,
      bytes: asset.bytes,
      sha256: asset.sha256,
    })),
  };
  return buildStoredZip([
    { path: 'document.md', data: markdown },
    { path: 'manifest.json', data: `${JSON.stringify(manifest, null, 2)}\n` },
    ...included.map((asset) => ({ path: asset.path, data: asset.blob })),
  ]);
}
