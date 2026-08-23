export const LOCAL_ASSET_PREFIX = '/__marks_local_asset/';

export function localAssetId(url: string): string | null {
  if (!url.startsWith(LOCAL_ASSET_PREFIX)) return null;
  const id = url.slice(LOCAL_ASSET_PREFIX.length);
  return /^local-asset-[0-9a-f-]{36}$/iu.test(id) ? id : null;
}
