/**
 * Byte-mode QR, ECC Medium, versions 1–6.
 * Used only to render pairing URLs. Secrets never go in logs.
 */

const EXP = new Uint8Array(256);
const LOG = new Uint8Array(256);
for (let i = 0, value = 1; i < 255; i += 1) {
  EXP[i] = value;
  LOG[value] = i;
  value = value << 1 ^ (value & 0x80 ? 0x11d : 0);
}

const gfMul = (a: number, b: number) => (a && b ? EXP[(LOG[a] + LOG[b]) % 255] : 0);

function rsGenerator(degree: number): Uint8Array {
  const poly = new Uint8Array(degree + 1);
  poly[0] = 1;
  for (let i = 0; i < degree; i += 1) {
    for (let j = i + 1; j > 0; j -= 1) poly[j] ^= gfMul(poly[j - 1], EXP[i]);
  }
  return poly;
}

function rsEncode(data: Uint8Array, degree: number): Uint8Array {
  const generator = rsGenerator(degree);
  const ecc = new Uint8Array(degree);
  for (const byte of data) {
    const factor = byte ^ ecc[0];
    ecc.copyWithin(0, 1);
    ecc[degree - 1] = 0;
    if (!factor) continue;
    for (let i = 0; i < degree; i += 1) ecc[i] ^= gfMul(generator[i + 1], factor);
  }
  return ecc;
}

/** version, modules, data bytes, ecc bytes, remainder bits */
const VERSIONS = [
  [1, 21, 16, 10, 0],
  [2, 25, 28, 16, 7],
  [3, 29, 44, 26, 7],
  [4, 33, 64, 36, 7],
  [5, 37, 86, 48, 7],
  [6, 41, 108, 64, 7],
] as const;

function chooseVersion(payload: number): (typeof VERSIONS)[number] {
  for (const version of VERSIONS) {
    if (payload + 2 <= version[2]) return version;
  }
  throw new TypeError('pairing URL is too long for the QR renderer');
}

function pushBits(bits: number[], value: number, width: number) {
  for (let i = width - 1; i >= 0; i -= 1) bits.push((value >> i) & 1);
}

function encodeData(text: string, dataBytes: number): Uint8Array {
  const bytes = new TextEncoder().encode(text);
  const bits: number[] = [];
  pushBits(bits, 0b0100, 4);
  pushBits(bits, bytes.length, 8);
  for (const byte of bytes) pushBits(bits, byte, 8);
  const capacity = dataBytes * 8;
  const terminator = Math.min(4, capacity - bits.length);
  for (let i = 0; i < terminator; i += 1) bits.push(0);
  while (bits.length % 8) bits.push(0);
  const out = new Uint8Array(dataBytes);
  for (let i = 0; i < out.length; i += 1) {
    let value = 0;
    for (let b = 0; b < 8; b += 1) value = value << 1 | (bits[i * 8 + b] ?? 0);
    out[i] = value;
  }
  const pad = [0xec, 0x11];
  let padIndex = 0;
  for (let i = Math.ceil(bits.length / 8); i < dataBytes; i += 1) {
    out[i] = pad[padIndex % 2];
    padIndex += 1;
  }
  return out;
}

function setFinder(grid: boolean[][], x: number, y: number) {
  for (let dy = -1; dy <= 7; dy += 1) {
    for (let dx = -1; dx <= 7; dx += 1) {
      const xx = x + dx;
      const yy = y + dy;
      if (yy < 0 || xx < 0 || yy >= grid.length || xx >= grid.length) continue;
      const on =
        dx === -1 || dx === 7 || dy === -1 || dy === 7
          ? false
          : dx === 0 || dx === 6 || dy === 0 || dy === 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4);
      if (dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6) grid[yy][xx] = on;
    }
  }
}

const ALIGNMENT = [0, 0, 18, 22, 26, 30, 34];

