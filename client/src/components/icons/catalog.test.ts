import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import test from 'node:test';
import { SHEET_ICON_NAMES, SHEET_ICON_SIZE, VECTOR_ONLY_ICON_NAMES } from './assets.ts';
import { ICON_MARKS, ICON_NAMES, isIconName } from './catalog.ts';
import { createIconActivationPlan, ICON_ACTIVATION_MOTION } from './motion.ts';

const ICON_ASSET_DIRECTORY = new URL('../../../public/icons/isometric/', import.meta.url);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function paethPredictor(left: number, up: number, upperLeft: number) {
  const estimate = left + up - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= upDistance && leftDistance <= upperLeftDistance) return left;
  return upDistance <= upperLeftDistance ? up : upperLeft;
}

function inspectRgbaPng(file: URL) {
  const png = readFileSync(file);
  assert.equal(png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE), true, `${file.pathname} is not a PNG`);

  let offset = PNG_SIGNATURE.length;
  let ihdr: Buffer | undefined;
  const imageData: Buffer[] = [];
  while (offset < png.length) {
    assert.ok(offset + 12 <= png.length, `${file.pathname} has a truncated chunk header`);
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    assert.ok(dataEnd + 4 <= png.length, `${file.pathname} has a truncated ${type} chunk`);
    if (type === 'IHDR') ihdr = png.subarray(dataStart, dataEnd);
    if (type === 'IDAT') imageData.push(png.subarray(dataStart, dataEnd));
    offset = dataEnd + 4;
    if (type === 'IEND') break;
  }

  assert.ok(ihdr, `${file.pathname} is missing IHDR`);
  assert.equal(ihdr.length, 13, `${file.pathname} has an invalid IHDR`);
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  assert.equal(width, SHEET_ICON_SIZE, `${file.pathname} must be ${SHEET_ICON_SIZE}px wide`);
  assert.equal(height, SHEET_ICON_SIZE, `${file.pathname} must be ${SHEET_ICON_SIZE}px high`);
  assert.equal(ihdr[8], 8, `${file.pathname} must use 8-bit channels`);
  assert.equal(ihdr[9], 6, `${file.pathname} must be RGBA (PNG color type 6)`);
  assert.equal(ihdr[10], 0, `${file.pathname} uses an unsupported compression method`);
  assert.equal(ihdr[11], 0, `${file.pathname} uses an unsupported filter method`);
  assert.equal(ihdr[12], 0, `${file.pathname} must be non-interlaced`);
  assert.ok(imageData.length > 0, `${file.pathname} is missing IDAT`);

  const bytesPerPixel = 4;
  const stride = width * bytesPerPixel;
  const decoded = inflateSync(Buffer.concat(imageData));
  assert.equal(decoded.length, height * (stride + 1), `${file.pathname} has an unexpected scanline size`);

  let previous = Buffer.alloc(stride);
  let hasVisiblePixel = false;
  let hasTransparentPixel = false;
  for (let row = 0; row < height; row += 1) {
    const scanlineOffset = row * (stride + 1);
    const filter = decoded[scanlineOffset];
    assert.ok(filter <= 4, `${file.pathname} has an unsupported PNG filter`);
    const current = Buffer.allocUnsafe(stride);
    for (let index = 0; index < stride; index += 1) {
      const raw = decoded[scanlineOffset + index + 1];
      const left = index >= bytesPerPixel ? current[index - bytesPerPixel] : 0;
      const up = previous[index];
      const upperLeft = index >= bytesPerPixel ? previous[index - bytesPerPixel] : 0;
      const predictor = filter === 0 ? 0
        : filter === 1 ? left
          : filter === 2 ? up
            : filter === 3 ? Math.floor((left + up) / 2)
              : paethPredictor(left, up, upperLeft);
      current[index] = (raw + predictor) & 0xff;
    }
    for (let alphaIndex = 3; alphaIndex < stride; alphaIndex += bytesPerPixel) {
      hasVisiblePixel ||= current[alphaIndex] > 0;
      hasTransparentPixel ||= current[alphaIndex] < 255;
    }
    previous = current;
  }

  assert.equal(hasVisiblePixel, true, `${file.pathname} must contain visible artwork`);
  assert.equal(hasTransparentPixel, true, `${file.pathname} must contain transparent background pixels`);
}

