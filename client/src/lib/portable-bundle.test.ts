import assert from 'node:assert/strict';
import test from 'node:test';
import { createPortableBundle } from './portable-bundle.ts';
import { buildStoredZip } from './stored-zip.ts';

async function readStoredEntries(blob: Blob): Promise<Map<string, Uint8Array>> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer);
  const entries = new Map<string, Uint8Array>();
  const decoder = new TextDecoder();
  let offset = 0;
  while (view.getUint32(offset, true) === 0x0403_4b50) {
    assert.equal(view.getUint16(offset + 8, true), 0, 'test reader expects stored entries');
    const size = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = decoder.decode(bytes.subarray(nameStart, nameStart + nameLength));
    entries.set(name, bytes.slice(dataStart, dataStart + size));
    offset = dataStart + size;
  }
  assert.equal(view.getUint32(offset, true), 0x0201_4b50, 'central directory follows files');
  return entries;
}

test('portable bundle rewrites repeated references in one pass and omits unreferenced blobs', async () => {
  const image = new Uint8Array([137, 80, 78, 71, 1]);
  const usedUrl = '/__marks_local_asset/local-asset-11111111-1111-4111-8111-111111111111';
  const bundle = await createPortableBundle(
    'document-local',
    `![proof](${usedUrl})\nAgain: ${usedUrl}\n`,
    [
      {
        id: 'local-asset-11111111-1111-4111-8111-111111111111',
        url: usedUrl,
        filename: 'proof.png',
        mediaType: 'image/png',
        bytes: image.byteLength,
        sha256: 'known-hash',
        blob: new Blob([image]),
      },
      {
        id: 'local-asset-22222222-2222-4222-8222-222222222222',
        url: '/__marks_local_asset/local-asset-22222222-2222-4222-8222-222222222222',
        filename: 'orphan.png',
        mediaType: 'image/png',
        bytes: 1,
        sha256: 'orphan-hash',
        blob: new Blob([new Uint8Array([2])]),
      },
    ],
  );

  assert.equal(bundle.type, 'application/zip');
  const entries = await readStoredEntries(bundle);
  assert.deepEqual([...entries.keys()], [
    'document.md',
    'manifest.json',
    'assets/local-asset-11111111-1111-4111-8111-111111111111.png',
  ]);
  assert.equal(
    new TextDecoder().decode(entries.get('document.md')),
    '![proof](assets/local-asset-11111111-1111-4111-8111-111111111111.png)\n'
      + 'Again: assets/local-asset-11111111-1111-4111-8111-111111111111.png\n',
  );
  assert.deepEqual(
    entries.get('assets/local-asset-11111111-1111-4111-8111-111111111111.png'),
    image,
  );
  const manifest = JSON.parse(new TextDecoder().decode(entries.get('manifest.json')));
  assert.equal(manifest.schema, 'marks-portable-bundle');
  assert.equal(manifest.assets.length, 1);
  assert.equal(manifest.assets[0].sha256, 'known-hash');
});

test('stored ZIP rejects paths that could escape during extraction', async () => {
  await assert.rejects(
    () => buildStoredZip([{ path: '../escape', data: 'bad' }]),
    /Unsafe ZIP entry path/,
  );
});