function alignmentCenter(size: number): number {
  const version = (size - 17) / 4;
  return ALIGNMENT[version] ?? 0;
}

function inAlignment(size: number, x: number, y: number): boolean {
  const center = alignmentCenter(size);
  if (center < 8) return false;
  return Math.abs(x - center) <= 2 && Math.abs(y - center) <= 2;
}

function reserved(size: number, x: number, y: number): boolean {
  if (x < 9 && y < 9) return true;
  if (x >= size - 8 && y < 9) return true;
  if (x < 9 && y >= size - 8) return true;
  if (y === 6 || x === 6) return true;
  return inAlignment(size, x, y);
}

function setAlignment(grid: boolean[][]) {
  const center = alignmentCenter(grid.length);
  if (center < 8) return;
  for (let dy = -2; dy <= 2; dy += 1) {
    for (let dx = -2; dx <= 2; dx += 1) {
      const on = Math.max(Math.abs(dx), Math.abs(dy)) !== 1;
      grid[center + dy][center + dx] = on || (dx === 0 && dy === 0);
    }
  }
}

function formatBits(mask: number): number {
  let bits = (0b00 << 3 | mask) << 10;
  const generator = 0b10100110111;
  for (let i = 14; i >= 10; i -= 1) {
    if (bits & (1 << i)) bits ^= generator << (i - 10);
  }
  return (0b00 << 3 | mask) << 10 | bits ^ 0b101010000010010;
}

function applyFormat(grid: boolean[][], mask: number) {
  const bits = formatBits(mask);
  const size = grid.length;
  for (let i = 0; i < 15; i += 1) {
    const on = Boolean(bits & (1 << (14 - i)));
    if (i < 6) grid[i][8] = on;
    else if (i === 6) grid[7][8] = on;
    else if (i === 7) grid[8][8] = on;
    else grid[8][14 - i] = on;

    if (i < 8) grid[8][size - 1 - i] = on;
    else grid[size - 15 + i][8] = on;
  }
  grid[size - 8][8] = true;
}

function maskBit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    default:
      return (x + y) % 2 === 0;
  }
}

function placeData(grid: boolean[][], bits: number[]) {
  const size = grid.length;
  let index = 0;
  let upward = true;
  for (let x = size - 1; x > 0; x -= 2) {
    if (x === 6) x -= 1;
    for (let i = 0; i < size; i += 1) {
      const y = upward ? size - 1 - i : i;
      for (const dx of [0, -1]) {
        const xx = x + dx;
        if (reserved(size, xx, y) || grid[y][xx]) continue;
        const bit = bits[index] ?? 0;
        index += 1;
        grid[y][xx] = Boolean(bit);
      }
    }
    upward = !upward;
  }
}

export function encodeQr(text: string): boolean[][] {
  const payload = new TextEncoder().encode(text).length;
  const [, size, dataBytes, eccBytes] = chooseVersion(payload);
  const data = encodeData(text, dataBytes);
  const ecc = rsEncode(data, eccBytes);
  const stream = new Uint8Array(data.length + ecc.length);
  stream.set(data);
  stream.set(ecc, data.length);
  const bits: number[] = [];
  for (const byte of stream) pushBits(bits, byte, 8);

  const grid = Array.from({ length: size }, () => Array<boolean>(size).fill(false));
  setFinder(grid, 0, 0);
  setFinder(grid, size - 7, 0);
  setFinder(grid, 0, size - 7);
  setAlignment(grid);
  for (let i = 8; i < size - 8; i += 1) {
    grid[6][i] = i % 2 === 0;
    grid[i][6] = i % 2 === 0;
  }

  const filled = grid.map((row) => row.slice());
  placeData(filled, bits);
  const mask = 0;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (reserved(size, x, y)) continue;
      if (maskBit(mask, x, y)) filled[y][x] = !filled[y][x];
    }
  }
  applyFormat(filled, mask);
  return filled;
}