test('every named icon has a mark and is addressable without a third-party pack', () => {
  assert.equal(ICON_NAMES.length, Object.keys(ICON_MARKS).length);
  for (const name of ICON_NAMES) {
    assert.equal(isIconName(name), true);
    assert.match(ICON_MARKS[name], /[ML]/);
  }
  assert.equal(isIconName('feather'), false);
});

test('the typed sheet manifest exactly matches the PNG filesystem', () => {
  for (const name of VECTOR_ONLY_ICON_NAMES) assert.equal(isIconName(name), true);
  const expected = SHEET_ICON_NAMES.map((name) => `${name}.png`).sort();
  const actual = readdirSync(ICON_ASSET_DIRECTORY)
    .filter((filename) => /\.png$/i.test(filename))
    .sort();
  assert.deepEqual(actual, expected);
  assert.equal(expected.length + VECTOR_ONLY_ICON_NAMES.length, ICON_NAMES.length);
});

test('every sheet icon is a visible 104x104 RGBA PNG with transparency', () => {
  for (const name of SHEET_ICON_NAMES) {
    inspectRgbaPng(new URL(`${name}.png`, ICON_ASSET_DIRECTORY));
  }
});

test('activation motion has one typed full recipe and a reduced-motion plan', () => {
  const full = createIconActivationPlan(false, 4);
  assert.deepEqual(full.map((entry) => entry.layer), [
    'action', 'halo', 'beam', 'particle', 'particle', 'particle', 'particle',
  ]);
  assert.deepEqual(full.filter((entry) => entry.layer === 'particle').map((entry) => entry.options.delay), [0, 18, 36, 54]);
  assert.ok(full.every((entry) => Number(entry.options.duration) > 0));
  assert.ok(full.every((entry) => typeof entry.options.easing === 'string'));

  const reduced = createIconActivationPlan(true, 4);
  assert.deepEqual(reduced.map((entry) => entry.layer), ['halo', 'beam']);
  assert.ok(reduced.every((entry) => entry.options.duration === ICON_ACTIVATION_MOTION.reduced.halo.options.duration));
  assert.throws(() => createIconActivationPlan(false, -1), RangeError);
});

test('icon renderer is isometric, pointer-tilted, and pressable without an animation loop', () => {
  const source = readFileSync(new URL('../ui/Icon.tsx', import.meta.url), 'utf8');
  assert.match(source, /marks-icon-side/);
  assert.match(source, /marks-icon-top/);
  assert.match(source, /marks-icon-face/);
  assert.match(source, /--icon-tilt-x/);
  assert.match(source, /--icon-press/);
  assert.match(source, /createIconActivationPlan\(motionIsReduced\(\), particles\.length\)/);
  assert.match(source, /:disabled, \[aria-disabled="true"\], \[data-loading="true"\]/);
  assert.match(source, /if \(!target \|\| !interactive\) return/);
  assert.match(source, /if \(!controlIsUnavailable\(control\)\) void animateActivation\(target\)/);
  assert.match(source, /import\('\.\.\/icons\/motion'\)/);
  assert.match(source, /prefers-reduced-motion: reduce/);
  assert.match(source, /root\.dataset\.motion === 'reduced'/);
  assert.match(source, /onError=\{\(\) => setFailedSheetAsset\(resolved\.name\)\}/);
  assert.doesNotMatch(source, /duration:\s*\d/);
  assert.doesNotMatch(source, /requestAnimationFrame/);
});
