export type StoredZipSource = Blob | Uint8Array | string;

export interface StoredZipEntry {
  path: string;
  data: StoredZipSource;
}

const encoder = new TextEncoder();
const UTF8_FLAG = 0x0800;
const MAX_U16 = 0xffff;
const MAX_U32 = 0xffff_ffff;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let value = 0; value < table.length; value += 1) {
    let crc = value;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) === 1 ? 0xedb8_8320 ^ (crc >>> 1) : crc >>> 1;
    }
    table[value] = crc >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffff_ffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffff_ffff) >>> 0;
}

function block(length: number): { bytes: Uint8Array<ArrayBuffer>; view: DataView } {
  const bytes = new Uint8Array(new ArrayBuffer(length));
  return { bytes, view: new DataView(bytes.buffer) };
}

function safePath(path: string): Uint8Array<ArrayBuffer> {
  if (
    !path
    || path.startsWith('/')
    || path.includes('\\')
    || path.includes('\0')
    || path.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error(`Unsafe ZIP entry path: ${path}`);
  }
  const encoded = encoder.encode(path);
  if (encoded.byteLength > MAX_U16) throw new Error('ZIP entry path is too long');
  return Uint8Array.from(encoded);
}

async function bytesFor(source: StoredZipSource): Promise<{
  bytes: Uint8Array;
  output: Blob | ArrayBuffer;
}> {
  if (typeof source === 'string') {
    const bytes = Uint8Array.from(encoder.encode(source));
    return { bytes, output: bytes.buffer };
  }
  if (source instanceof Uint8Array) {
    const bytes = Uint8Array.from(source);
    return { bytes, output: bytes.buffer };
  }
  const bytes = new Uint8Array(await source.arrayBuffer());
  // Keep the Blob as the output part. The temporary ArrayBuffer used for CRC
  // can be collected before the next large asset instead of being retained by
  // the completed archive.
  return { bytes, output: source };
}

/**
 * Build a portable store-only ZIP without concatenating the archive into one
 * giant ArrayBuffer. Images are already compressed, so DEFLATE would add CPU
 * and memory pressure without making the bundle materially smaller.
 *
 * Marks quotas keep this deliberately ZIP32 implementation below 4 GiB and
 * 65,535 entries. Blob parts let the browser assemble/download the result
 * while retaining at most one asset-sized CRC buffer at a time.
 */
export async function buildStoredZip(entries: readonly StoredZipEntry[]): Promise<Blob> {
  if (entries.length > MAX_U16) throw new Error('ZIP contains too many entries');

  const output: BlobPart[] = [];
  const central: BlobPart[] = [];
  let offset = 0;
  let centralBytes = 0;

  for (const entry of entries) {
    const name = safePath(entry.path);
    const source = await bytesFor(entry.data);
    const size = source.bytes.byteLength;
    if (size > MAX_U32 || offset + 30 + name.byteLength + size > MAX_U32) {
      throw new Error('ZIP exceeds the portable bundle size limit');
    }
    const checksum = crc32(source.bytes);

    const local = block(30);
    local.view.setUint32(0, 0x0403_4b50, true);
    local.view.setUint16(4, 20, true);
    local.view.setUint16(6, UTF8_FLAG, true);
    local.view.setUint16(8, 0, true);
    local.view.setUint16(10, 0, true);
    local.view.setUint16(12, 33, true); // 1980-01-01, the ZIP epoch.
    local.view.setUint32(14, checksum, true);
    local.view.setUint32(18, size, true);
    local.view.setUint32(22, size, true);
    local.view.setUint16(26, name.byteLength, true);
    local.view.setUint16(28, 0, true);
    output.push(local.bytes.buffer, name.buffer, source.output);

    const directory = block(46);
    directory.view.setUint32(0, 0x0201_4b50, true);
    directory.view.setUint16(4, 20, true);
    directory.view.setUint16(6, 20, true);
    directory.view.setUint16(8, UTF8_FLAG, true);
    directory.view.setUint16(10, 0, true);
    directory.view.setUint16(12, 0, true);
    directory.view.setUint16(14, 33, true);
    directory.view.setUint32(16, checksum, true);
    directory.view.setUint32(20, size, true);
    directory.view.setUint32(24, size, true);
    directory.view.setUint16(28, name.byteLength, true);
    directory.view.setUint16(30, 0, true);
    directory.view.setUint16(32, 0, true);
    directory.view.setUint16(34, 0, true);
    directory.view.setUint16(36, 0, true);
    directory.view.setUint32(38, 0, true);
    directory.view.setUint32(42, offset, true);
    central.push(directory.bytes.buffer, name.buffer);
    centralBytes += directory.bytes.byteLength + name.byteLength;
    offset += local.bytes.byteLength + name.byteLength + size;
  }

  if (offset + centralBytes > MAX_U32) throw new Error('ZIP directory exceeds ZIP32 limits');
  output.push(...central);
  const end = block(22);
  end.view.setUint32(0, 0x0605_4b50, true);
  end.view.setUint16(4, 0, true);
  end.view.setUint16(6, 0, true);
  end.view.setUint16(8, entries.length, true);
  end.view.setUint16(10, entries.length, true);
  end.view.setUint32(12, centralBytes, true);
  end.view.setUint32(16, offset, true);
  end.view.setUint16(20, 0, true);
  output.push(end.bytes.buffer);
  return new Blob(output, { type: 'application/zip' });
}
